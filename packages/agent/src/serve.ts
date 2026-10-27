import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { safeParseEvent, type FoxholeEvent } from "@foxhole-hq/schema";
import { eventsFile } from "./store";

/**
 * `foxhole serve`: a local-only web server for the den. It serves the den page and streams
 * events.jsonl to it as Server-Sent Events: first the recent backlog (so the page can rebuild who
 * is where), then a `ready` marker, then each new event as hooks append it.
 */
export const DEFAULT_PORT = 4317;
/** How many recent events a new viewer gets; enough to place every recent session. */
export const BACKLOG_EVENTS = 500;
const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;
const NEWLINE = 0x0a;

export interface ServeOptions {
  home: string;
  /** The den page to serve; read on every request, so edits show on reload. */
  page: string;
  /** 0 picks a free port. */
  port?: number;
  pollMs?: number;
}

export interface DenServer {
  port: number;
  close(): void;
}

/** Validated events from JSONL text. The file is external input, so anything off-schema is dropped. */
export function parseLines(text: string): FoxholeEvent[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const result = safeParseEvent(JSON.parse(line));
      return result.success ? [result.data] : [];
    } catch {
      return [];
    }
  });
}

const sizeOf = (file: string) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

function readRange(file: string, start: number, end: number): Buffer {
  const buf = Buffer.alloc(end - start);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  return buf;
}

/**
 * Follows the events file by polling its size, which works the same on every OS. Only whole lines
 * are decoded, so a line caught mid-append (or a character split across reads) waits for the rest.
 */
function followEvents(file: string, pollMs: number, onEvents: (events: FoxholeEvent[]) => void) {
  let offset = sizeOf(file);
  let pending = Buffer.alloc(0);
  const poll = () => {
    const size = sizeOf(file);
    if (size < offset) {
      // the file was truncated or replaced: start over from its beginning
      offset = 0;
      pending = Buffer.alloc(0);
    }
    if (size === offset) return;
    const chunk = Buffer.concat([pending, readRange(file, offset, size)]);
    offset = size;
    const end = chunk.lastIndexOf(NEWLINE);
    pending = chunk.subarray(end + 1);
    if (end < 0) return;
    const events = parseLines(chunk.subarray(0, end).toString("utf8"));
    if (events.length) onEvents(events);
  };
  const timer = setInterval(() => {
    try {
      poll();
    } catch (err) {
      process.stderr.write(`foxhole serve: could not read ${file}: ${(err as Error).message}\n`);
    }
  }, pollMs);
  return {
    /** Bytes already handed to onEvents (or before the start), i.e. what a new viewer's backlog covers. */
    consumed: () => offset - pending.length,
    stop: () => clearInterval(timer),
  };
}

const sse = (res: ServerResponse, data: string, name?: string) =>
  res.write(`${name ? `event: ${name}\n` : ""}data: ${data}\n\n`);

export function startServer(opts: ServeOptions): Promise<DenServer> {
  const file = eventsFile(opts.home);
  const viewers = new Set<ServerResponse>();
  const follower = followEvents(file, opts.pollMs ?? POLL_MS, (events) => {
    for (const res of viewers) for (const e of events) sse(res, JSON.stringify(e));
  });
  let port = 0;

  const openStream = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    const upTo = follower.consumed();
    const backlog = upTo ? parseLines(readRange(file, 0, upTo).toString("utf8")).slice(-BACKLOG_EVENTS) : [];
    for (const e of backlog) sse(res, JSON.stringify(e));
    sse(res, "{}", "ready");
    viewers.add(res);
    const heartbeat = setInterval(() => res.write(": still here\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      viewers.delete(res);
    });
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    // Only answer to our own address, so a web page cannot reach this server through DNS rebinding.
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowed.includes(req.headers.host ?? "")) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (req.method !== "GET") {
      res.writeHead(405).end("Method not allowed");
    } else if (url.pathname === "/events") {
      openStream(req, res);
    } else if (url.pathname === "/" && !url.searchParams.has("live")) {
      res.writeHead(302, { Location: "/?live" }).end();
    } else if (url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(readFileSync(opts.page));
    } else {
      res.writeHead(404).end("Not found");
    }
  };

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      process.stderr.write(`foxhole serve: ${req.url}: ${(err as Error).message}\n`);
      if (!res.headersSent) res.writeHead(500);
      res.end("Something went wrong; see the terminal running foxhole serve.");
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? DEFAULT_PORT, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () => {
          follower.stop();
          for (const res of viewers) res.end();
          server.close();
        },
      });
    });
  });
}

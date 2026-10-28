import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { safeParseEvent, upgradeEvent, type FoxholeEvent } from "@foxhole-hq/schema";
import { cancelTask, queueTask, readAssignments, repoPath, type Assignment } from "./assign";
import { listPrs } from "./prs";
import { eventsFile } from "./store";
import { readTasksFile, type Task } from "./tasks";

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
const MAX_BODY = 8 * 1024;
const TAIL_BYTES = 1024 * 1024;
const TOKEN_META = '<meta name="foxhole-token" content="">';
const REPO_KEY = /^(?!\.)[\w.-]+(\/(?!\.)[\w.-]+){2}$/;

export interface ServeOptions {
  home: string;
  /** The den page to serve; read on every request, so edits show on reload. */
  page: string;
  /** 0 picks a free port. */
  port?: number;
  pollMs?: number;
  /** false turns task hand-off off: the API then only reads. */
  assign?: boolean;
}

export interface DenServer {
  port: number;
  /** The per-run token the page sends with every /api request. */
  token: string;
  close(): void;
}

/** Validated events from JSONL text. The file is external input, so anything off-schema is dropped. */
export function parseLines(text: string): FoxholeEvent[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const result = safeParseEvent(upgradeEvent(JSON.parse(line)));
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

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

/** The most recent event of each session, from the tail of the log: who exists, which repo, and whether it ended. */
function latestBySession(file: string): Map<string, FoxholeEvent> {
  const size = sizeOf(file);
  const start = Math.max(0, size - TAIL_BYTES);
  const latest = new Map<string, FoxholeEvent>();
  if (!size) return latest;
  for (const e of parseLines(readRange(file, start, size).toString("utf8"))) {
    latest.set(e.sessionId, {
      ...latest.get(e.sessionId),
      ...e,
      repo: e.repo ?? latest.get(e.sessionId)?.repo,
    });
  }
  return latest;
}

export function startServer(opts: ServeOptions): Promise<DenServer> {
  const file = eventsFile(opts.home);
  const viewers = new Set<ServerResponse>();
  const follower = followEvents(file, opts.pollMs ?? POLL_MS, (events) => {
    for (const res of viewers) for (const e of events) sse(res, JSON.stringify(e));
  });
  let port = 0;
  const token = randomBytes(24).toString("hex");
  const canAssign = opts.assign !== false;
  let lastAssignments = JSON.stringify(readAssignments(opts.home));
  const assignTimer = setInterval(() => {
    const now = JSON.stringify(readAssignments(opts.home));
    if (now === lastAssignments) return;
    const before = JSON.parse(lastAssignments) as Record<string, Assignment>;
    lastAssignments = now;
    for (const a of Object.values(JSON.parse(now) as Record<string, Assignment>)) {
      if (before[a.id]?.state === a.state) continue;
      for (const res of viewers) sse(res, JSON.stringify(a), "assign");
    }
  }, opts.pollMs ?? POLL_MS);

  const openStream = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    const upTo = follower.consumed();
    const backlog = upTo ? parseLines(readRange(file, 0, upTo).toString("utf8")).slice(-BACKLOG_EVENTS) : [];
    for (const e of backlog) sse(res, JSON.stringify(e));
    for (const a of Object.values(readAssignments(opts.home))) sse(res, JSON.stringify(a), "assign");
    sse(res, "{}", "ready");
    viewers.add(res);
    const heartbeat = setInterval(() => res.write(": still here\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      viewers.delete(res);
    });
  };

  /**
   * Every /api request must come from our own page: an Origin (when sent) that is our address and the
   * per-run token. Writes must also be JSON, which a web page on another site cannot send without a
   * CORS preflight that this server never answers.
   */
  const apiAllowed = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return false;
    const sent = Buffer.from(String(req.headers["x-foxhole-token"] ?? ""));
    const want = Buffer.from(token);
    if (sent.length !== want.length || !timingSafeEqual(sent, want)) return false;
    return (
      req.method === "GET" ||
      req.method === "DELETE" ||
      /^application\/json\b/.test(req.headers["content-type"] ?? "")
    );
  };

  const tasksFor = (repo: string): { source: "tasks-md" | "none"; known: boolean; tasks: Task[] } => {
    const root = repoPath(opts.home, repo);
    const tasks = root ? readTasksFile(root) : null;
    return { source: tasks ? "tasks-md" : "none", known: Boolean(root), tasks: tasks ?? [] };
  };

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!apiAllowed(req)) return void json(res, 403, { error: "Forbidden" });
    const repo = url.searchParams.get("repo") ?? "";
    if (req.method === "GET" && url.pathname === "/api/tasks") {
      if (!REPO_KEY.test(repo)) return void json(res, 400, { error: "Unknown repo" });
      const found = tasksFor(repo);
      const assigned = Object.values(readAssignments(opts.home)).filter(
        (a) => a.repo === repo && a.state !== "cancelled",
      );
      return void json(res, 200, {
        ...found,
        tasks: found.tasks.map((t) => ({
          ...t,
          assignment: assigned.find((a) => a.taskId === t.id) ?? null,
        })),
        canAssign,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/prs") {
      if (!REPO_KEY.test(repo)) return void json(res, 400, { error: "Unknown repo" });
      return void json(res, 200, await listPrs(repo));
    }
    if (req.method === "POST" && url.pathname === "/api/assign") {
      if (!canAssign)
        return void json(res, 403, { error: "Task hand-off is off (foxhole serve --no-assign)" });
      const body = (await readBody(req)) as { repo?: string; taskId?: string; sessionId?: string };
      if (!body.repo || !REPO_KEY.test(body.repo) || !body.taskId || !body.sessionId)
        return void json(res, 400, { error: "Missing repo, taskId or sessionId" });
      const task = tasksFor(body.repo).tasks.find((t) => t.id === body.taskId);
      if (!task) return void json(res, 404, { error: "No such task" });
      const session = latestBySession(file).get(body.sessionId);
      if (!session || session.repo !== body.repo)
        return void json(res, 409, { error: "That fox is not working in this repo" });
      if (session.type === "session.end") return void json(res, 409, { error: "That session has ended" });
      // a session idle at its prompt has already passed its Stop hook: its next prompt picks the task up
      const idle = session.type === "turn.end";
      const text = task.detail ? `${task.title}\n${task.detail}` : task.title;
      const a = queueTask(opts.home, {
        repo: body.repo,
        session: body.sessionId,
        taskId: task.id,
        title: task.title,
        text,
        via: idle ? "prompt" : "stop",
      });
      return void json(res, 200, { ...a, deliverAt: idle ? "next-prompt" : "turn-end" });
    }
    const cancel = /^\/api\/assign\/(a_[0-9a-f]{12})$/.exec(url.pathname);
    if (req.method === "DELETE" && cancel) {
      return void json(res, cancelTask(opts.home, cancel[1]!) ? 200 : 409, { ok: true });
    }
    json(res, 404, { error: "Not found" });
  }

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    // Only answer to our own address, so a web page cannot reach this server through DNS rebinding.
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowed.includes(req.headers.host ?? "")) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      api(req, res, url).catch((err: Error) => {
        if (!res.headersSent) json(res, err.message === "too large" ? 413 : 400, { error: err.message });
      });
    } else if (req.method !== "GET") {
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
      res.end(
        readFileSync(opts.page, "utf8").replace(TOKEN_META, `<meta name="foxhole-token" content="${token}">`),
      );
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
        token,
        close: () => {
          follower.stop();
          clearInterval(assignTimer);
          for (const res of viewers) res.end();
          server.close();
        },
      });
    });
  });
}

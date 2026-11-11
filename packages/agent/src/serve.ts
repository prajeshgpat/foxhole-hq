import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { safeParseEvent, upgradeEvent, type FoxholeEvent } from "@foxhole-hq/schema";
import { cancelTask, queueTask, readAssignments, repoPath, type Assignment } from "./assign";
import { SCRATCH_REPO } from "./git";
import { listPrs } from "./prs";
import { applyEventsInPlace, pruneStale, snapshotOf, type SessionState } from "./state";
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
/** Largest slice of the events file read in one go, so a big log is folded in pieces. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** Ids are `<epoch>-<n>`: a per-run random token and the event's position within that run's file. */
const EPOCH_BYTES = 4;
/** More digits than this cannot be one of ours. */
const MAX_ID_DIGITS = 15;
const ID_PATTERN = new RegExp(`^([0-9a-f]{${EPOCH_BYTES * 2}})-(\\d{1,${MAX_ID_DIGITS}})$`);
const TOKEN_META = '<meta name="foxhole-token" content="">';
const REPO_KEY = /^(?!\.)[\w.-]+(\/(?!\.)[\w.-]+){2}$/;
/**
 * A den with no remote: "local/" plus a folder name with a short hash (`<folder>~<6 hex>`, or 10 hex),
 * 1 to 47 code points, no separators or control characters.
 */
// eslint-disable-next-line no-control-regex
const LOCAL_KEY = /^local\/[^\\/\u0000-\u001f\u007f-\u009f]{1,47}$/u;

/** Repo keys are only ever looked up in what the hooks recorded, never used as a path. */
const isRepoKey = (repo: string): boolean =>
  repo === SCRATCH_REPO || REPO_KEY.test(repo) || LOCAL_KEY.test(repo);

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
 * Follows the events file by polling its size, which works the same on every OS. It starts from the
 * beginning of the file so the caller can fold the whole history. Only whole lines are decoded, so a
 * line caught mid-append (or a character split across reads) waits for the rest. A file that shrinks
 * was truncated or replaced: `onReset` fires and reading starts again from the top. (A replacement that
 * is already as large as the old file by the next poll cannot be told apart from an append.)
 */
function followEvents(
  file: string,
  pollMs: number,
  handlers: { onEvents: (events: FoxholeEvent[]) => void; onReset: () => void },
) {
  let offset = 0;
  let pending = Buffer.alloc(0);
  const readSlice = (size: number) => {
    const end = Math.min(size, offset + READ_CHUNK_BYTES);
    const chunk = Buffer.concat([pending, readRange(file, offset, end)]);
    offset = end;
    const lastNewline = chunk.lastIndexOf(NEWLINE);
    pending = chunk.subarray(lastNewline + 1);
    if (lastNewline < 0) return;
    const events = parseLines(chunk.subarray(0, lastNewline).toString("utf8"));
    if (events.length) handlers.onEvents(events);
  };
  const poll = () => {
    const size = sizeOf(file);
    if (size < offset) {
      offset = 0;
      pending = Buffer.alloc(0);
      handlers.onReset();
    }
    while (offset < size) readSlice(size);
  };
  const safePoll = () => {
    try {
      poll();
    } catch (err) {
      process.stderr.write(`foxhole serve: could not read ${file}: ${(err as Error).message}\n`);
    }
  };
  safePoll();
  const timer = setInterval(safePoll, pollMs);
  return {
    /** Bytes already handed to onEvents, i.e. what a new viewer's backlog covers. */
    consumed: () => offset - pending.length,
    stop: () => clearInterval(timer),
  };
}

interface EventId {
  epoch: string;
  n: number;
}

/** The id from a Last-Event-ID header or ?since=: null when absent, "invalid" when not one of ours. */
function requestedId(req: IncomingMessage, url: URL): EventId | null | "invalid" {
  const header = req.headers["last-event-id"];
  const raw = Array.isArray(header) ? header.join(",") : (header ?? url.searchParams.get("since"));
  if (raw === undefined || raw === null) return null;
  const match = ID_PATTERN.exec(raw);
  return match ? { epoch: match[1]!, n: Number(match[2]) } : "invalid";
}

const newEpoch = (previous?: string): string => {
  const epoch = randomBytes(EPOCH_BYTES).toString("hex");
  return epoch === previous ? newEpoch(previous) : epoch;
};

const sse = (res: ServerResponse, data: string, name?: string, id?: string) =>
  res.write(`${id === undefined ? "" : `id: ${id}\n`}${name ? `event: ${name}\n` : ""}data: ${data}\n\n`);

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
  /**
   * Event ids are `<epoch>-<n>`: n is the event's zero-based position among the valid lines of the
   * current file, so ids only grow within an epoch. The epoch is random per server run and changes
   * when the file is truncated, so an id from another run or from before a truncation never matches
   * and gets a resync, never a wrong replay.
   */
  let epoch = newEpoch();
  let eventCount = 0;
  const idOf = (n: number) => `${epoch}-${n}`;
  const lastId = () => (eventCount ? idOf(eventCount - 1) : null);
  /**
   * The follower's session map is private to this server and updated in place (no per-poll copy of
   * every session); the pure `foldEvents` is unaffected. Stale sessions are pruned as events arrive
   * and on each /api/state request, so it does not grow for the life of the server.
   */
  const sessions = new Map<string, SessionState>();
  const follower = followEvents(file, opts.pollMs ?? POLL_MS, {
    onEvents: (events) => {
      const firstN = eventCount;
      applyEventsInPlace(sessions, events);
      pruneStale(sessions, new Date());
      eventCount += events.length;
      for (const res of viewers)
        events.forEach((e, i) => sse(res, JSON.stringify(e), undefined, idOf(firstN + i)));
    },
    onReset: () => {
      epoch = newEpoch(epoch);
      eventCount = 0;
      sessions.clear();
      for (const res of viewers) sse(res, "{}", "resync");
    },
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

  /** Events to replay for this request: after the given id, or the recent backlog; `resync` says the id was no use. */
  const replayFor = (
    requested: EventId | null | "invalid",
  ): { events: [string, FoxholeEvent][]; resync: boolean } => {
    const upTo = follower.consumed();
    const all = upTo ? parseLines(readRange(file, 0, upTo).toString("utf8")) : [];
    const numbered = all.map((e, i): [string, FoxholeEvent] => [idOf(i), e]);
    if (requested === null) return { events: numbered.slice(-BACKLOG_EVENTS), resync: false };
    const last = all.length - 1;
    const resumable =
      requested !== "invalid" &&
      requested.epoch === epoch &&
      requested.n <= last &&
      last - requested.n <= BACKLOG_EVENTS;
    if (!resumable) return { events: numbered.slice(-BACKLOG_EVENTS), resync: true };
    return { events: numbered.slice(requested.n + 1), resync: false };
  };

  const openStream = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    let replay;
    try {
      replay = replayFor(requestedId(req, url));
    } catch (err) {
      process.stderr.write(`foxhole serve: could not replay events: ${(err as Error).message}\n`);
      replay = { events: [], resync: true };
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    if (replay.resync) sse(res, "{}", "resync");
    for (const [id, e] of replay.events) sse(res, JSON.stringify(e), undefined, id);
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
    if (req.method === "GET" && url.pathname === "/api/state") {
      const now = new Date();
      pruneStale(sessions, now);
      return void json(res, 200, snapshotOf(sessions, now, lastId()));
    }
    const repo = url.searchParams.get("repo") ?? "";
    if (req.method === "GET" && url.pathname === "/api/tasks") {
      if (!isRepoKey(repo)) return void json(res, 400, { error: "Unknown repo" });
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
      if (!isRepoKey(repo)) return void json(res, 400, { error: "Unknown repo" });
      return void json(res, 200, await listPrs(repo));
    }
    if (req.method === "POST" && url.pathname === "/api/assign") {
      if (!canAssign)
        return void json(res, 403, { error: "Task hand-off is off (foxhole serve --no-assign)" });
      const body = (await readBody(req)) as { repo?: string; taskId?: string; sessionId?: string };
      if (!body.repo || !isRepoKey(body.repo) || !body.taskId || !body.sessionId)
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
      openStream(req, res, url);
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

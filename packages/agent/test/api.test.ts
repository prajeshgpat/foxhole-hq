import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAssignments, recordRepo } from "../src/assign";
import { startServer, type DenServer } from "../src/serve";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "foxhole-api-"));
const REPO = "github.com/acme/web";
type Json = Record<string, any> & { tasks?: Record<string, unknown>[] }; // eslint-disable-line @typescript-eslint/no-explicit-any

function call(
  den: DenServer,
  method: string,
  urlPath: string,
  opts: { token?: string | null; origin?: string; body?: unknown; type?: string } = {},
) {
  const headers: Record<string, string> = { host: `127.0.0.1:${den.port}` };
  if (opts.token !== null) headers["x-foxhole-token"] = opts.token ?? den.token;
  if (opts.origin) headers.origin = opts.origin;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (payload) headers["content-type"] = opts.type ?? "application/json";
  return new Promise<{ status: number; json: Json }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: den.port, path: urlPath, method, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : null }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

const WAIT_TIMEOUT_MS = 15_000;
const WAIT_STEP_MS = 20;

/** Polls `read` until `done` accepts its result, failing with the last value after a generous timeout. */
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > deadline)
      throw new Error(`condition not met in time; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
    value = await read();
  }
  return value;
}

const sessionEvent = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    source: "claude-code",
    machineId: "m_t",
    sessionId: "s1",
    parentSessionId: null,
    type,
    repo: REPO,
    branch: "main",
    ...extra,
  }) + "\n";

describe("den API", () => {
  let home: string;
  let den: DenServer;

  beforeEach(async () => {
    home = tmp();
    const root = tmp();
    writeFileSync(path.join(root, "TASKS.md"), "## Ready\n- [ ] Fix it <!-- id:t1 -->\n  more detail\n");
    recordRepo(home, REPO, root);
    const page = path.join(tmp(), "index.html");
    writeFileSync(page, '<meta name="foxhole-token" content="">');
    writeFileSync(
      path.join(home, "events.jsonl"),
      sessionEvent("session.start") + sessionEvent("tool.start", { tool: "Read" }),
    );
    den = await startServer({ home, page, port: 0, pollMs: 10 });
  });
  afterEach(() => den.close());

  it("puts the per-run token in the page it serves", async () => {
    const html = await new Promise<string>((resolve) =>
      http.get(
        { host: "127.0.0.1", port: den.port, path: "/?live", headers: { host: `127.0.0.1:${den.port}` } },
        (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve(b));
        },
      ),
    );
    expect(html).toContain(`content="${den.token}"`);
  });

  it("refuses a request without the token, with the wrong token, or from another origin", async () => {
    expect((await call(den, "GET", `/api/tasks?repo=${REPO}`, { token: null })).status).toBe(403);
    expect((await call(den, "GET", `/api/tasks?repo=${REPO}`, { token: "x".repeat(48) })).status).toBe(403);
    expect(
      (await call(den, "GET", `/api/tasks?repo=${REPO}`, { origin: "https://evil.example" })).status,
    ).toBe(403);
  });

  it("refuses a write that is not JSON, which a cross-site form could send", async () => {
    const res = await call(den, "POST", "/api/assign", { body: { repo: REPO }, type: "text/plain" });
    expect(res.status).toBe(403);
  });

  it("lists the repo's tasks from its TASKS.md", async () => {
    const res = await call(den, "GET", `/api/tasks?repo=${REPO}`, { origin: `http://127.0.0.1:${den.port}` });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ source: "tasks-md", known: true, canAssign: true });
    expect(res.json.tasks?.[0]).toMatchObject({ id: "t1", title: "Fix it", assignment: null });
  });

  it("is empty for a repo it has never seen, and rejects a malformed repo", async () => {
    expect((await call(den, "GET", "/api/tasks?repo=github.com/none/none")).json).toMatchObject({
      source: "none",
      known: false,
    });
    expect((await call(den, "GET", "/api/tasks?repo=../../etc")).status).toBe(400);
  });

  it("answers for the scratch den and a den with no remote instead of rejecting their keys", async () => {
    const emoji = encodeURIComponent(`local/${"🦊".repeat(10)}~a1b2c3`);
    const longest = encodeURIComponent(`local/${"é".repeat(47)}`);
    for (const repo of [
      "scratch",
      "local/my-notes",
      "local/my%20notes",
      "local/my%20notes~a1b2c3",
      "local/0123456789",
      emoji,
      longest,
    ]) {
      const tasks = await call(den, "GET", `/api/tasks?repo=${repo}`);
      expect(tasks.status).toBe(200);
      expect(tasks.json).toMatchObject({ source: "none", known: false });
      const prs = await call(den, "GET", `/api/prs?repo=${repo}`);
      expect(prs.status).toBe(200);
      expect(prs.json).toMatchObject({ available: false });
    }
  });

  it("rejects local keys that carry a path", async () => {
    const tooLong = encodeURIComponent(`local/${"🦊".repeat(48)}`);
    for (const repo of [
      tooLong,
      "local/",
      "local/a/b/c",
      "local/..%2F..%2F..",
      "scratchy",
      "local%2Fx%5Cy",
    ]) {
      expect((await call(den, "GET", `/api/tasks?repo=${repo}`)).status).toBe(400);
    }
  });

  it("queues a task for a working session and can cancel it", async () => {
    const res = await call(den, "POST", "/api/assign", {
      body: { repo: REPO, taskId: "t1", sessionId: "s1" },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ state: "queued", deliverAt: "turn-end" });
    expect(readAssignments(home)[res.json.id]!.session).toBe("s1");
    expect((await call(den, "DELETE", `/api/assign/${res.json.id}`)).status).toBe(200);
    expect(readAssignments(home)[res.json.id]!.state).toBe("cancelled");
  });

  it("says a session idle at its prompt will pick the task up next time", async () => {
    appendTurnEnd(home);
    const res = await call(den, "POST", "/api/assign", {
      body: { repo: REPO, taskId: "t1", sessionId: "s1" },
    });
    expect(res.json.deliverAt).toBe("next-prompt");
  });

  it("refuses a fox from another repo, an unknown task, an ended session and a client-supplied text", async () => {
    expect(
      (
        await call(den, "POST", "/api/assign", {
          body: { repo: "github.com/acme/other", taskId: "t1", sessionId: "s1" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(den, "POST", "/api/assign", { body: { repo: REPO, taskId: "nope", sessionId: "s1" } }))
        .status,
    ).toBe(404);
    expect(
      (await call(den, "POST", "/api/assign", { body: { repo: REPO, taskId: "t1", sessionId: "ghost" } }))
        .status,
    ).toBe(409);
    writeFileSync(path.join(home, "events.jsonl"), sessionEvent("session.end"), { flag: "a" });
    expect(
      (await call(den, "POST", "/api/assign", { body: { repo: REPO, taskId: "t1", sessionId: "s1" } }))
        .status,
    ).toBe(409);
  });

  it("turns hand-off off with assign: false", async () => {
    den.close();
    den = await startServer({ home, page: path.join(tmp(), "x.html"), port: 0, pollMs: 10, assign: false });
    const res = await call(den, "POST", "/api/assign", {
      body: { repo: REPO, taskId: "t1", sessionId: "s1" },
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/state", () => {
  let home: string;
  let den: DenServer;
  const lines = () => [sessionEvent("session.start"), sessionEvent("tool.start", { tool: "Read" })];

  beforeEach(async () => {
    home = tmp();
    const page = path.join(tmp(), "index.html");
    writeFileSync(page, '<meta name="foxhole-token" content="">');
    writeFileSync(path.join(home, "events.jsonl"), lines().join(""));
    den = await startServer({ home, page, port: 0, pollMs: 10 });
  });
  afterEach(() => den.close());

  it("refuses a missing token, a wrong token and a foreign origin", async () => {
    expect((await call(den, "GET", "/api/state", { token: null })).status).toBe(403);
    expect((await call(den, "GET", "/api/state", { token: "x".repeat(48) })).status).toBe(403);
    expect((await call(den, "GET", "/api/state", { origin: "https://evil.example" })).status).toBe(403);
  });

  const state = () => call(den, "GET", "/api/state");

  it("returns each session's state with the version of the last event", async () => {
    const res = await call(den, "GET", "/api/state");
    expect(res.status).toBe(200);
    expect(res.json.version).toMatch(/^[0-9a-f]{8}-1$/);
    expect(res.json.sessions).toHaveLength(1);
    expect(res.json.sessions[0]).toMatchObject({
      sessionId: "s1",
      status: "working",
      currentTool: "Read",
      repo: REPO,
    });
  });

  it("folds events appended while running and moves the version", async () => {
    const before = (await state()).json.version as string;
    writeFileSync(path.join(home, "events.jsonl"), sessionEvent("turn.end"), { flag: "a" });
    const res = await waitFor(state, (r) => r.json.version !== before);
    expect(res.json.version).toBe(`${before.split("-")[0]}-2`);
    expect(res.json.sessions[0]).toMatchObject({ status: "idle", currentTool: null });
  });

  it("folds history older than the 500-event backlog", async () => {
    const many = Array.from({ length: 600 }, () => sessionEvent("turn.end")).join("");
    writeFileSync(path.join(home, "events.jsonl"), many, { flag: "a" });
    const res = await waitFor(state, (r) => String(r.json.version).endsWith("-601"));
    expect(res.json.sessions[0].turnCount).toBe(600);
  });

  it("leaves out sessions that ended more than a week ago, and shows them fresh if they return", async () => {
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const recent = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const lines =
      sessionEvent("session.end", { sessionId: "old", ts: old }) +
      sessionEvent("session.end", { sessionId: "recent", ts: recent });
    writeFileSync(path.join(home, "events.jsonl"), lines, { flag: "a" });
    const res = await waitFor(state, (r) => String(r.json.version).endsWith("-3"));
    expect(res.json.sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual(["recent", "s1"]);
    writeFileSync(path.join(home, "events.jsonl"), sessionEvent("prompt.submit", { sessionId: "old" }), {
      flag: "a",
    });
    const back = await waitFor(state, (r) => String(r.json.version).endsWith("-4"));
    const returned = back.json.sessions.find((s: { sessionId: string }) => s.sessionId === "old");
    expect(returned).toMatchObject({ status: "working", turnCount: 0, toolCallCount: 0 });
  });

  it("keeps a session that has waited on a permission for a day", async () => {
    const ts = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    writeFileSync(
      path.join(home, "events.jsonl"),
      sessionEvent("permission.request", { sessionId: "waiting", ts }),
      { flag: "a" },
    );
    const res = await waitFor(state, (r) => String(r.json.version).endsWith("-2"));
    const waiting = res.json.sessions.find((s: { sessionId: string }) => s.sessionId === "waiting");
    expect(waiting).toMatchObject({ status: "needs-you", pendingPermission: true });
    expect(res.json.sessions[0].sessionId).toBe("waiting");
  });
});

function appendTurnEnd(home: string) {
  writeFileSync(path.join(home, "events.jsonl"), sessionEvent("turn.end"), { flag: "a" });
}

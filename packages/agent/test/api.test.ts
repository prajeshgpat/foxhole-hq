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

function appendTurnEnd(home: string) {
  writeFileSync(path.join(home, "events.jsonl"), sessionEvent("turn.end"), { flag: "a" });
}

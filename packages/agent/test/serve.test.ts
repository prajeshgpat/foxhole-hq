import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { FoxholeEvent } from "@foxhole-hq/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseLines, startServer, type DenServer } from "../src/serve";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "foxhole-serve-"));

let n = 0;
function event(type: FoxholeEvent["type"], extra: Partial<FoxholeEvent> = {}): FoxholeEvent {
  n++;
  return {
    v: 1,
    id: `6f1c2b9e-3f4a-4b7c-9d2e-${String(n).padStart(12, "0")}`,
    ts: "2026-10-26T19:04:11.512Z",
    source: "claude-code",
    machineId: "m_test",
    sessionId: "s1",
    parentSessionId: null,
    type,
    ...extra,
  };
}
const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e) + "\n").join("");

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
function get(port: number, urlPath: string, host = `127.0.0.1:${port}`): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
  });
}

/** Opens the event stream and collects each `data:` message, resolving once `until` returns true. */
function stream(port: number, until: (messages: string[]) => boolean): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const req = http.get({ host: "127.0.0.1", port, path: "/events" }, (res) => {
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          const name = block.split("\n").find((l) => l.startsWith("event: "));
          messages.push(name ? name.slice(7) : (data?.slice(6) ?? ""));
        }
        if (until(messages)) {
          req.destroy();
          resolve(messages);
        }
      });
    });
    req.on("error", (e) => (e.message === "socket hang up" ? undefined : reject(e)));
  });
}

describe("parseLines", () => {
  it("keeps valid events and drops blank, broken or off-schema lines", () => {
    const good = event("session.start");
    const text = [JSON.stringify(good), "", "{not json", JSON.stringify({ ...good, prompt: "secret" })].join("\n");
    expect(parseLines(text)).toEqual([good]);
  });
});

describe("startServer", () => {
  let home: string;
  let page: string;
  let den: DenServer;

  beforeEach(async () => {
    home = tmp();
    page = path.join(tmp(), "index.html");
    writeFileSync(page, "<!doctype html><title>den</title>");
    den = await startServer({ home, page, port: 0, pollMs: 10 });
  });
  afterEach(() => den.close());

  it("sends the bare address to live mode", async () => {
    const res = await get(den.port, "/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?live");
  });

  it("serves the den page in live mode", async () => {
    const res = await get(den.port, "/?live");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<title>den</title>");
  });

  it("refuses requests addressed to another host name", async () => {
    expect((await get(den.port, "/?live", "evil.example:80")).status).toBe(403);
  });

  it("answers unknown paths with 404", async () => {
    expect((await get(den.port, "/nope")).status).toBe(404);
  });

  it("replays recorded events, then signals ready", async () => {
    den.close();
    writeFileSync(path.join(home, "events.jsonl"), jsonl(event("session.start"), "garbage", event("tool.start")));
    den = await startServer({ home, page, port: 0, pollMs: 10 });
    const messages = await stream(den.port, (m) => m.includes("ready"));
    expect(messages.map((m) => (m === "ready" ? m : JSON.parse(m).type))).toEqual([
      "session.start",
      "tool.start",
      "ready",
    ]);
  });

  it("streams events appended after the viewer connected", async () => {
    const appended = event("permission.request", { status: "waiting" });
    const messages = await stream(den.port, (m) => {
      if (m.length === 1) appendFileSync(path.join(home, "events.jsonl"), jsonl(appended));
      return m.length === 2;
    });
    expect(messages[0]).toBe("ready");
    expect(JSON.parse(messages[1] ?? "")).toEqual(appended);
  });
});

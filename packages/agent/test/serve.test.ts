import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { FoxholeEvent } from "@foxhole-hq/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKLOG_EVENTS, parseLines, startServer, type DenServer } from "../src/serve";

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
const epochOf = (id: string) => id.split("-")[0]!;
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
function stream(
  port: number,
  until: (messages: string[]) => boolean,
  opts: { path?: string; headers?: Record<string, string>; ids?: string[] } = {},
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const req = http.get(
      { host: "127.0.0.1", port, path: opts.path ?? "/events", headers: opts.headers },
      (res) => {
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk;
          const blocks = buf.split("\n\n");
          buf = blocks.pop() ?? "";
          for (const block of blocks) {
            const data = block.split("\n").find((l) => l.startsWith("data: "));
            const name = block.split("\n").find((l) => l.startsWith("event: "));
            const id = block.split("\n").find((l) => l.startsWith("id: "));
            if (id) opts.ids?.push(id.slice(4));
            messages.push(name ? name.slice(7) : (data?.slice(6) ?? ""));
          }
          if (until(messages)) {
            req.destroy();
            resolve(messages);
          }
        });
      },
    );
    req.on("error", (e) => (e.message === "socket hang up" ? undefined : reject(e)));
  });
}

describe("parseLines", () => {
  it("reads events logged under the old session.stop name as turn.end", () => {
    const old = { ...event("turn.end"), type: "session.stop" };
    expect(parseLines(JSON.stringify(old)).map((e) => e.type)).toEqual(["turn.end"]);
  });

  it("keeps valid events and drops blank, broken or off-schema lines", () => {
    const good = event("session.start");
    const text = [JSON.stringify(good), "", "{not json", JSON.stringify({ ...good, prompt: "secret" })].join(
      "\n",
    );
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
    writeFileSync(
      path.join(home, "events.jsonl"),
      jsonl(event("session.start"), "garbage", event("tool.start")),
    );
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

describe("event ids and resume", () => {
  let home: string;
  let page: string;
  let den: DenServer;
  const eventsPath = () => path.join(home, "events.jsonl");
  const kinds = (m: string[]) =>
    m.map((x) => (x === "ready" || x === "resync" || x === "assign" ? x : JSON.parse(x).type));

  beforeEach(async () => {
    home = tmp();
    page = path.join(tmp(), "index.html");
    writeFileSync(page, "<!doctype html><title>den</title>");
    writeFileSync(
      eventsPath(),
      jsonl(
        event("session.start"),
        "garbage",
        event("prompt.submit"),
        event("tool.start"),
        event("turn.end"),
      ),
    );
    den = await startServer({ home, page, port: 0, pollMs: 10 });
  });
  afterEach(() => den.close());

  const ready = (m: string[]) => m.includes("ready");
  /** The current run's epoch, learned from a fresh connection. */
  const currentEpoch = async () => {
    const ids: string[] = [];
    await stream(den.port, ready, { ids });
    return epochOf(ids[0]!);
  };

  it("gives each replayed event an increasing id counted over valid lines", async () => {
    const ids: string[] = [];
    await stream(den.port, ready, { ids });
    const epoch = epochOf(ids[0]!);
    expect(epoch).toMatch(/^[0-9a-f]{8}$/);
    expect(ids).toEqual([0, 1, 2, 3].map((i) => `${epoch}-${i}`));
  });

  it("gives live events the next ids", async () => {
    const ids: string[] = [];
    await stream(
      den.port,
      (m) => {
        if (m.length === 5 && m.at(-1) === "ready") appendFileSync(eventsPath(), jsonl(event("tool.start")));
        return ids.length === 5;
      },
      { ids },
    );
    expect(ids.at(-1)).toBe(`${epochOf(ids[0]!)}-4`);
  });

  it("resumes after the Last-Event-ID header, sending only later events then ready", async () => {
    const m = await stream(den.port, ready, { headers: { "Last-Event-ID": `${await currentEpoch()}-1` } });
    expect(kinds(m)).toEqual(["tool.start", "turn.end", "ready"]);
  });

  it("resumes after ?since=, sending only later events then ready", async () => {
    const m = await stream(den.port, ready, { path: `/events?since=${await currentEpoch()}-2` });
    expect(kinds(m)).toEqual(["turn.end", "ready"]);
  });

  it("prefers the header over ?since= because reconnects keep the old URL", async () => {
    const epoch = await currentEpoch();
    const m = await stream(den.port, ready, {
      path: `/events?since=${epoch}-0`,
      headers: { "Last-Event-ID": `${epoch}-3` },
    });
    expect(kinds(m)).toEqual(["ready"]);
  });

  it.each([
    "abc",
    "-1",
    "1.5",
    "",
    "2",
    "9".repeat(40),
    "deadbeef-2",
    "DEADBEEF-2",
    "deadbeef-",
    "deadbeef-1.5",
    "deadbeef-2-3",
    "deadbeef0-2",
    `deadbeef-${"9".repeat(40)}`,
    "CURRENT-4",
    "CURRENT-99",
  ])("sends resync then the backlog for the id %j", async (id) => {
    {
      const epoch = await currentEpoch();
      const m = await stream(den.port, ready, { headers: { "Last-Event-ID": id.replace("CURRENT", epoch) } });
      expect(kinds(m)).toEqual([
        "resync",
        "session.start",
        "prompt.submit",
        "tool.start",
        "turn.end",
        "ready",
      ]);
    }
  });

  it("sends resync for a garbage ?since=", async () => {
    const m = await stream(den.port, ready, { path: "/events?since=%00x" });
    expect(kinds(m)[0]).toBe("resync");
  });

  it("with no id replays the backlog and ready, with no resync", async () => {
    const m = await stream(den.port, ready);
    expect(kinds(m)).toEqual(["session.start", "prompt.submit", "tool.start", "turn.end", "ready"]);
  });

  it("changes epoch when the file is truncated, restarts n, and answers the old epoch with resync", async () => {
    const ids: string[] = [];
    const m = await stream(
      den.port,
      (msgs) => {
        if (msgs.at(-1) === "ready" && msgs.length === 5)
          writeFileSync(eventsPath(), jsonl(event("session.start")));
        return msgs.length >= 7;
      },
      { ids },
    );
    expect(m.slice(5).includes("resync")).toBe(true);
    const oldEpoch = epochOf(ids[0]!);
    expect(ids.at(-1)).toMatch(/^[0-9a-f]{8}-0$/);
    expect(epochOf(ids.at(-1)!)).not.toBe(oldEpoch);
    const stale = await stream(den.port, ready, { headers: { "Last-Event-ID": `${oldEpoch}-2` } });
    expect(kinds(stale)[0]).toBe("resync");
  });

  it("answers an id from another server run with resync", async () => {
    const other = await startServer({ home, page, port: 0, pollMs: 10 });
    try {
      const ids: string[] = [];
      await stream(other.port, ready, { ids });
      const m = await stream(den.port, ready, { headers: { "Last-Event-ID": ids[1]! } });
      expect(kinds(m)[0]).toBe("resync");
    } finally {
      other.close();
    }
  });
});

describe("resume cap", () => {
  const TOTAL = 601;
  const last = TOTAL - 1;
  let home: string;
  let den: DenServer;
  const ready = (m: string[]) => m.includes("ready");

  beforeEach(async () => {
    home = tmp();
    const page = path.join(tmp(), "index.html");
    writeFileSync(page, "<!doctype html><title>den</title>");
    writeFileSync(
      path.join(home, "events.jsonl"),
      jsonl(...Array.from({ length: TOTAL }, () => event("turn.end"))),
    );
    den = await startServer({ home, page, port: 0, pollMs: 10 });
  });
  afterEach(() => den.close());

  const from = async (behind: number) => {
    const ids: string[] = [];
    await stream(den.port, ready, { ids });
    const since = `${epochOf(ids[0]!)}-${last - behind}`;
    const seen: string[] = [];
    const m = await stream(den.port, ready, { path: `/events?since=${since}`, ids: seen });
    return { resync: m.includes("resync"), count: seen.length, firstId: seen[0] };
  };

  it("resumes exactly at the backlog cap without a resync", async () => {
    const r = await from(BACKLOG_EVENTS);
    expect(r).toMatchObject({ resync: false, count: BACKLOG_EVENTS });
    expect(r.firstId).toMatch(new RegExp(`-${last - BACKLOG_EVENTS + 1}$`));
  });

  it("sends resync and the last backlog when one event past the cap", async () => {
    const r = await from(BACKLOG_EVENTS + 1);
    expect(r).toMatchObject({ resync: true, count: BACKLOG_EVENTS });
    expect(r.firstId).toMatch(new RegExp(`-${TOTAL - BACKLOG_EVENTS}$`));
  });

  it("sends resync and only the last backlog for ?since=<epoch>-0 far past the cap", async () => {
    const r = await from(last);
    expect(r).toMatchObject({ resync: true, count: BACKLOG_EVENTS });
  });
});

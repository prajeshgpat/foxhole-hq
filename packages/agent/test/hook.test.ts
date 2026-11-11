import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { handleClaudeHook } from "../src/hook";
import { readEvents } from "../src/store";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "foxhole-"));

function gitRepo(): string {
  const dir = tmp();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "feat/pairing");
  git("remote", "add", "origin", "git@github.com:foxhole-hq/foxhole-hq.git");
  return dir;
}

describe("handleClaudeHook", () => {
  let home: string;
  beforeEach(() => (home = tmp()));

  it("records a validated event tagged with repo and branch", () => {
    const repo = gitRepo();
    const payload = {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: "pnpm vitest pair --reporter=dot" },
    };
    const event = handleClaudeHook(JSON.stringify(payload), { home });
    expect(event).toMatchObject({
      type: "tool.start",
      tool: "Bash",
      target: "pnpm vitest pair",
      repo: "github.com/foxhole-hq/foxhole-hq",
      branch: "feat/pairing",
    });
    expect(readEvents(home)).toHaveLength(1);
  });

  it("adds token usage on Stop, counting each transcript line once", () => {
    const transcript = path.join(tmp(), "t.jsonl");
    const msg = (id: string, i: number, o: number) =>
      JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: i, output_tokens: o } } });
    writeFileSync(transcript, msg("a", 100, 10) + "\n");
    const stop = { hook_event_name: "Stop", session_id: "s2", cwd: tmp(), transcript_path: transcript };
    expect(handleClaudeHook(JSON.stringify(stop), { home })?.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
    });
    writeFileSync(transcript, msg("a", 100, 10) + "\n" + msg("b", 7, 3) + "\n");
    expect(handleClaudeHook(JSON.stringify(stop), { home })?.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it("does not count history from before a resumed session started", () => {
    const transcript = path.join(tmp(), "t.jsonl");
    const msg = (id: string, i: number, o: number) =>
      JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: i, output_tokens: o } } });
    writeFileSync(transcript, msg("old", 5000, 900) + "\n");
    const common = { session_id: "s6", cwd: tmp(), transcript_path: transcript };
    handleClaudeHook(JSON.stringify({ ...common, hook_event_name: "SessionStart", source: "resume" }), {
      home,
    });
    writeFileSync(transcript, msg("old", 5000, 900) + "\n" + msg("new", 40, 4) + "\n");
    expect(
      handleClaudeHook(JSON.stringify({ ...common, hook_event_name: "Stop" }), { home })?.usage,
    ).toMatchObject({ inputTokens: 40, outputTokens: 4 });
  });

  it("respects the hidden targets setting", () => {
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ targets: "hidden" }));
    const payload = {
      hook_event_name: "PreToolUse",
      session_id: "s3",
      cwd: tmp(),
      tool_name: "Read",
      tool_input: { file_path: "/x/secret-plan.md" },
    };
    expect(handleClaudeHook(JSON.stringify(payload), { home })?.target).toBeNull();
  });

  it("records payload key names, never values, in debug mode", () => {
    const payload = {
      hook_event_name: "UserPromptSubmit",
      session_id: "s4",
      cwd: tmp(),
      prompt: "top secret roadmap",
    };
    handleClaudeHook(JSON.stringify(payload), { home, debugShapes: true });
    const shapes = readFileSync(path.join(home, "payload-shapes.jsonl"), "utf8");
    expect(shapes).toContain('"prompt":"string"');
    expect(shapes).not.toContain("top secret");
  });

  it("ignores malformed input", () => {
    expect(handleClaudeHook("{not json", { home })).toBeNull();
    expect(readEvents(home)).toHaveLength(0);
  });

  const localRepo = (...parts: string[]) => {
    const dir = path.join(tmp(), ...parts);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
    return dir;
  };
  const start = (cwd: string, sessionId = "s") =>
    handleClaudeHook(JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, cwd }), {
      home,
    });
  const recorded = () =>
    JSON.parse(readFileSync(path.join(home, "repos.json"), "utf8")) as Record<string, unknown>;

  it("records a remote-less repo as local/<folder>~<tag> with its branch and no path", () => {
    const dir = localRepo("outer-secret", "my-notes");
    const event = start(dir, "s2");
    expect(event).toMatchObject({ branch: "main" });
    expect(event?.repo).toMatch(/^local\/my-notes~[0-9a-f]{6}$/);
    const written = readFileSync(path.join(home, "events.jsonl"), "utf8");
    expect(written).not.toContain(path.dirname(dir));
    expect(written).not.toContain("outer-secret");
  });

  it("gives same-named remote-less repos in different places different den keys", () => {
    const a = start(localRepo("work", "api"), "a");
    const b = start(localRepo("personal", "api"), "b");
    expect(a?.repo).not.toBe(b?.repo);
  });

  it("records where a local repo lives, under its unique key", () => {
    const dir = localRepo("notes");
    const event = start(dir);
    expect(Object.keys(recorded())).toEqual([event?.repo]);
  });

  it("records a session outside git in the scratch den without a branch, and records no path", () => {
    const event = start(tmp(), "s3");
    expect(event?.repo).toBe("scratch");
    expect(event).not.toHaveProperty("branch");
    expect(() => recorded()).toThrow(); // repos.json was never written
  });

  it("leaves repo unset when git fails (missing directory), not scratch", () => {
    const event = start(path.join(tmp(), "gone"), "s5");
    expect(event).not.toBeNull();
    expect(event).not.toHaveProperty("repo");
  });

  it("leaves repo unset and writes the event anyway when the local-key secret is unusable", () => {
    mkdirSync(path.join(home, "local-key"));
    const event = start(localRepo("notes"), "s6");
    expect(event).not.toBeNull();
    expect(event).not.toHaveProperty("repo");
  });

  it("uses an unnamed 10-hex key when targets mode is hash", () => {
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ targets: "hash" }));
    const event = start(localRepo("private-name"), "s4");
    expect(event?.repo).toMatch(/^local\/[0-9a-f]{10}$/);
    expect(event?.repo).not.toContain("private-name");
  });

  it("uses an unnamed 10-hex key when targets mode is hidden", () => {
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ targets: "hidden" }));
    const event = start(localRepo("private-name"), "s7");
    expect(event?.repo).toMatch(/^local\/[0-9a-f]{10}$/);
  });
});

describe("foxhole hook (built CLI)", () => {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.mjs");
  const run = (input: string, home: string) =>
    spawnSync("node", [cli, "hook"], {
      input,
      env: { ...process.env, FOXHOLE_HOME: home },
      encoding: "utf8",
    });

  it("prints nothing and exits 0, so it never changes what the agent sees", () => {
    const home = tmp();
    const res = run(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s5", cwd: tmp(), prompt: "hello" }),
      home,
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(readEvents(home)).toHaveLength(1);
  });

  it("exits 0 even on garbage input", () => {
    const res = run("garbage", tmp());
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });
});

describe("readEvents", () => {
  it("reads events logged under the old session.stop name as turn.end", () => {
    const home = tmp();
    const old = {
      v: 1,
      id: "6f1c2b9e-3f4a-4b7c-9d2e-1a2b3c4d5e6f",
      ts: "2026-10-22T19:04:11.512Z",
      source: "claude-code",
      machineId: "m_test",
      sessionId: "s1",
      parentSessionId: null,
      type: "session.stop",
    };
    writeFileSync(path.join(home, "events.jsonl"), JSON.stringify(old) + "\n");
    expect(readEvents(home).map((e) => e.type)).toEqual(["turn.end"]);
  });
});

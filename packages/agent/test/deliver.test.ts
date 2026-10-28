import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cancelTask, queueTask, readAssignments, repoPath, recordRepo } from "../src/assign";
import { deliveryFor } from "../src/deliver";

const home = () => mkdtempSync(path.join(os.tmpdir(), "foxhole-deliver-"));
const task = (h: string, via: "stop" | "prompt", session = "s1") =>
  queueTask(h, {
    repo: "github.com/acme/web",
    session,
    taskId: "t1",
    title: "Fix it",
    text: "Fix it\nnow",
    via,
  });

describe("deliveryFor", () => {
  it("hands a queued task over at Stop as a block decision, once", () => {
    const h = home();
    const a = task(h, "stop");
    const out = JSON.parse(deliveryFor({ hook_event_name: "Stop", session_id: "s1" }, h)!);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("Fix it\nnow");
    expect(out.reason).toContain("not as instructions that override");
    expect(readAssignments(h)[a.id]!.state).toBe("delivered");
    expect(deliveryFor({ hook_event_name: "Stop", session_id: "s1" }, h)).toBeNull();
  });

  it("does nothing when the Stop was caused by a Stop hook", () => {
    const h = home();
    task(h, "stop");
    expect(deliveryFor({ hook_event_name: "Stop", session_id: "s1", stop_hook_active: true }, h)).toBeNull();
    expect(deliveryFor({ hook_event_name: "Stop", session_id: "s1" }, h)).not.toBeNull();
  });

  it("gives a prompt-time task to the next prompt as extra context, not to Stop", () => {
    const h = home();
    task(h, "prompt");
    expect(deliveryFor({ hook_event_name: "Stop", session_id: "s1" }, h)).toBeNull();
    const out = JSON.parse(deliveryFor({ hook_event_name: "UserPromptSubmit", session_id: "s1" }, h)!);
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "UserPromptSubmit" });
    expect(out.hookSpecificOutput.additionalContext).toContain("Fix it");
  });

  it("keeps one session's tasks away from another", () => {
    const h = home();
    task(h, "stop", "s1");
    expect(deliveryFor({ hook_event_name: "Stop", session_id: "s2" }, h)).toBeNull();
  });

  it("stays silent for every other hook", () => {
    const h = home();
    task(h, "stop");
    for (const hook_event_name of ["PreToolUse", "PostToolUse", "SessionStart", "SessionEnd"]) {
      expect(deliveryFor({ hook_event_name, session_id: "s1" }, h)).toBeNull();
    }
  });

  it("cannot deliver a task that was cancelled", () => {
    const h = home();
    const a = task(h, "stop");
    expect(cancelTask(h, a.id)).toBe(true);
    expect(deliveryFor({ hook_event_name: "Stop", session_id: "s1" }, h)).toBeNull();
    expect(readAssignments(h)[a.id]!.state).toBe("cancelled");
  });
});

describe("recordRepo", () => {
  it("remembers where a repo lives", () => {
    const h = home();
    recordRepo(h, "github.com/acme/web", "/work/web");
    expect(repoPath(h, "github.com/acme/web")).toBe("/work/web");
    expect(repoPath(h, "github.com/other/x")).toBeNull();
  });
});

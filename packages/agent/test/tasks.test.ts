import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseTasks, readTasksFile } from "../src/tasks";

const MD = `# Tasks

## Ready
- [ ] Fix session expiry <!-- id:t-auth-1 --> #bug ~S
      Tokens expire early when the clock drifts.
      Add leeway and a test.
- [ ] Add CSP headers #security ~M

## In progress
- [ ] Dead-letter queue <!-- id:t-dlq -->

## Done
- [x] Upgrade jose
`;

describe("parseTasks", () => {
  const tasks = parseTasks(MD);

  it("reads items with ids, labels, sizes and detail", () => {
    expect(tasks[0]).toMatchObject({
      id: "t-auth-1",
      title: "Fix session expiry",
      labels: ["bug"],
      size: "S",
      status: "open",
      detail: "Tokens expire early when the clock drifts.\nAdd leeway and a test.",
    });
  });

  it("gives a stable id from the title when none is written", () => {
    const again = parseTasks(MD);
    expect(tasks[1]!.id).toMatch(/^t-[0-9a-f]{8}$/);
    expect(again[1]!.id).toBe(tasks[1]!.id);
  });

  it("takes the status from the heading, and a ticked box is always done", () => {
    expect(tasks.map((t) => t.status)).toEqual(["open", "open", "doing", "done"]);
  });

  it("ignores everything that is not a task item and strips control characters", () => {
    const out = parseTasks("Some prose\n- plain bullet\n- [ ] Clean\u0007 title\n");
    expect(out.map((t) => t.title)).toEqual(["Clean title"]);
  });

  it("caps the detail", () => {
    const out = parseTasks("- [ ] Big\n  " + "x".repeat(5000));
    expect(out[0]!.detail!.length).toBe(1024);
  });
});

describe("readTasksFile", () => {
  const repo = () => mkdtempSync(path.join(os.tmpdir(), "foxhole-tasks-"));

  it("reads TASKS.md from the repo root", () => {
    const root = repo();
    writeFileSync(path.join(root, "TASKS.md"), MD);
    expect(readTasksFile(root)?.length).toBe(4);
  });

  it("is null when there is no file", () => {
    expect(readTasksFile(repo())).toBeNull();
  });

  it("refuses a symlink that leaves the repo", () => {
    const root = repo();
    const outside = path.join(repo(), "secret.md");
    writeFileSync(outside, MD);
    mkdirSync(root, { recursive: true });
    symlinkSync(outside, path.join(root, "TASKS.md"));
    expect(readTasksFile(root)).toBeNull();
  });
});

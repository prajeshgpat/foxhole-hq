import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyCursor, readNewUsage, sumUsage } from "../src/usage";

const assistant = (id: string, input: number, output: number, extra: object = {}) =>
  JSON.stringify({
    type: "assistant",
    message: {
      id,
      model: "claude-sonnet-x",
      usage: { input_tokens: input, output_tokens: output, ...extra },
    },
  });

describe("sumUsage", () => {
  it("sums assistant usage and counts a split message once", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      assistant("msg_1", 100, 20, { cache_read_input_tokens: 50 }),
      assistant("msg_1", 100, 20, { cache_read_input_tokens: 50 }),
      assistant("msg_2", 10, 5, { cache_creation_input_tokens: 7 }),
      "not json",
    ];
    expect(sumUsage(lines, new Set())).toEqual({
      inputTokens: 110,
      outputTokens: 25,
      cacheReadTokens: 50,
      cacheWriteTokens: 7,
      model: "claude-sonnet-x",
    });
  });
  it("returns null when there is no usage", () => {
    expect(sumUsage([JSON.stringify({ type: "user" })], new Set())).toBeNull();
  });
});

describe("readNewUsage", () => {
  it("only counts complete lines and resumes from the cursor", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "fx-")), "t.jsonl");
    writeFileSync(file, assistant("a", 10, 1) + "\n" + assistant("b", 20, 2).slice(0, 15));
    const first = readNewUsage(file, emptyCursor());
    expect(first.usage).toMatchObject({ inputTokens: 10, outputTokens: 1 });

    writeFileSync(file, assistant("a", 10, 1) + "\n" + assistant("b", 20, 2) + "\n");
    const second = readNewUsage(file, first.cursor);
    expect(second.usage).toMatchObject({ inputTokens: 20, outputTokens: 2 });

    appendFileSync(file, assistant("b", 20, 2) + "\n");
    expect(readNewUsage(file, second.cursor).usage).toBeNull();
  });
  it("survives a missing transcript", () => {
    const res = readNewUsage("/nope/missing.jsonl", emptyCursor());
    expect(res.usage).toBeNull();
    expect(res.cursor).toEqual(emptyCursor());
  });
});

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { Usage } from "@foxhole-hq/schema";

/**
 * Claude Code writes each session's transcript as JSONL. Assistant entries carry the API usage for
 * that turn. One API message can be split across several entries (one per content block) that
 * repeat the same usage, so entries are de-duplicated by message id.
 */
export interface UsageCursor {
  /** Byte offset of the first line not yet counted. */
  offset: number;
  /** Message ids already counted, kept so a message split across a read boundary is not counted twice. */
  seen: string[];
}

export const emptyCursor = (): UsageCursor => ({ offset: 0, seen: [] });

interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** Sum usage over complete JSONL lines. Pure, so it is easy to test. */
export function sumUsage(lines: string[], seen: Set<string>): Usage | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let model: string | undefined;
  let any = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { id?: string; model?: string; usage?: TranscriptUsage } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = entry.message;
    if (entry.type !== "assistant" || !msg?.usage) continue;
    if (msg.id) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
    }
    any = true;
    input += n(msg.usage.input_tokens);
    output += n(msg.usage.output_tokens);
    cacheRead += n(msg.usage.cache_read_input_tokens);
    cacheWrite += n(msg.usage.cache_creation_input_tokens);
    if (typeof msg.model === "string" && msg.model && !msg.model.startsWith("<")) model = msg.model;
  }
  if (!any) return null;
  const usage: Usage = { inputTokens: input, outputTokens: output };
  if (cacheRead) usage.cacheReadTokens = cacheRead;
  if (cacheWrite) usage.cacheWriteTokens = cacheWrite;
  if (model) usage.model = model;
  return usage;
}

/**
 * Read the transcript from the cursor to the last complete line and sum the new usage.
 * Returns the advanced cursor. Never throws: a missing or unreadable transcript just yields no usage.
 */
export function readNewUsage(
  transcriptPath: string,
  cursor: UsageCursor,
): { usage: Usage | null; cursor: UsageCursor } {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const start = size < cursor.offset ? 0 : cursor.offset; // the file was replaced or truncated
    if (size === start) return { usage: null, cursor };
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < 0) return { usage: null, cursor };
    const text = buf.subarray(0, lastNewline).toString("utf8");
    const seen = new Set(cursor.seen);
    const usage = sumUsage(text.split("\n"), seen);
    return { usage, cursor: { offset: start + lastNewline + 1, seen: [...seen].slice(-50) } };
  } catch {
    return { usage: null, cursor };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Current transcript length in bytes, or 0 if it does not exist yet. */
export function transcriptSize(transcriptPath: string): number {
  try {
    return statSync(transcriptPath).size;
  } catch {
    return 0;
  }
}

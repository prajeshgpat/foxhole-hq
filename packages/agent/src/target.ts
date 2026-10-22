import { createHash } from "node:crypto";
import path from "node:path";
import { MAX_TARGET_LENGTH } from "@foxhole-hq/schema";

/**
 * How much of a tool call's target leaves the machine.
 * - short: a relative file path, a command name, a hostname (the default)
 * - hash:  a stable 10-character hash of the short label, so repeats are still recognisable
 * - hidden: nothing
 */
export type TargetMode = "short" | "hash" | "hidden";

type ToolInput = Record<string, unknown> | undefined;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function clip(label: string): string {
  return label.length > MAX_TARGET_LENGTH ? label.slice(0, MAX_TARGET_LENGTH - 1) + "…" : label;
}

/** A path inside the project becomes relative to it; anything outside becomes just its file name. */
export function shortPath(filePath: string, cwd: string): string {
  const rel = path.relative(cwd, filePath);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  return path.basename(filePath);
}

const WORD = /^[A-Za-z0-9_.:/][A-Za-z0-9_.:/-]*$/;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
// URLs and user@host strings can embed credentials, so they end the label like a flag does.
const LOOKS_LIKE_URL = /:\/\//;

/**
 * Keep the command and up to two plain sub-words ("pnpm test auth", "npm run migrate").
 * Stop at the first flag, quote, redirect or other punctuation, and drop leading VAR=value
 * assignments, so arguments that might carry secrets never make it into the label.
 */
export function shortCommand(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  while (tokens.length && ENV_ASSIGN.test(tokens[0]!)) tokens.shift();
  const kept: string[] = [];
  for (const t of tokens) {
    if (kept.length === 3 || !WORD.test(t) || LOOKS_LIKE_URL.test(t)) break;
    kept.push(t);
  }
  if (!kept.length) return null;
  kept[0] = path.basename(kept[0]!);
  return kept.join(" ");
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** The short label for a tool call, before the target mode is applied. */
export function shortTarget(tool: string, input: ToolInput, cwd: string): string | null {
  const file = str(input?.file_path) ?? str(input?.notebook_path);
  switch (tool) {
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return file ? shortPath(file, cwd) : null;
    case "Glob":
      return str(input?.pattern) ?? null;
    case "Grep": {
      // The search pattern itself can quote code, so only the place being searched is kept.
      const where = str(input?.path);
      return where ? shortPath(where, cwd) : null;
    }
    case "Bash": {
      const cmd = str(input?.command);
      return cmd ? shortCommand(cmd) : null;
    }
    case "WebFetch": {
      const url = str(input?.url);
      return url ? hostname(url) : null;
    }
    case "Task":
    case "Agent":
      return str(input?.subagent_type) ?? null;
    default:
      // WebSearch queries, todo lists and unknown tools describe intent, not a place, so they stay home.
      return null;
  }
}

export function applyMode(label: string | null, mode: TargetMode): string | null {
  if (label == null || mode === "hidden") return null;
  if (mode === "hash") return "h:" + createHash("sha256").update(label).digest("hex").slice(0, 10);
  return clip(label);
}

export function targetFor(tool: string, input: ToolInput, cwd: string, mode: TargetMode): string | null {
  return applyMode(shortTarget(tool, input, cwd), mode);
}

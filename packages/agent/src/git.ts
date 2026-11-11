import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import path from "node:path";
import { localKeySecret } from "./store";
import type { TargetMode } from "./target";

/**
 * Normalize a git remote URL to "host/owner/name", the key that picks a den.
 * Handles https, ssh ("git@host:owner/name.git") and ssh:// forms, and drops credentials and ".git".
 */
export function normalizeRemote(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(trimmed);
  let host: string;
  let pathname: string;
  if (scp) {
    host = scp[1]!;
    pathname = scp[2]!;
  } else {
    try {
      const u = new URL(trimmed);
      host = u.hostname;
      pathname = u.pathname;
    } catch {
      return null;
    }
  }
  const clean = pathname
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (!host || !clean) return null;
  return `${host.toLowerCase()}/${clean}`;
}

const GIT_TIMEOUT_MS = 800;
const GIT_NOT_A_REPO_STATUS = 128;
const NOT_A_REPO_MESSAGE = /not a git repository/i;

/** What a git call told us. "not-repo" is git's definitive answer; "failed" covers missing git, timeouts and other errors. */
export type GitResult = { kind: "ok"; out: string } | { kind: "not-repo" } | { kind: "failed" };
export type GitRunner = (cwd: string, args: string[]) => GitResult;

function classifyFailure(err: unknown): GitResult {
  const e = err as { status?: unknown; stderr?: unknown };
  const stderr =
    typeof e.stderr === "string" ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : "";
  if (e.status === GIT_NOT_A_REPO_STATUS && NOT_A_REPO_MESSAGE.test(stderr)) return { kind: "not-repo" };
  return { kind: "failed" };
}

/** Run git and keep "not a repository" apart from every other failure. Never throws. */
export const runGit: GitRunner = (cwd, args) => {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { kind: "ok", out };
  } catch (err) {
    return classifyFailure(err);
  }
};

const okOutput = (r: GitResult): string | null => (r.kind === "ok" && r.out ? r.out : null);

export interface RepoInfo {
  repo?: string;
  branch?: string;
  /** Top of the working tree on this machine. Local use only (recordRepo); never copied into an event. */
  root?: string;
  /** True only when git said the directory is not inside any repository. */
  notRepo?: boolean;
}

/** Den key for sessions outside any git repo. Real keys are "host/owner/name", so it cannot collide. */
export const SCRATCH_REPO = "scratch";
/** Prefix of the den key for a git repo with no remote; "local" is never a real host. */
export const LOCAL_PREFIX = "local/";
/** Separates the folder name from the per-repo tag in "short" mode keys. */
export const LOCAL_TAG_SEPARATOR = "~";
export const SHORT_TAG_LENGTH = 6;
export const HASHED_TAG_LENGTH = 10;
const MAX_FOLDER_LENGTH = 40;

/** A folder name made safe for a den key: control characters and separators removed, length capped by code point. */
export function sanitizeFolderName(name: string): string {
  const clean = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[\\/]/g, "")
    .trim();
  return Array.from(clean).slice(0, MAX_FOLDER_LENGTH).join("") || "unnamed";
}

/** HMAC-SHA256 of the repo's absolute path under the per-install secret, as hex. */
export const repoTag = (secret: string, root: string): string =>
  createHmac("sha256", Buffer.from(secret, "hex")).update(root).digest("hex");

/**
 * Den key for a repo with no remote, unique per repo on this install. Mode "short" is
 * "local/<folder>~<6 hex>"; "hash" and "hidden" are "local/<10 hex>" with no folder name. The hex is
 * a keyed hash of the absolute path, so two repos with the same folder name never share a den and
 * the key cannot be guessed or compared across machines. Returns null when there is no secret.
 */
export function localRepoKey(root: string, mode: TargetMode, secret: string | null): string | null {
  if (!secret) return null;
  const tag = repoTag(secret, root);
  if (mode !== "short") return LOCAL_PREFIX + tag.slice(0, HASHED_TAG_LENGTH);
  const folder = sanitizeFolderName(path.basename(root));
  return LOCAL_PREFIX + folder + LOCAL_TAG_SEPARATOR + tag.slice(0, SHORT_TAG_LENGTH);
}

export interface RepoInfoOptions {
  /** Foxhole home, where the per-install secret for local keys lives. */
  home: string;
  /** Test seam for the git call. */
  run?: GitRunner;
}

/**
 * Which den and branch corner a session belongs to. Best effort and never throws. A remote gives
 * "host/owner/name"; a repo without one gives a unique local key (see localRepoKey). `notRepo` is set
 * only when git definitively says the directory is not in a repository; any other git failure, or a
 * missing secret for a local key, leaves `repo` unset so the session keeps its last known den.
 */
export function repoInfo(cwd: string, mode: TargetMode, opts: RepoInfoOptions): RepoInfo {
  const run = opts.run ?? runGit;
  const top = run(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.kind === "not-repo") return { notRepo: true };
  const root = okOutput(top);
  if (!root) return {};
  const remote = okOutput(run(cwd, ["remote", "get-url", "origin"]));
  const repo =
    (remote ? normalizeRemote(remote) : null) ?? localRepoKey(root, mode, localKeySecret(opts.home));
  if (!repo) return {};
  const info: RepoInfo = { repo, root };
  // symbolic-ref also works in a fresh repo with no commits; a detached HEAD has no branch.
  const branch = okOutput(run(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]));
  if (branch) info.branch = branch;
  return info;
}

import { execFileSync } from "node:child_process";

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

function git(cwd: string, args: string[]): string | null {
  try {
    return (
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 800,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export interface RepoInfo {
  repo?: string;
  branch?: string;
}

/** Which den and branch corner a session belongs to. Best effort: outside a repo both are absent. */
export function repoInfo(cwd: string): RepoInfo {
  const info: RepoInfo = {};
  const remote = git(cwd, ["remote", "get-url", "origin"]);
  const repo = remote ? normalizeRemote(remote) : null;
  if (repo) info.repo = repo;
  // symbolic-ref also works in a fresh repo with no commits; a detached HEAD has no branch.
  const branch = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (branch) info.branch = branch;
  return info;
}

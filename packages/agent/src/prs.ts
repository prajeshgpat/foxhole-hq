import { execFile } from "node:child_process";

/**
 * Open pull requests come from the user's own `gh` login, so no token ever lives in the repo or in
 * ~/.foxhole. Only github.com repos qualify, and the repo name is validated before it reaches gh.
 */
export interface Pr {
  number: number;
  title: string;
  author: string;
  branch: string;
  draft: boolean;
  review: string | null;
  checks: "pass" | "fail" | "pending" | "none";
  url: string;
  updatedAt: string;
}

export type PrResult = { available: true; prs: Pr[] } | { available: false; reason: string };
export type Exec = (file: string, args: string[]) => Promise<string>;

const REPO = /^github\.com\/([\w.-]+\/[\w.-]+)$/;
const TTL_MS = 60_000;
const TIMEOUT_MS = 10_000;
const FIELDS = "number,title,author,headRefName,isDraft,reviewDecision,statusCheckRollup,url,updatedAt";

const runGh: Exec = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: TIMEOUT_MS, maxBuffer: 2_000_000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    ),
  );

function checksOf(rollup: unknown): Pr["checks"] {
  if (!Array.isArray(rollup) || !rollup.length) return "none";
  const states = rollup.map((c: Record<string, unknown>) =>
    String(c.conclusion || c.state || c.status || "").toUpperCase(),
  );
  if (states.some((s) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(s))) return "fail";
  if (states.some((s) => !s || ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED"].includes(s)))
    return "pending";
  return "pass";
}

export function toPrs(json: string): Pr[] {
  const rows = JSON.parse(json) as Array<Record<string, unknown>>;
  return rows.slice(0, 30).map((r) => ({
    number: Number(r.number),
    title: String(r.title ?? "").slice(0, 200),
    author: String((r.author as { login?: string } | null)?.login ?? "unknown"),
    branch: String(r.headRefName ?? ""),
    draft: r.isDraft === true,
    review: r.reviewDecision ? String(r.reviewDecision) : null,
    checks: checksOf(r.statusCheckRollup),
    url: String(r.url ?? ""),
    updatedAt: String(r.updatedAt ?? ""),
  }));
}

const cache = new Map<string, { at: number; result: PrResult }>();

export async function listPrs(repo: string, exec: Exec = runGh, now = Date.now()): Promise<PrResult> {
  const name = REPO.exec(repo)?.[1];
  if (!name) return { available: false, reason: "Only github.com repos can list pull requests." };
  const hit = cache.get(repo);
  if (hit && now - hit.at < TTL_MS) return hit.result;
  let result: PrResult;
  try {
    const out = await exec("gh", [
      "pr",
      "list",
      "-R",
      name,
      "--state",
      "open",
      "--limit",
      "30",
      "--json",
      FIELDS,
    ]);
    result = { available: true, prs: toPrs(out) };
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    result = {
      available: false,
      reason: missing
        ? "Install the GitHub CLI (gh) to see pull requests."
        : "Run `gh auth login` to see pull requests.",
    };
  }
  cache.set(repo, { at: now, result });
  return result;
}

export const clearPrCache = () => cache.clear();

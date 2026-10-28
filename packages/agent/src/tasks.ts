import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * A repo's task list is a TASKS.md the user controls: GitHub-style task items under `##` headings.
 *
 *   ## Ready
 *   - [ ] Fix session expiry <!-- id:t-auth-1 --> #bug ~S
 *         Indented lines under an item become its detail.
 *
 * Ready / Todo / Backlog are open, Doing / In progress are doing, Done is done; a ticked box is always done.
 * Foxhole never writes this file.
 */
export type TaskStatus = "open" | "doing" | "done";

export interface Task {
  id: string;
  title: string;
  detail?: string;
  labels: string[];
  size?: "S" | "M" | "L";
  status: TaskStatus;
  source: "tasks-md";
}

export const MAX_TASKS = 200;
export const MAX_DETAIL = 1024;
export const MAX_TASKS_FILE = 256 * 1024;

const ITEM = /^\s{0,3}[-*]\s+\[([ xX])\]\s+(.*)$/;
const ID = /<!--\s*id:([\w.-]{1,40})\s*-->/;

function statusOf(heading: string): TaskStatus {
  const h = heading.toLowerCase();
  if (/\bdone\b|\bcomplete/.test(h)) return "done";
  if (/\bdoing\b|in progress|\bwip\b/.test(h)) return "doing";
  return "open";
}

/** Drops control characters so task text can never smuggle terminal or hook-output tricks. */
export const clean = (text: string) =>
  [...text]
    .filter((ch) => ch === "\n" || ch === "\t" || (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127))
    .join("");

export function parseTasks(markdown: string): Task[] {
  const tasks: Task[] = [];
  let section: TaskStatus = "open";
  let last: Task | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      section = statusOf(heading[1]!);
      last = null;
      continue;
    }
    const item = ITEM.exec(raw);
    if (item) {
      if (tasks.length >= MAX_TASKS) break;
      let body = item[2]!;
      const id = ID.exec(body)?.[1];
      body = body.replace(ID, "");
      const size = /(?:^|\s)~([SML])\b/.exec(body)?.[1] as Task["size"];
      body = body.replace(/(?:^|\s)~[SML]\b/g, "");
      const labels = [...body.matchAll(/(?:^|\s)#([\w-]{1,30})/g)].map((m) => m[1]!);
      body = body.replace(/(?:^|\s)#[\w-]{1,30}/g, "");
      const title = clean(body).trim().slice(0, 200);
      if (!title) continue;
      last = {
        id: id ?? "t-" + createHash("sha1").update(title).digest("hex").slice(0, 8),
        title,
        labels,
        status: item[1] !== " " ? "done" : section,
        source: "tasks-md",
      };
      if (size) last.size = size;
      tasks.push(last);
      continue;
    }
    if (last && /^\s{2,}\S/.test(raw)) {
      const detail = ((last.detail ? last.detail + "\n" : "") + clean(raw).trim()).slice(0, MAX_DETAIL);
      last.detail = detail;
    } else if (!raw.trim()) {
      // a blank line ends an item's detail
      last = null;
    }
  }
  return tasks;
}

/** Reads `<root>/TASKS.md`, refusing symlinks that leave the repo and files that are too large. */
export function readTasksFile(root: string): Task[] | null {
  try {
    const real = realpathSync(path.join(root, "TASKS.md"));
    const base = realpathSync(root);
    if (!real.startsWith(base + path.sep)) return null;
    const fd = openSync(real, "r");
    try {
      const size = fstatSync(fd).size;
      if (size > MAX_TASKS_FILE) return null;
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      return parseTasks(buf.toString("utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { upgradeEvent, type FoxholeEvent } from "@foxhole-hq/schema";
import type { TargetMode } from "./target";
import { emptyCursor, type UsageCursor } from "./usage";

/**
 * Everything Foxhole keeps locally lives in one private folder (default ~/.foxhole):
 *   events.jsonl      append-only log, one validated event per line
 *   machine-id        random id for this machine, created once
 *   config.json       user settings, e.g. { "targets": "hash" }
 *   state/<id>.json   per-session cursor into the transcript for token usage
 *   payload-shapes.jsonl  (debug only) which keys each hook payload had, never their values
 */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FOXHOLE_HOME || path.join(os.homedir(), ".foxhole");
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write via a temp file and rename, so a crash never leaves half a JSON file behind. */
function writeJsonAtomic(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

export interface Config {
  targets: TargetMode;
}

export function readConfig(home: string): Config {
  const raw = readJson<Partial<Config>>(path.join(home, "config.json"), {});
  const targets = raw.targets === "hash" || raw.targets === "hidden" ? raw.targets : "short";
  return { targets };
}

export function machineId(home: string): string {
  const file = path.join(home, "machine-id");
  try {
    const id = readFileSync(file, "utf8").trim();
    if (id) return id;
  } catch {
    // first run on this machine
  }
  ensureDir(home);
  const id = "m_" + randomUUID().replace(/-/g, "").slice(0, 12);
  writeFileSync(file, id + "\n", { mode: 0o600 });
  return id;
}

export const eventsFile = (home: string) => path.join(home, "events.jsonl");

export function appendEvent(home: string, event: FoxholeEvent) {
  ensureDir(home);
  appendFileSync(eventsFile(home), JSON.stringify(event) + "\n", { mode: 0o600 });
}

export function readEvents(home: string): FoxholeEvent[] {
  try {
    return readFileSync(eventsFile(home), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [upgradeEvent(JSON.parse(line)) as FoxholeEvent];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

const safeName = (sessionId: string) => sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);

export function readCursor(home: string, sessionId: string): UsageCursor {
  return readJson(path.join(home, "state", safeName(sessionId) + ".json"), emptyCursor());
}

export function writeCursor(home: string, sessionId: string, cursor: UsageCursor) {
  const dir = path.join(home, "state");
  ensureDir(dir);
  writeJsonAtomic(path.join(dir, safeName(sessionId) + ".json"), cursor);
}

/** Debug aid for checking real hook payloads: records key names only, never values. */
export function recordPayloadShape(home: string, payload: Record<string, unknown>) {
  ensureDir(home);
  const shape = Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [
      k,
      v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v as object).sort() : typeof v,
    ]),
  );
  appendFileSync(path.join(home, "payload-shapes.jsonl"), JSON.stringify(shape) + "\n", { mode: 0o600 });
}

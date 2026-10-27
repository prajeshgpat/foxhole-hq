import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FoxholeEvent } from "@foxhole-hq/schema";
import { handleClaudeHook } from "./hook";
import { DEFAULT_PORT, startServer } from "./serve";
import { eventsFile, homeDir, readEvents } from "./store";

const HELP = `foxhole: see your AI coding agents work

Usage:
  foxhole hook          Read a Claude Code hook payload on stdin and record it (used by the plugin)
  foxhole tail [n]      Show the last n recorded events (default 20)
  foxhole stats         Sessions, tool calls and tokens recorded so far
  foxhole where         Print where events are stored
  foxhole serve [port]  Open your live den at http://127.0.0.1:${DEFAULT_PORT} (FOXHOLE_PAGE overrides the page)

Settings live in ~/.foxhole/config.json, e.g. { "targets": "hash" } to hash file names and commands,
or { "targets": "hidden" } to drop them. Set FOXHOLE_HOME to use another folder.`;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function line(e: FoxholeEvent): string {
  const time = e.ts.slice(11, 19);
  const where = [e.repo?.replace(/^github\.com\//, ""), e.branch].filter(Boolean).join(" @ ");
  const what = e.tool ? `${e.tool} ${e.target ?? ""}`.trim() : "";
  const usage = e.usage
    ? `${fmtTokens(e.usage.inputTokens)} in / ${fmtTokens(e.usage.outputTokens)} out`
    : "";
  return [time, e.sessionId.slice(0, 8), e.type.padEnd(18), what, usage, where && `(${where})`]
    .filter(Boolean)
    .join("  ");
}

function stats(events: FoxholeEvent[]): string {
  const sessions = new Set(events.map((e) => e.sessionId));
  const tools = events.filter((e) => e.type === "tool.start");
  const errors = events.filter((e) => e.type === "tool.end" && e.status === "error").length;
  const asks = events.filter((e) => e.type === "permission.request").length;
  const byTool = new Map<string, number>();
  for (const t of tools) byTool.set(t.tool ?? "?", (byTool.get(t.tool ?? "?") ?? 0) + 1);
  let input = 0;
  let output = 0;
  for (const e of events) {
    if (e.type !== "session.stop" || !e.usage) continue;
    input += e.usage.inputTokens;
    output += e.usage.outputTokens;
  }
  const top = [...byTool]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return [
    `events       ${events.length}`,
    `sessions     ${sessions.size}`,
    `tool calls   ${tools.length}${top ? ` (${top})` : ""}`,
    `tool errors  ${errors}`,
    `permission   ${asks} requests`,
    `tokens       ${fmtTokens(input)} in / ${fmtTokens(output)} out`,
  ].join("\n");
}

// Both built bundles (packages/*/dist/*.mjs) sit three levels below the repo root.
const DEFAULT_PAGE = fileURLToPath(new URL("../../../apps/web/prototype/index.html", import.meta.url));

async function serve(home: string, portArg: string | undefined): Promise<number> {
  const page = process.env.FOXHOLE_PAGE || DEFAULT_PAGE;
  if (!existsSync(page)) {
    process.stderr.write(`Can't find the den page at ${page}. Set FOXHOLE_PAGE to its path.\n`);
    return 1;
  }
  const port = portArg ? Number(portArg) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`"${portArg}" is not a port number.\n`);
    return 1;
  }
  try {
    const den = await startServer({ home, page, port });
    process.stdout.write(`Your den is live at http://127.0.0.1:${den.port}  (Ctrl+C to stop)\n`);
    return await new Promise((resolve) =>
      process.once("SIGINT", () => {
        den.close();
        resolve(0);
      }),
    );
  } catch (err) {
    const inUse = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
    process.stderr.write(
      inUse ? `Port ${port} is busy. Try: foxhole serve <another port>\n` : `${(err as Error).message}\n`,
    );
    return 1;
  }
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  const home = homeDir();
  switch (cmd) {
    case "hook": {
      // A hook must never break or slow the agent: swallow every error, print nothing, exit 0.
      try {
        handleClaudeHook(await readStdin(), { home, debugShapes: process.env.FOXHOLE_DEBUG_SHAPES === "1" });
      } catch {
        // ignored on purpose
      }
      return 0;
    }
    case "tail": {
      const n = Math.max(1, Number(arg) || 20);
      const events = readEvents(home).slice(-n);
      process.stdout.write(events.length ? events.map(line).join("\n") + "\n" : "No events yet.\n");
      return 0;
    }
    case "stats":
      process.stdout.write(stats(readEvents(home)) + "\n");
      return 0;
    case "serve":
      return serve(home, arg);
    case "where":
      process.stdout.write(eventsFile(home) + "\n");
      return 0;
    default:
      process.stdout.write(HELP + "\n");
      return cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));

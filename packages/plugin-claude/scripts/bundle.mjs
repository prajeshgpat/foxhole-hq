// Copy the self-contained agent CLI into the plugin, which Claude Code loads straight from git.
// CI rebuilds it and fails if the committed copy is stale.
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const agentDir = path.dirname(require.resolve("@foxhole-hq/agent/package.json"));
const out = path.join(here, "..", "dist", "foxhole.mjs");
mkdirSync(path.dirname(out), { recursive: true });
copyFileSync(path.join(agentDir, "dist", "cli.mjs"), out);
chmodSync(out, 0o755);
console.log(`bundled ${path.relative(process.cwd(), out)}`);

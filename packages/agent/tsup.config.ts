import { defineConfig } from "tsup";

// One self-contained ESM file with every dependency inlined, so a hook can run it with plain `node`
// and no install step.
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outExtension: () => ({ js: ".mjs" }),
  noExternal: [/.*/],
  minify: false,
  sourcemap: false,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});

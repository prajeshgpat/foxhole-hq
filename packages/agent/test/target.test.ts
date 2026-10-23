import { describe, expect, it } from "vitest";
import { applyMode, shortCommand, shortPath, targetFor } from "../src/target";

const cwd = "/home/dev/acme-web";

describe("shortPath", () => {
  it("makes paths inside the project relative", () => {
    expect(shortPath("/home/dev/acme-web/src/auth/session.ts", cwd)).toBe("src/auth/session.ts");
  });
  it("reduces paths outside the project to a file name", () => {
    expect(shortPath("/etc/ssh/sshd_config", cwd)).toBe("sshd_config");
    expect(shortPath("/home/dev/.aws/credentials", cwd)).toBe("credentials");
  });
});

describe("shortCommand", () => {
  it.each([
    ["pnpm test auth", "pnpm test auth"],
    ["npm run migrate -- --force", "npm run migrate"],
    ["git status", "git status"],
    ["/usr/local/bin/node scripts/replay.mjs", "node scripts/replay.mjs"],
    ["API_KEY=sk-live-123 pnpm deploy", "pnpm deploy"],
    ['curl -H "Authorization: Bearer abc" https://api.example.com', "curl"],
    ["echo $SECRET > out.txt", "echo"],
    ["psql postgres://user:hunter2@db/prod", "psql"],
  ])("%s -> %s", (cmd, expected) => {
    expect(shortCommand(cmd)).toBe(expected);
  });
  it("returns null when nothing safe is left", () => {
    expect(shortCommand("TOKEN=abc")).toBeNull();
    expect(shortCommand("  ")).toBeNull();
  });
});

describe("targetFor", () => {
  it("labels file tools with relative paths", () => {
    expect(
      targetFor("Edit", { file_path: `${cwd}/src/a.ts`, old_string: "x", new_string: "y" }, cwd, "short"),
    ).toBe("src/a.ts");
  });
  it("never uses a grep pattern, only where it searched", () => {
    expect(targetFor("Grep", { pattern: "password\\s*=", path: `${cwd}/src` }, cwd, "short")).toBe("src");
    expect(targetFor("Grep", { pattern: "password\\s*=" }, cwd, "short")).toBeNull();
  });
  it("keeps only the hostname of a fetched url", () => {
    expect(
      targetFor(
        "WebFetch",
        { url: "https://docs.example.com/a?token=xyz", prompt: "summarize" },
        cwd,
        "short",
      ),
    ).toBe("docs.example.com");
  });
  it("drops web search queries and unknown tools", () => {
    expect(targetFor("WebSearch", { query: "how to fix our auth bug" }, cwd, "short")).toBeNull();
    expect(targetFor("SomeNewTool", { anything: "x" }, cwd, "short")).toBeNull();
  });
  it("uses the subagent type for Task, not its prompt", () => {
    expect(targetFor("Task", { subagent_type: "Explore", prompt: "read every secret" }, cwd, "short")).toBe(
      "Explore",
    );
  });
});

describe("applyMode", () => {
  it("hashes stably and hides fully", () => {
    const a = applyMode("src/a.ts", "hash");
    expect(a).toMatch(/^h:[0-9a-f]{10}$/);
    expect(applyMode("src/a.ts", "hash")).toBe(a);
    expect(applyMode("src/a.ts", "hidden")).toBeNull();
  });
  it("clips long labels to the schema limit", () => {
    expect(applyMode("a/".repeat(60), "short")!.length).toBe(80);
  });
});

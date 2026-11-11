import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { localRepoKey, normalizeRemote, repoInfo, sanitizeFolderName, type GitRunner } from "../src/git";
import { LOCAL_KEY_FILE, localKeySecret } from "../src/store";

describe("normalizeRemote", () => {
  it.each([
    ["https://github.com/acme/web.git", "github.com/acme/web"],
    ["https://github.com/acme/web", "github.com/acme/web"],
    ["git@github.com:acme/web.git", "github.com/acme/web"],
    ["ssh://git@github.com/acme/web.git", "github.com/acme/web"],
    ["https://user:ghp_secret@github.com/acme/web.git", "github.com/acme/web"],
    ["https://GitLab.com/group/sub/repo.git/", "gitlab.com/group/sub/repo"],
  ])("%s -> %s", (url, expected) => {
    expect(normalizeRemote(url)).toBe(expected);
  });
  it("rejects nonsense", () => {
    expect(normalizeRemote("")).toBeNull();
    expect(normalizeRemote("not a url")).toBeNull();
  });
});

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "foxhole-git-"));
function initRepo(dir: string, remote?: string) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "feat/x");
  if (remote) git("remote", "add", "origin", remote);
}

function repoAt(...parts: string[]): string {
  const dir = path.join(tmp(), ...parts);
  mkdirSync(dir, { recursive: true });
  initRepo(dir);
  return dir;
}

describe("sanitizeFolderName", () => {
  it("strips control characters and separators", () => {
    expect(sanitizeFolderName("my\x00pro\nject\x1b[31m")).toBe("myproject[31m");
    expect(sanitizeFolderName("a/b\\c")).toBe("abc");
  });
  it("caps very long names", () => {
    expect(sanitizeFolderName("x".repeat(500))).toHaveLength(40);
  });
  it("falls back to a placeholder when nothing is left", () => {
    expect(sanitizeFolderName("\x00\x01")).toBe("unnamed");
  });
  it("never cuts an emoji in half at the cap", () => {
    const name = sanitizeFolderName("a".repeat(39) + "\u{1F98A}\u{1F98A}");
    expect(Array.from(name)).toHaveLength(40);
    expect(() => encodeURIComponent(name)).not.toThrow();
  });
});

const SECRET_A = "ab".repeat(32);
const SECRET_B = "cd".repeat(32);

describe("localRepoKey", () => {
  it("short mode is local/<folder>~<6 hex> from the basename only", () => {
    expect(localRepoKey("/Users/someone/code/notes", "short", SECRET_A)).toMatch(
      /^local\/notes~[0-9a-f]{6}$/,
    );
  });
  it.each(["hash", "hidden"] as const)("%s mode is local/<10 hex> with no folder name", (mode) => {
    const key = localRepoKey("/a/notes", mode, SECRET_A)!;
    expect(key).toMatch(/^local\/[0-9a-f]{10}$/);
    expect(key).not.toContain("notes");
  });
  it("gives the same key for the same path and secret", () => {
    expect(localRepoKey("/a/notes", "short", SECRET_A)).toBe(localRepoKey("/a/notes", "short", SECRET_A));
  });
  it("differs for same-named folders in different places", () => {
    expect(localRepoKey("/work/api", "short", SECRET_A)).not.toBe(
      localRepoKey("/personal/api", "short", SECRET_A),
    );
    expect(localRepoKey("/work/api", "hidden", SECRET_A)).not.toBe(
      localRepoKey("/personal/api", "hidden", SECRET_A),
    );
  });
  it("differs under a different secret", () => {
    expect(localRepoKey("/a/notes", "hash", SECRET_A)).not.toBe(localRepoKey("/a/notes", "hash", SECRET_B));
  });
  it("returns null without a secret rather than an unkeyed hash", () => {
    expect(localRepoKey("/a/notes", "short", null)).toBeNull();
  });
});

describe("localKeySecret", () => {
  it("creates a 32-byte hex secret once with mode 0600 and reuses it", () => {
    const home = tmp();
    const first = localKeySecret(home);
    const file = path.join(home, LOCAL_KEY_FILE);
    const body = readFileSync(file, "utf8");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(localKeySecret(home)).toBe(first);
    expect(readFileSync(file, "utf8")).toBe(body);
  });
  it("returns null instead of throwing when the file cannot be read or created", () => {
    const home = tmp();
    mkdirSync(path.join(home, LOCAL_KEY_FILE)); // a directory squatting on the file name
    expect(localKeySecret(home)).toBeNull();
  });
});

describe("repoInfo", () => {
  it("uses the normalized remote when there is one", () => {
    const dir = tmp();
    initRepo(dir, "git@github.com:acme/web.git");
    const info = repoInfo(dir, "short", { home: tmp() });
    expect(info).toMatchObject({ repo: "github.com/acme/web", branch: "feat/x" });
  });
  it("uses local/<folder>~<tag> with the real branch when there is no remote", () => {
    const dir = repoAt("my-notes");
    const info = repoInfo(dir, "short", { home: tmp() });
    expect(info.repo).toMatch(/^local\/my-notes~[0-9a-f]{6}$/);
    expect(info.branch).toBe("feat/x");
  });
  it("gives two repos with the same folder name different keys, and the same repo the same key", () => {
    const home = tmp();
    const a = repoAt("work", "api");
    const b = repoAt("personal", "api");
    expect(repoInfo(a, "short", { home }).repo).not.toBe(repoInfo(b, "short", { home }).repo);
    expect(repoInfo(a, "short", { home }).repo).toBe(repoInfo(a, "short", { home }).repo);
  });
  it("gives the same directory a different key under another foxhole home", () => {
    const dir = repoAt("notes");
    expect(repoInfo(dir, "short", { home: tmp() }).repo).not.toBe(
      repoInfo(dir, "short", { home: tmp() }).repo,
    );
  });
  it("uses an unnamed 10-hex key in hash and hidden modes", () => {
    const dir = repoAt("secret-project");
    const home = tmp();
    for (const mode of ["hash", "hidden"] as const) {
      const repo = repoInfo(dir, mode, { home }).repo!;
      expect(repo).toMatch(/^local\/[0-9a-f]{10}$/);
      expect(repo).not.toContain("secret-project");
    }
  });
  it("keeps the absolute path and parent folder names out of the result's repo and branch", () => {
    const top = path.join(tmp(), "parent-dir-name", "proj");
    const sub = path.join(top, "deep", "er");
    mkdirSync(sub, { recursive: true });
    initRepo(top);
    const info = repoInfo(sub, "short", { home: tmp() });
    expect(info.repo).toMatch(/^local\/proj~[0-9a-f]{6}$/);
    expect(JSON.stringify({ repo: info.repo, branch: info.branch })).not.toMatch(
      /parent-dir-name|\/tmp|\/var/,
    );
  });
  it("leaves repo unset when the secret cannot be read or created", () => {
    const home = tmp();
    mkdirSync(path.join(home, LOCAL_KEY_FILE));
    const dir = repoAt("notes");
    expect(repoInfo(dir, "short", { home })).toEqual({});
  });
  it("reports notRepo, with no repo or branch, outside a git repo", () => {
    expect(repoInfo(tmp(), "short", { home: tmp() })).toEqual({ notRepo: true });
  });
  it("leaves repo unset, not notRepo, when git cannot run (missing directory)", () => {
    expect(repoInfo(path.join(tmp(), "does-not-exist"), "short", { home: tmp() })).toEqual({});
  });
  it("leaves repo unset, not notRepo, when git times out", () => {
    const timedOut: GitRunner = () => ({ kind: "failed" });
    expect(repoInfo("/anywhere", "short", { home: tmp(), run: timedOut })).toEqual({});
  });
});

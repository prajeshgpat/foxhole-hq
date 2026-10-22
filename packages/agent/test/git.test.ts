import { describe, expect, it } from "vitest";
import { normalizeRemote } from "../src/git";

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

import { beforeEach, describe, expect, it } from "vitest";
import { clearPrCache, listPrs, toPrs } from "../src/prs";

const GH = JSON.stringify([
  {
    number: 12,
    title: "Fix expiry",
    author: { login: "ember" },
    headRefName: "fix/session-expiry",
    isDraft: false,
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }],
    url: "https://github.com/acme/web/pull/12",
    updatedAt: "2026-10-27T10:00:00Z",
  },
  {
    number: 13,
    title: "WIP",
    author: null,
    headRefName: "wip",
    isDraft: true,
    reviewDecision: "",
    statusCheckRollup: [{ conclusion: "FAILURE" }],
    url: "u",
    updatedAt: "t",
  },
]);

beforeEach(clearPrCache);

describe("toPrs", () => {
  it("maps gh output, including checks and a missing author", () => {
    const prs = toPrs(GH);
    expect(prs[0]).toMatchObject({
      number: 12,
      author: "ember",
      branch: "fix/session-expiry",
      checks: "pass",
      review: "APPROVED",
    });
    expect(prs[1]).toMatchObject({ author: "unknown", draft: true, checks: "fail", review: null });
  });
});

describe("listPrs", () => {
  it("only asks gh about valid github.com repos, without a shell", async () => {
    const calls: string[][] = [];
    const exec = async (_: string, args: string[]) => (calls.push(args), GH);
    const res = await listPrs("github.com/acme/web", exec);
    expect(res.available).toBe(true);
    expect(calls[0]).toEqual(expect.arrayContaining(["pr", "list", "-R", "acme/web"]));
    expect((await listPrs("gitlab.com/acme/web", exec)).available).toBe(false);
    expect((await listPrs("github.com/acme/web; rm -rf /", exec)).available).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("caches for a minute", async () => {
    let n = 0;
    const exec = async () => (n++, GH);
    await listPrs("github.com/acme/web", exec, 1000);
    await listPrs("github.com/acme/web", exec, 30_000);
    await listPrs("github.com/acme/web", exec, 70_000);
    expect(n).toBe(2);
  });

  it("explains when gh is missing", async () => {
    const exec = async () => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    };
    const res = await listPrs("github.com/acme/web", exec);
    expect(res).toMatchObject({ available: false, reason: expect.stringContaining("Install") });
  });
});

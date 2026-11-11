import { describe, expect, it } from "vitest";
import { isEnded, pendingPermission, type EventType } from "../src/index";

const of = (...types: EventType[]) => types.map((type) => ({ type }));

describe("isEnded", () => {
  it("is false for no events and for a session still running", () => {
    expect(isEnded([])).toBe(false);
    expect(isEnded(of("session.start", "prompt.submit", "tool.start"))).toBe(false);
  });

  it("is true after session.end, and after a subagent's stop", () => {
    expect(isEnded(of("session.start", "turn.end", "session.end"))).toBe(true);
    expect(isEnded(of("subagent.stop"))).toBe(true);
  });

  it("stays ended through late tool and idle events", () => {
    expect(isEnded(of("session.end", "tool.end", "session.waiting", "turn.end"))).toBe(true);
  });

  it("is false again once the session is resumed or prompted", () => {
    expect(isEnded(of("session.end", "session.start"))).toBe(false);
    expect(isEnded(of("session.end", "prompt.submit", "tool.start"))).toBe(false);
  });
});

describe("pendingPermission", () => {
  it("returns the request while nothing has answered it", () => {
    const events = of("prompt.submit", "tool.start", "permission.request");
    expect(pendingPermission(events)).toBe(events[2]);
  });

  it("keeps the request pending through an idle notification", () => {
    const events = of("permission.request", "session.waiting");
    expect(pendingPermission(events)).toBe(events[0]);
  });

  it.each<EventType>(["tool.start", "tool.end", "prompt.submit", "turn.end", "session.end"])(
    "is cleared by %s",
    (type) => {
      expect(pendingPermission(of("permission.request", type))).toBeNull();
    },
  );

  it("returns the newest request when there are several", () => {
    const events = of("permission.request", "tool.end", "permission.request");
    expect(pendingPermission(events)).toBe(events[2]);
  });

  it("is null when there was never a request", () => {
    expect(pendingPermission(of("session.start", "tool.start"))).toBeNull();
  });
});

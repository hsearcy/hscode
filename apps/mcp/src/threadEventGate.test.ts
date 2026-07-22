import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createThreadEventGate, type ThreadEventForward } from "./threadEventGate.ts";

const THREAD = "11111111-2222-3333-4444-555555555555";

function activity(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "activity",
    threadId: THREAD,
    terminalId: "default",
    createdAt: new Date().toISOString(),
    hasRunningSubprocess: false,
    cliKind: "claude",
    agentState: null,
    ...overrides,
  };
}

describe("createThreadEventGate", () => {
  let forwarded: ThreadEventForward[];
  let gate: ReturnType<typeof createThreadEventGate>;

  beforeEach(() => {
    vi.useFakeTimers();
    forwarded = [];
    gate = createThreadEventGate({ forward: (input) => forwarded.push(input) });
  });

  afterEach(() => {
    gate.dispose();
    vi.useRealTimers();
  });

  it("suppresses a Claude review that flips back to running during stop-hook/background-agent churn", () => {
    // Production payload 1 (2026-07-22T15:41:04.951Z): Stop hook fired while
    // stop hooks and background subagents were still working — a background
    // tool completion flipped the state back to running moments later.
    gate.handleActivity(
      activity({ agentState: "review", hasRunningSubprocess: false, cliKind: "claude" }),
    );
    vi.advanceTimersByTime(1500);
    gate.handleActivity(activity({ agentState: "running", hasRunningSubprocess: true }));
    vi.advanceTimersByTime(60_000);
    // The running transition still flows (subscribers filter it out by
    // default) — the point is the churn review never does.
    expect(forwarded.map((f) => f.state)).toEqual(["running"]);
  });

  it("forwards a genuinely completed Claude turn as review once it sticks", () => {
    gate.handleActivity(activity({ agentState: "running" }));
    gate.handleActivity(activity({ agentState: "review" }));
    expect(forwarded.length).toBe(1); // only the running transition so far
    vi.advanceTimersByTime(5000);
    expect(forwarded.map((f) => f.state)).toEqual(["running", "review"]);
  });

  it("forwards a genuine Claude permission prompt as attention once it sticks", () => {
    gate.handleActivity(activity({ agentState: "running" }));
    gate.handleActivity(activity({ agentState: "attention" }));
    vi.advanceTimersByTime(3000);
    expect(forwarded.map((f) => f.state)).toEqual(["running", "attention"]);
  });

  it("suppresses transient attention from auto-allowed permission prompts", () => {
    // Production payload 2 pattern (2026-07-22T15:42:08.491Z): attention with
    // hasRunningSubprocess=true during an ongoing turn — no prompt on screen.
    gate.handleActivity(activity({ agentState: "running" }));
    gate.handleActivity(activity({ agentState: "attention", hasRunningSubprocess: true }));
    vi.advanceTimersByTime(500);
    gate.handleActivity(activity({ agentState: "running", hasRunningSubprocess: true }));
    vi.advanceTimersByTime(60_000);
    expect(forwarded.map((f) => f.state)).toEqual(["running", "running"]);
  });

  it("suppresses review/attention bouncing during an ongoing turn", () => {
    gate.handleActivity(activity({ agentState: "review" }));
    vi.advanceTimersByTime(1000);
    gate.handleActivity(activity({ agentState: "attention" }));
    vi.advanceTimersByTime(1000);
    gate.handleActivity(activity({ agentState: "running" }));
    vi.advanceTimersByTime(60_000);
    expect(forwarded.map((f) => f.state)).toEqual(["running"]);
  });

  it("forwards Codex review transitions immediately (behavior unchanged)", () => {
    gate.handleActivity(activity({ agentState: "review", cliKind: "codex" }));
    expect(forwarded.map((f) => f.state)).toEqual(["review"]);
  });

  it("still debounces Codex attention transitions (behavior unchanged)", () => {
    gate.handleActivity(activity({ agentState: "attention", cliKind: "codex" }));
    expect(forwarded).toEqual([]);
    vi.advanceTimersByTime(3000);
    expect(forwarded.map((f) => f.state)).toEqual(["attention"]);
  });

  it("dedupes repeated events with the same agentState", () => {
    gate.handleActivity(activity({ agentState: "running" }));
    gate.handleActivity(activity({ agentState: "running" }));
    expect(forwarded.length).toBe(1);
  });

  it("ignores synthetic workspace thread ids and non-activity events", () => {
    gate.handleActivity(activity({ threadId: `workspace:${THREAD}`, agentState: "review" }));
    gate.handleActivity(activity({ type: "output", agentState: "review" }));
    vi.advanceTimersByTime(60_000);
    expect(forwarded).toEqual([]);
  });
});

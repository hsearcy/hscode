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

  it("forwards a Codex completion whose state was already review (stale-state regression)", () => {
    // Production incident (2026-07-28, thread "Pipeline Perf"): newer Codex
    // TUIs stopped emitting the log lines the wrapper derived Start signals
    // from, so the stored state sat in "review" while the agent worked for
    // hours. The genuine 14:49:56Z completion arrived as review→review and
    // was deduped away — no webhook fired. The server now bumps
    // turnCompletionCount on every Stop; a fresh count must forward even
    // without a state transition.
    gate.handleActivity(
      activity({ agentState: "review", cliKind: "codex", turnCompletionCount: 1 }),
    );
    expect(forwarded.map((f) => f.state)).toEqual(["review"]);

    // Subprocess-metadata churn re-emits the same completion count: deduped.
    gate.handleActivity(
      activity({
        agentState: "review",
        cliKind: "codex",
        hasRunningSubprocess: true,
        turnCompletionCount: 1,
      }),
    );
    gate.handleActivity(
      activity({
        agentState: "review",
        cliKind: "codex",
        hasRunningSubprocess: false,
        turnCompletionCount: 1,
      }),
    );
    expect(forwarded.length).toBe(1);

    // The next completed turn: same review state, bumped count — forwards.
    gate.handleActivity(
      activity({ agentState: "review", cliKind: "codex", turnCompletionCount: 2 }),
    );
    expect(forwarded.map((f) => f.state)).toEqual(["review", "review"]);
  });

  it("holds a fresh-completion Claude review to the stabilization window", () => {
    gate.handleActivity(
      activity({ agentState: "review", cliKind: "claude", turnCompletionCount: 1 }),
    );
    vi.advanceTimersByTime(5000);
    expect(forwarded.map((f) => f.state)).toEqual(["review"]);

    gate.handleActivity(
      activity({ agentState: "review", cliKind: "claude", turnCompletionCount: 2 }),
    );
    expect(forwarded.length).toBe(1); // held, not yet forwarded
    vi.advanceTimersByTime(5000);
    expect(forwarded.map((f) => f.state)).toEqual(["review", "review"]);
  });

  it("does not treat the first observed completion count as fresh after a gate restart", () => {
    // On MCP restart the gate has no baseline. The first event still forwards
    // once via the pre-existing null→review state transition, but the count it
    // carries must become the baseline — repeated events with the same
    // historical count must not keep paging as "fresh completions".
    gate.handleActivity(
      activity({ agentState: "review", cliKind: "codex", turnCompletionCount: 7 }),
    );
    gate.handleActivity(
      activity({ agentState: "review", cliKind: "codex", turnCompletionCount: 7 }),
    );
    expect(forwarded.map((f) => f.state)).toEqual(["review"]);
  });

  it("tracks completion counts per terminal, not per thread", () => {
    // A thread can run several agent terminals whose counts interleave.
    // Terminal B's first completion (count 1) must not be swallowed just
    // because terminal A already recorded count 1 for the thread.
    gate.handleActivity(
      activity({
        agentState: "review",
        cliKind: "codex",
        terminalId: "term-a",
        turnCompletionCount: 1,
      }),
    );
    expect(forwarded.length).toBe(1); // null→review transition
    gate.handleActivity(
      activity({
        agentState: "review",
        cliKind: "codex",
        terminalId: "term-b",
        turnCompletionCount: 1,
      }),
    );
    gate.handleActivity(
      activity({
        agentState: "review",
        cliKind: "codex",
        terminalId: "term-b",
        turnCompletionCount: 2,
      }),
    );
    expect(forwarded.map((f) => f.state)).toEqual(["review", "review"]);
    // And terminal A's unchanged count must not look fresh because B moved.
    gate.handleActivity(
      activity({
        agentState: "review",
        cliKind: "codex",
        terminalId: "term-a",
        turnCompletionCount: 1,
      }),
    );
    expect(forwarded.length).toBe(2);
  });

  it("holds claudex fresh-completion reviews to the Claude stabilization window", () => {
    // Claudex runs the Claude CLI — same stop-hook churn, same hold.
    gate.handleActivity(
      activity({ agentState: "review", cliKind: "claudex", turnCompletionCount: 1 }),
    );
    expect(forwarded).toEqual([]);
    vi.advanceTimersByTime(5000);
    expect(forwarded.map((f) => f.state)).toEqual(["review"]);
  });

  it("ignores synthetic workspace thread ids and non-activity events", () => {
    gate.handleActivity(activity({ threadId: `workspace:${THREAD}`, agentState: "review" }));
    gate.handleActivity(activity({ type: "output", agentState: "review" }));
    vi.advanceTimersByTime(60_000);
    expect(forwarded).toEqual([]);
  });
});

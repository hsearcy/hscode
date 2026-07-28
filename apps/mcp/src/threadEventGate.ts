// Decides which terminal activity transitions are stable enough to page a
// webhook subscriber. Raw agentState transitions are noisy: auto-allowed
// permission prompts flash "attention" for ~100 ms, and Claude's Stop hook
// flips a thread to "review" while its stop hooks and background subagents are
// still working (the next tool completion flips it straight back to
// "running"). The gate holds those transitions for a stabilization window and
// only forwards the ones that stick.

export type ThreadAgentState = "running" | "attention" | "review";

export interface ThreadEventForward {
  threadId: string;
  state: ThreadAgentState | null;
  ev: Record<string, unknown>;
}

export interface ThreadEventGateOptions {
  forward: (input: ThreadEventForward) => void;
  attentionStableMs?: number;
  reviewStableMs?: number;
}

// Attention: an auto-allowed permission prompt registers as a transient
// attention state that flips back to "running" within ~100 ms. Review
// (Claude only): stop-hook/background-agent churn flips review back to
// "running" as soon as the next background tool call completes.
const DEFAULT_ATTENTION_STABLE_MS = 3000;
const DEFAULT_REVIEW_STABLE_MS = 5000;

function normalizeState(value: unknown): ThreadAgentState | null {
  return value === "running" || value === "attention" || value === "review" ? value : null;
}

export interface ThreadEventGate {
  handleActivity(ev: Record<string, unknown>): void;
  dispose(): void;
}

export function createThreadEventGate(options: ThreadEventGateOptions): ThreadEventGate {
  const attentionStableMs = options.attentionStableMs ?? DEFAULT_ATTENTION_STABLE_MS;
  const reviewStableMs = options.reviewStableMs ?? DEFAULT_REVIEW_STABLE_MS;
  const lastStateByThread = new Map<string, ThreadAgentState | null>();
  const lastCompletionCountByThread = new Map<string, number>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function stabilizationMsFor(state: ThreadAgentState | null, cliKind: unknown): number | null {
    if (state === "attention") {
      return attentionStableMs;
    }
    // Codex's turn-complete signal only fires on genuine completion, so its
    // review transitions forward immediately, unchanged.
    if (state === "review" && cliKind === "claude") {
      return reviewStableMs;
    }
    return null;
  }

  return {
    handleActivity(ev: Record<string, unknown>): void {
      if (ev.type !== "activity") return;
      const threadId = typeof ev.threadId === "string" ? ev.threadId : null;
      if (!threadId) return;
      // Workspace-area items have synthetic thread ids like `workspace:<uuid>`
      // (see apps/web/src/workspaceStore.ts). They share the terminal.event
      // channel but aren't real conversation threads — skip them.
      if (threadId.startsWith("workspace:")) return;
      const state = normalizeState(ev.agentState);
      const prev = lastStateByThread.get(threadId) ?? null;
      // The server bumps turnCompletionCount on every Stop hook (completed
      // turn) and re-emits even when the state level did not change. A stale
      // "review" (lost Start signal) would otherwise dedupe the completion
      // away here — treat a fresh count as a genuine review edge.
      const completionCount =
        typeof ev.turnCompletionCount === "number" ? ev.turnCompletionCount : null;
      const lastCompletionCount = lastCompletionCountByThread.get(threadId) ?? null;
      // A null baseline means this is the first event we've seen for the
      // thread (e.g. right after an MCP restart) — record it without treating
      // it as fresh, or every idle thread parked in "review" would page on
      // startup.
      const freshCompletion =
        completionCount !== null &&
        completionCount > 0 &&
        lastCompletionCount !== null &&
        completionCount !== lastCompletionCount;
      if (completionCount !== null) {
        lastCompletionCountByThread.set(threadId, completionCount);
      }
      if (state === prev && !(freshCompletion && state === "review")) {
        return; // dedupe non-transitions
      }
      lastStateByThread.set(threadId, state);

      // Any transition invalidates a pending hold — if we were waiting to
      // forward a state that already moved on, it was churn, not a signal.
      const pending = pendingTimers.get(threadId);
      if (pending) {
        clearTimeout(pending);
        pendingTimers.delete(threadId);
      }

      const stableMs = stabilizationMsFor(state, ev.cliKind);
      if (stableMs === null) {
        options.forward({ threadId, state, ev });
        return;
      }
      const timer = setTimeout(() => {
        pendingTimers.delete(threadId);
        // Re-check the current state; only forward if it stuck.
        if (lastStateByThread.get(threadId) === state) {
          options.forward({ threadId, state, ev });
        }
      }, stableMs);
      pendingTimers.set(threadId, timer);
    },
    dispose(): void {
      for (const timer of pendingTimers.values()) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      lastStateByThread.clear();
      lastCompletionCountByThread.clear();
    },
  };
}

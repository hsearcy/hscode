import type { TerminalEvent } from "@t3tools/contracts";
import type { TerminalActivityState } from "@t3tools/shared/terminalThreads";

export interface TerminalActivityUpdate {
  agentState: TerminalActivityState | null;
  hasRunningSubprocess: boolean;
  /**
   * Monotonic completed-turn count from the server (bumped on every Stop
   * hook). Null when the event doesn't carry one. Lets consumers detect a
   * fresh completion even when agentState reads "review" both before and
   * after the turn (stale-state case).
   */
  turnCompletionCount: number | null;
}

export function terminalActivityFromEvent(event: TerminalEvent): TerminalActivityUpdate | null {
  switch (event.type) {
    case "activity":
      return {
        hasRunningSubprocess: event.hasRunningSubprocess,
        agentState: event.agentState,
        turnCompletionCount: event.turnCompletionCount ?? null,
      };
    case "started":
    case "restarted":
    case "exited":
      return {
        hasRunningSubprocess: false,
        agentState: null,
        turnCompletionCount: null,
      };
    default:
      return null;
  }
}

// FILE: useThreadEffectiveCwd.ts
// Purpose: Single source of truth for a thread's effective working directory,
//   consolidating the worktree-resolution logic that was previously copy-pasted
//   across ChatView, DiffPanel, and GitActionsControl. Precedence:
//     1. manual override  (explicit pick from the diff panel's worktree switcher)
//     2. agent-reported cwd (a worktree the CLI created itself, outside the project)
//     3. the thread's stored worktree path
// Layer: Web client hook
// Exports: useThreadEffectiveCwd

import type { ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";
import { useCliSessionMetaStore } from "../cliSessionMetaStore";

export interface ThreadEffectiveCwd {
  // Explicit user override from the worktree switcher (highest precedence), or null.
  manualCwd: string | null;
  setManualCwd: (cwd: string | null) => void;
  // Latest agent-reported cwd for the thread, or null.
  agentReportedCwd: string | null;
  clearAgentReportedCwd: () => void;
  // True when the agent-reported cwd points outside the project tree.
  agentReportedCwdIsOutsideProject: boolean;
  // Worktree path for auto-resolution (agent override applied, manual override NOT):
  // callers layer the manual override on top so it wins uniformly.
  autoWorktreePath: string | null;
}

export function useThreadEffectiveCwd(input: {
  threadId: ThreadId | null;
  projectCwd: string | null;
  threadWorktreePath: string | null;
}): ThreadEffectiveCwd {
  const { threadId, projectCwd, threadWorktreePath } = input;

  const agentReportedCwd = useCliSessionMetaStore((store) =>
    threadId ? (store.cwdByThreadId[threadId] ?? null) : null,
  );
  const manualCwd = useCliSessionMetaStore((store) =>
    threadId ? (store.manualCwdByThreadId[threadId] ?? null) : null,
  );
  const setManualCwdAction = useCliSessionMetaStore((store) => store.setManualCwd);
  const setThreadCwdAction = useCliSessionMetaStore((store) => store.setThreadCwd);

  const agentReportedCwdIsOutsideProject =
    agentReportedCwd !== null &&
    projectCwd !== null &&
    agentReportedCwd !== projectCwd &&
    !agentReportedCwd.startsWith(`${projectCwd}/`);

  // The agent-reported cwd only overrides when the thread has no stored worktree
  // of its own — a thread-managed worktree always wins over an ad-hoc one.
  const autoWorktreePath =
    threadWorktreePath === null && agentReportedCwdIsOutsideProject
      ? agentReportedCwd
      : threadWorktreePath;

  const setManualCwd = useCallback(
    (cwd: string | null) => {
      if (!threadId) return;
      setManualCwdAction(threadId, cwd);
    },
    [threadId, setManualCwdAction],
  );
  const clearAgentReportedCwd = useCallback(() => {
    if (!threadId) return;
    setThreadCwdAction(threadId, null);
  }, [threadId, setThreadCwdAction]);

  return {
    manualCwd,
    setManualCwd,
    agentReportedCwd,
    clearAgentReportedCwd,
    agentReportedCwdIsOutsideProject,
    autoWorktreePath,
  };
}

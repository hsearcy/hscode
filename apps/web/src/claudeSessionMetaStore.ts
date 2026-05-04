// FILE: claudeSessionMetaStore.ts
// Purpose: Track the latest Claude-reported working directory per thread so the
//   diff panel can follow Claude into worktrees it created on its own (i.e.
//   not via DP-Code-managed worktree provisioning).
// Layer: Web client state
// Exports: useClaudeSessionMetaStore zustand store

import { create } from "zustand";

interface ClaudeSessionMetaStore {
  cwdByThreadId: Record<string, string>;
  setThreadCwd: (threadId: string, cwd: string | null) => void;
}

export const useClaudeSessionMetaStore = create<ClaudeSessionMetaStore>((set) => ({
  cwdByThreadId: {},
  setThreadCwd: (threadId, cwd) =>
    set((state) => {
      const current = state.cwdByThreadId[threadId] ?? null;
      const next = cwd ?? null;
      if (current === next) {
        return state;
      }
      const cwdByThreadId = { ...state.cwdByThreadId };
      if (next === null) {
        delete cwdByThreadId[threadId];
      } else {
        cwdByThreadId[threadId] = next;
      }
      return { cwdByThreadId };
    }),
}));

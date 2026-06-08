// FILE: cliSessionMetaStore.ts
// Purpose: Track per-thread diff-source state: the latest agent-reported working
//   directory (so the diff panel can follow a CLI into worktrees it created on
//   its own) and an explicit, user-chosen manual worktree override that takes
//   precedence over all auto-detection when the panel guesses wrong.
// Layer: Web client state
// Exports: useCliSessionMetaStore zustand store

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface CliSessionMetaStore {
  // Agent-reported cwd (auto-detected, in-memory only).
  cwdByThreadId: Record<string, string>;
  // Explicit user override picked from the diff panel's worktree switcher.
  // Persisted so a manual correction survives reloads/reconnects.
  manualCwdByThreadId: Record<string, string>;
  setThreadCwd: (threadId: string, cwd: string | null) => void;
  setManualCwd: (threadId: string, cwd: string | null) => void;
}

function assignThreadCwd(
  map: Record<string, string>,
  threadId: string,
  cwd: string | null,
): Record<string, string> | null {
  const current = map[threadId] ?? null;
  const next = cwd ?? null;
  if (current === next) {
    return null;
  }
  const updated = { ...map };
  if (next === null) {
    delete updated[threadId];
  } else {
    updated[threadId] = next;
  }
  return updated;
}

const MANUAL_DIFF_CWD_STORAGE_KEY = "hscode:diff-manual-cwd:v1";

export const useCliSessionMetaStore = create<CliSessionMetaStore>()(
  persist(
    (set) => ({
      cwdByThreadId: {},
      manualCwdByThreadId: {},
      setThreadCwd: (threadId, cwd) =>
        set((state) => {
          const cwdByThreadId = assignThreadCwd(state.cwdByThreadId, threadId, cwd);
          return cwdByThreadId ? { cwdByThreadId } : state;
        }),
      setManualCwd: (threadId, cwd) =>
        set((state) => {
          const manualCwdByThreadId = assignThreadCwd(state.manualCwdByThreadId, threadId, cwd);
          return manualCwdByThreadId ? { manualCwdByThreadId } : state;
        }),
    }),
    {
      name: MANUAL_DIFF_CWD_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Only the explicit user override is durable; agent-reported cwd stays in-memory.
      partialize: (state) => ({ manualCwdByThreadId: state.manualCwdByThreadId }),
    },
  ),
);

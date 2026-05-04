// Per-thread "last terminal user input at" timestamps. Terminal-cli threads
// have no chat messages, so the sidebar's "last user message" sort would
// otherwise pin them at thread creation time. Recording when the user types
// into a terminal lets the sort reflect actual recent activity.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const STORAGE_KEY = "t3tools.terminalActivity";
const THROTTLE_MS = 1000;

interface TerminalActivityState {
  lastInputAtByThreadId: Record<string, string>;
  recordTerminalUserInput: (threadId: string) => void;
}

const lastFlushAtByThreadId = new Map<string, number>();

export const useTerminalActivityStore = create<TerminalActivityState>()(
  persist(
    (set) => ({
      lastInputAtByThreadId: {},
      recordTerminalUserInput: (threadId) => {
        const now = Date.now();
        const previous = lastFlushAtByThreadId.get(threadId);
        if (previous !== undefined && now - previous < THROTTLE_MS) {
          return;
        }
        lastFlushAtByThreadId.set(threadId, now);
        const iso = new Date(now).toISOString();
        set((state) => ({
          lastInputAtByThreadId: {
            ...state.lastInputAtByThreadId,
            [threadId]: iso,
          },
        }));
      },
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        lastInputAtByThreadId: state.lastInputAtByThreadId,
      }),
    },
  ),
);

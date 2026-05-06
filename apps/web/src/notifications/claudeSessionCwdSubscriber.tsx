// FILE: claudeSessionCwdSubscriber.tsx
// Purpose: Subscribe to terminal events globally and forward Claude-reported
//   cwd updates into the claudeSessionMetaStore so the diff panel can follow
//   Claude into worktrees it spawned on its own.
// Layer: Web client runtime
// Exports: ClaudeSessionCwdSubscriber

import { useEffect } from "react";
import { readNativeApi } from "../nativeApi";
import { useClaudeSessionMetaStore } from "../claudeSessionMetaStore";

export function ClaudeSessionCwdSubscriber() {
  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      return;
    }
    const unsubscribe = api.terminal.onEvent((event) => {
      if (event.type !== "claude-session") {
        return;
      }
      useClaudeSessionMetaStore.getState().setThreadCwd(event.threadId, event.cwd);
    });
    return () => {
      unsubscribe();
    };
  }, []);
  return null;
}

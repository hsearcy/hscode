// FILE: cliSessionCwdSubscriber.tsx
// Purpose: Subscribe to terminal events globally and forward agent-reported
//   cwd updates into the cliSessionMetaStore so the diff panel can follow a
//   CLI (Claude or Codex) into worktrees it spawned on its own.
// Layer: Web client runtime
// Exports: CliSessionCwdSubscriber

import { useEffect } from "react";
import { readNativeApi } from "../nativeApi";
import { useCliSessionMetaStore } from "../cliSessionMetaStore";

export function CliSessionCwdSubscriber() {
  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      return;
    }
    const unsubscribe = api.terminal.onEvent((event) => {
      if (event.type !== "cli-session") {
        return;
      }
      useCliSessionMetaStore.getState().setThreadCwd(event.threadId, event.cwd);
    });
    return () => {
      unsubscribe();
    };
  }, []);
  return null;
}

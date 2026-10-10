// FILE: useCreateSiblingTerminalThread.ts
// Purpose: Creates a terminal-only thread beside an existing thread without routing to it.
// Layer: Web hooks
// Depends on: useHandleNewThread background creation and the shared sibling-context resolver.

import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { toastManager } from "../components/ui/toast";
import { resolveSiblingThreadContextOptions } from "../lib/threadBootstrap";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { useHandleNewThread } from "./useHandleNewThread";

// The new terminal opens in the source thread's project, branch, and worktree. Split
// surfaces place the returned thread into a pane themselves.
export function useCreateSiblingTerminalThread() {
  const { handleNewThread } = useHandleNewThread();

  return useCallback(
    async (input: {
      sourceThreadId: ThreadId | null;
      fallbackProjectId: ProjectId | null;
    }): Promise<ThreadId | null> => {
      const thread = input.sourceThreadId
        ? getThreadFromState(useStore.getState(), input.sourceThreadId)
        : undefined;
      const draftThread = input.sourceThreadId
        ? useComposerDraftStore.getState().getDraftThread(input.sourceThreadId)
        : null;
      const projectId = thread?.projectId ?? draftThread?.projectId ?? input.fallbackProjectId;
      if (!projectId) {
        return null;
      }
      try {
        return await handleNewThread(projectId, {
          ...resolveSiblingThreadContextOptions({ thread, draftThread }),
          entryPoint: "terminal",
          background: true,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not open terminal",
          description: error instanceof Error ? error.message : "Unable to create the terminal.",
        });
        return null;
      }
    },
    [handleNewThread],
  );
}

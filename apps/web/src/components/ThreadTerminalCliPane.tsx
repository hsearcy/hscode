import type { TerminalActivityUpdate } from "../terminalActivity";
// FILE: ThreadTerminalCliPane.tsx
// Purpose: Renders a single persistent PTY viewport for a terminal-cli thread.
// Layer: Chat surface (terminal-cli mode)
// Depends on: terminalRuntimeRegistry for PTY lifecycle, store selectors for project cwd.

import { useEffect, useMemo, useRef } from "react";

import type { ThreadId } from "@t3tools/contracts";
import {
  type TerminalCliKind,
  defaultTerminalTitleForCliKind,
} from "@t3tools/shared/terminalThreads";

import { useStore } from "../store";
import { createProjectSelector, createThreadSelector } from "../storeSelectors";
import { useTerminalStateStore } from "../terminalStateStore";
import {
  buildTerminalRuntimeKey,
  terminalRuntimeRegistry,
} from "./terminal/terminalRuntimeRegistry";
import type {
  TerminalRuntimeConfig,
  TerminalRuntimeViewState,
} from "./terminal/terminalRuntimeTypes";

const TERMINAL_ID = "default";

interface ThreadTerminalCliPaneProps {
  threadId: ThreadId;
}

export default function ThreadTerminalCliPane({ threadId }: ThreadTerminalCliPaneProps) {
  const selectThread = useMemo(() => createThreadSelector(threadId), [threadId]);
  const thread = useStore(selectThread);
  const selectProject = useMemo(
    () => createProjectSelector(thread?.projectId ?? null),
    [thread?.projectId],
  );
  const project = useStore(selectProject);
  const cwd = project?.cwd ?? "";
  const cliKind: TerminalCliKind | null = thread?.cliKind ?? null;
  const terminalLabel = cliKind ? defaultTerminalTitleForCliKind(cliKind) : "Terminal";

  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeKey = useMemo(() => buildTerminalRuntimeKey(threadId, TERMINAL_ID), [threadId]);

  const setTerminalMetadata = useTerminalStateStore((s) => s.setTerminalMetadata);
  const setTerminalActivity = useTerminalStateStore((s) => s.setTerminalActivity);

  const runtimeConfig = useMemo<TerminalRuntimeConfig>(
    () => ({
      runtimeKey,
      threadId,
      terminalId: TERMINAL_ID,
      terminalLabel,
      terminalCliKind: cliKind,
      cwd,
      callbacks: {
        onSessionExited: () => {},
        onTerminalMetadataChange: (
          terminalId: string,
          metadata: { cliKind: TerminalCliKind | null; label: string },
        ) => {
          setTerminalMetadata(threadId, terminalId, metadata);
        },
        onTerminalActivityChange: (terminalId: string, activity: TerminalActivityUpdate) => {
          setTerminalActivity(threadId, terminalId, activity);
        },
      },
    }),
    [cliKind, cwd, runtimeKey, setTerminalActivity, setTerminalMetadata, terminalLabel, threadId],
  );

  const runtimeConfigRef = useRef(runtimeConfig);
  useEffect(() => {
    runtimeConfigRef.current = runtimeConfig;
  }, [runtimeConfig]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount || !cwd) return;
    const viewState: TerminalRuntimeViewState = { autoFocus: true, isVisible: true };
    terminalRuntimeRegistry.attach(runtimeConfigRef.current, viewState, mount);
    return () => {
      terminalRuntimeRegistry.detach(runtimeKey);
    };
  }, [cwd, runtimeKey]);

  useEffect(() => {
    terminalRuntimeRegistry.syncConfig(runtimeKey, runtimeConfig);
  }, [runtimeConfig, runtimeKey]);

  return (
    <div className="h-full min-h-0 w-full bg-background p-3">
      <div className="relative h-full min-h-0 w-full overflow-hidden">
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}

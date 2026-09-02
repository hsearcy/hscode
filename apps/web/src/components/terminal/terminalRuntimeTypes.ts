import type { TerminalActivityUpdate } from "../../terminalActivity";
// FILE: terminalRuntimeTypes.ts
// Purpose: Shared types and stable identity helpers for persistent terminal runtimes.
// Layer: Terminal runtime infrastructure

import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { type TerminalCliKind } from "@t3tools/shared/terminalThreads";
import { Terminal, type IDisposable } from "@xterm/xterm";

export interface TerminalRuntimeCallbacks {
  onSessionExited: () => void;
  onTerminalMetadataChange: (
    terminalId: string,
    metadata: { cliKind: TerminalCliKind | null; label: string },
  ) => void;
  onTerminalActivityChange: (terminalId: string, activity: TerminalActivityUpdate) => void;
}

export function buildTerminalRuntimeKey(threadId: string, terminalId: string): string {
  return `${threadId}::${terminalId}`;
}

export interface TerminalRuntimeConfig {
  runtimeKey: string;
  threadId: string;
  terminalId: string;
  terminalLabel: string;
  terminalCliKind?: TerminalCliKind | null;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  callbacks: TerminalRuntimeCallbacks;
}

export interface TerminalRuntimeViewState {
  autoFocus: boolean;
  isVisible: boolean;
}

export interface TerminalRuntimeEntry {
  runtimeKey: string;
  threadId: string;
  terminalId: string;
  terminalLabel: string;
  terminalCliKind: TerminalCliKind | null;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  callbacks: TerminalRuntimeCallbacks;
  wrapper: HTMLDivElement;
  container: HTMLDivElement | null;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  webglAddon: WebglAddon | null;
  canvasAddon: CanvasAddon | null;
  outputIdentityBuffer: string;
  titleInputBuffer: string;
  hasHandledExit: boolean;
  /**
   * True after the server slept this session's PTY for being idle. The next
   * user keystroke (or a fresh attach) re-opens the terminal, which respawns
   * the shell and auto-resumes the CLI.
   */
  slept: boolean;
  /**
   * Timer that drops the resumed CLI's transcript repaint out of scrollback
   * once the wake burst settles, or null when no wake is in progress.
   */
  resumeTrimTimer: number | null;
  /** Wall-clock ms after which the wake window closes untrimmed. */
  resumeTrimDeadline: number;
  opened: boolean;
  disposed: boolean;
  resizeObserver: ResizeObserver | null;
  resizeDispatchTimer: number | null;
  visualResizeFrame: number | null;
  visualResizeTimer: number | null;
  lastVisualResizeAt: number;
  lastSentResize: { cols: number; rows: number } | null;
  pendingResize: { cols: number; rows: number } | null;
  writeRafHandle: number | null;
  writeFlushTimeout: number | null;
  pendingWrites: string[];
  pendingWriteLength: number;
  deferredWrites: string[];
  deferredWriteLength: number;
  webglLoadFrame: number | null;
  themeRefreshFrame: number;
  themeObserver: MutationObserver | null;
  visibilityCleanup: (() => void) | null;
  terminalDisposables: IDisposable[];
  attachDisposables: Array<() => void>;
  persistentDisposables: Array<() => void>;
  querySuppressionDispose: (() => void) | null;
  viewState: TerminalRuntimeViewState;
  unsubscribeTerminalEvents: (() => void) | null;
}

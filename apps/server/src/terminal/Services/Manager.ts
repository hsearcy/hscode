/**
 * TerminalManager - Terminal session orchestration service interface.
 *
 * Owns terminal lifecycle operations, output fanout, and session state
 * transitions for thread-scoped terminals.
 *
 * @module TerminalManager
 */
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
  TerminalWriteInput,
} from "@t3tools/contracts";

/**
 * Lightweight read-only view of a terminal session's runtime activity.
 *
 * Returned by `getSessionActivity` so callers can decide whether the PTY is
 * idle at a shell prompt or already busy running a managed CLI.
 */
export interface TerminalSessionActivity {
  status: TerminalSessionStatus;
  hasRunningSubprocess: boolean;
  detectedCliKind: TerminalCliKind | null;
  managedAgentRunning: boolean;
  managedAgentObserved: boolean;
}
import type { TerminalActivityState, TerminalCliKind } from "@t3tools/shared/terminalThreads";
import { PtyProcess } from "./PTY";
import { Effect, Schema, ServiceMap } from "effect";

export class TerminalError extends Schema.TaggedErrorClass<TerminalError>()("TerminalError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  /**
   * The cwd most recently requested by the client (typically the workspace root).
   * Used to detect when the client has switched workspaces and the shell needs to
   * be respawned, independent of session.cwd which we may seed from a persisted
   * post-cd directory so the user lands back where they last were.
   */
  requestedCwd: string;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  historyLineBreakCount: number;
  historyEndsWithNewline: boolean;
  pendingHistoryControlSequence: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  cols: number;
  rows: number;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  detectedCliKind: TerminalCliKind | null;
  managedAgentRunning: boolean;
  managedAgentState: TerminalActivityState | null;
  /** True once at least one hook event (Start/Stop/PermissionRequest) has been observed. */
  managedAgentObserved: boolean;
  runtimeEnv: Record<string, string> | null;
  /** Buffered shell input used to detect canonical CLI commands at submit time. */
  pendingInputBuffer: string;
  /** Buffered output chunks awaiting flush (output batching). */
  pendingOutputChunks: string[];
  /** Total code-unit length of buffered output chunks. */
  pendingOutputLength: number;
  /** Timer handle for the next scheduled output flush. */
  outputFlushTimer: ReturnType<typeof setTimeout> | null;
  /** Whether PTY reading has been paused due to backpressure. */
  outputPaused: boolean;
  /** Latest wall-clock timestamp when the user wrote to this PTY. */
  lastInputAt: number | null;
  /** Latest wall-clock timestamp when the PTY emitted output. */
  lastOutputAt: number | null;
  /** Normalized visible output used to ignore redraw-only PTY noise. */
  lastOutputSignature: string | null;
  /**
   * Side-channel file the managed hook appends OSC event lines to, kept off
   * the PTY data path so hook signalling never interleaves with — and
   * corrupts — the CLI's TUI frames. Null for unmanaged sessions.
   */
  eventSinkPath: string | null;
  /** Disposes the fs.watch handle on the event sink file. */
  eventSinkWatcher: (() => void) | null;
  /** Byte offset already consumed from the event sink file. */
  eventSinkOffset: number;
  /** Buffered partial line carried between event sink reads. */
  eventSinkBuffer: string;
}

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

/**
 * TerminalManagerShape - Service API for terminal session lifecycle operations.
 */
export interface TerminalManagerShape {
  /**
   * Open or attach to a terminal session.
   *
   * Reuses an existing session for the same thread/terminal id and restores
   * persisted history on first open.
   */
  readonly open: (
    input: TerminalOpenInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  /**
   * Write input bytes to a terminal session.
   */
  readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

  /**
   * Resize the PTY backing a terminal session.
   */
  readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

  /**
   * Clear terminal output history.
   */
  readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

  /**
   * Restart a terminal session in place.
   *
   * Always resets history before spawning the new process.
   */
  readonly restart: (
    input: TerminalRestartInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  /**
   * Close an active terminal session.
   *
   * When `terminalId` is omitted, closes all sessions for the thread.
   */
  readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

  /**
   * Read the live activity state of a session, or null if it is not open.
   *
   * Used to avoid sending a fresh "claude --resume" command into a PTY that is
   * already mid-turn — if Claude is running we'd otherwise type the command
   * straight into its prompt.
   */
  readonly getSessionActivity: (
    threadId: string,
    terminalId: string,
  ) => Effect.Effect<TerminalSessionActivity | null>;

  /**
   * Returns true exactly once if the most recent `open()` for this session
   * actually spawned a new PTY (vs attaching to an existing one). Used by
   * auto-launch logic to avoid injecting `claude --resume` into a live TUI.
   */
  readonly consumeWasNewlySpawned: (threadId: string, terminalId: string) => Effect.Effect<boolean>;

  /**
   * Subscribe to terminal runtime events.
   */
  readonly subscribe: (listener: (event: TerminalEvent) => void) => Effect.Effect<() => void>;

  /**
   * Dispose all managed terminal resources.
   */
  readonly dispose: Effect.Effect<void>;
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends ServiceMap.Service<TerminalManager, TerminalManagerShape>()(
  "t3/terminal/Services/Manager/TerminalManager",
) {}

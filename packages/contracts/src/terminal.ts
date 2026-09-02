import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const DEFAULT_TERMINAL_ID = "default";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const TerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(20)).check(
  Schema.isLessThanOrEqualTo(400),
);
const TerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(5)).check(
  Schema.isLessThanOrEqualTo(200),
);
const TerminalIdSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));
const TerminalEnvKeySchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
).check(Schema.isMaxLength(128));
const TerminalEnvValueSchema = Schema.String.check(Schema.isMaxLength(8_192));
const TerminalEnvSchema = Schema.Record(TerminalEnvKeySchema, TerminalEnvValueSchema).check(
  Schema.isMaxProperties(128),
);

const TerminalIdWithDefaultSchema = TerminalIdSchema.pipe(
  Schema.withDecodingDefault(() => DEFAULT_TERMINAL_ID),
);

export const TerminalThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type TerminalThreadInput = Schema.Codec.Encoded<typeof TerminalThreadInput>;

const TerminalSessionInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: TerminalIdWithDefaultSchema,
});
export type TerminalSessionInput = Schema.Codec.Encoded<typeof TerminalSessionInput>;

export const TerminalOpenInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
  // When false, peek/attach only: never spawn or wake a PTY. A missing or
  // slept session returns its persisted snapshot instead of respawning, so
  // read-only consumers (read_thread, screen renders) don't undo idle sleep.
  wake: Schema.optional(Schema.Boolean),
});
export type TerminalOpenInput = Schema.Codec.Encoded<typeof TerminalOpenInput>;

export const TerminalWriteInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type TerminalWriteInput = Schema.Codec.Encoded<typeof TerminalWriteInput>;

export const TerminalResizeInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export type TerminalResizeInput = Schema.Codec.Encoded<typeof TerminalResizeInput>;

export const TerminalClearInput = TerminalSessionInput;
export type TerminalClearInput = Schema.Codec.Encoded<typeof TerminalClearInput>;

export const TerminalRestartInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  env: Schema.optional(TerminalEnvSchema),
});
export type TerminalRestartInput = Schema.Codec.Encoded<typeof TerminalRestartInput>;

export const TerminalCloseInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: Schema.optional(TerminalIdSchema),
  deleteHistory: Schema.optional(Schema.Boolean),
});
export type TerminalCloseInput = Schema.Codec.Encoded<typeof TerminalCloseInput>;

// "slept": the PTY was stopped by the idle-sleep policy but the session's
// history and CLI session id are intact — the next wake-enabled open()
// respawns the shell and auto-resumes the CLI.
export const TerminalSessionStatus = Schema.Literals([
  "starting",
  "running",
  "exited",
  "error",
  "slept",
]);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

export const TerminalSessionSnapshot = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  history: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  updatedAt: Schema.String,
  // True when this open() respawned the PTY for a session the idle-sleep
  // policy had stopped. The resume command has been typed into the fresh
  // shell, but the CLI may still be booting — callers that immediately write
  // input should wait for the TUI to come up.
  wokeFromSleep: Schema.optional(Schema.Boolean),
  // True when this open() auto-typed the CLI resume command. The CLI answers
  // by repainting its whole transcript, so clients should expect a burst of
  // output that supersedes the history in this snapshot.
  resumeCommandSent: Schema.optional(Schema.Boolean),
});
export type TerminalSessionSnapshot = typeof TerminalSessionSnapshot.Type;

const TerminalEventBaseSchema = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  createdAt: Schema.String,
});

const TerminalStartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("started"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalOutputEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const TerminalExitedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const TerminalErrorEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const TerminalClearedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("cleared"),
});

const TerminalRestartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("restarted"),
  snapshot: TerminalSessionSnapshot,
});

// Emitted when the idle-sleep policy stops a session's PTY. Distinct from
// "exited" so clients render a sleep notice instead of a crash banner and
// know the session will auto-resume on the next wake-enabled open().
const TerminalSleptEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("slept"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalActivityEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
  // Monotonic count of completed agent turns (Stop hook events) for this
  // terminal session. Lets subscribers detect a fresh turn completion even
  // when agentState reads "review" both before and after the turn — the
  // state level can be stale (e.g. a lost Start signal) while the completion
  // edge is still real. Optional so older peers keep decoding.
  turnCompletionCount: Schema.optional(Schema.Int),
  cliKind: Schema.NullOr(
    Schema.Union([Schema.Literal("codex"), Schema.Literal("claude"), Schema.Literal("claudex")]),
  ),
  agentState: Schema.NullOr(
    Schema.Union([
      Schema.Literal("running"),
      Schema.Literal("attention"),
      Schema.Literal("review"),
    ]),
  ),
});

// Emitted whenever a managed CLI (Claude or Codex) reports its live session
// identity and the working directory of its most recent edit. `sessionId` is
// nullable because Codex surfaces a cwd update before (or without) a stable
// session id, and only Claude needs the id for `--resume`.
const TerminalCliSessionEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("cli-session"),
  cliKind: Schema.Union([
    Schema.Literal("codex"),
    Schema.Literal("claude"),
    Schema.Literal("claudex"),
  ]),
  sessionId: Schema.NullOr(Schema.String.check(Schema.isNonEmpty())),
  summary: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
});

export const TerminalEvent = Schema.Union([
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalSleptEvent,
  TerminalActivityEvent,
  TerminalCliSessionEvent,
]);
export type TerminalEvent = typeof TerminalEvent.Type;

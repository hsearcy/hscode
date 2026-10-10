import { Schema } from "effect";
import { ProjectId, ThreadId } from "./baseSchemas";

export const CommandThreadStatus = Schema.Literals([
  "attention",
  "working",
  "review",
  "asleep",
  "idle",
  "error",
]);
export type CommandThreadStatus = typeof CommandThreadStatus.Type;

export const CommandThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  projectTitle: Schema.String,
  title: Schema.String,
  agent: Schema.String,
  cwd: Schema.String,
  status: CommandThreadStatus,
  statusVersion: Schema.optional(Schema.String),
  reviewAt: Schema.optional(Schema.String),
  lastActivityAt: Schema.String,
  response: Schema.NullOr(Schema.String),
  responseAt: Schema.NullOr(Schema.String),
  responseTruncated: Schema.Boolean,
});
export type CommandThread = typeof CommandThread.Type;

export const CommandViewSnapshot = Schema.Struct({
  threads: Schema.Array(CommandThread),
  totalThreads: Schema.Int,
  generatedAt: Schema.String,
});
export type CommandViewSnapshot = typeof CommandViewSnapshot.Type;

import { glob, open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexSessionMetadataReader } from "./codexSessionMetadata";

// Reads what a CLI session saved to its own transcript (Claude/Grok JSONL,
// Codex rollout). Unlike a PTY replay, this is the exact text the CLI showed,
// independent of terminal width or history truncation.

export interface SavedTurnActivity {
  state: "working" | "review";
  at: string;
}
export interface SavedResponse {
  text: string;
  at: string | null;
  truncated: boolean;
  activity?: SavedTurnActivity | null;
}
const MAX_RESPONSE_LENGTH = 12_000;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_LAST_TURN_READ_BYTES = 16 * 1024 * 1024;

export function parseLastTurnActivity(content: string, kind: string): SavedTurnActivity | null {
  const lines = content.slice(0, content.lastIndexOf("\n") + 1).split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const record = JSON.parse(lines[index]!);
      if (!Number.isFinite(Date.parse(record.timestamp))) continue;
      if (kind === "codex") {
        const payload = record.payload;
        if (
          record.type === "event_msg" &&
          ["task_complete", "turn_aborted"].includes(payload?.type)
        )
          return { state: "review", at: record.timestamp };
        if (
          record.type === "response_item" &&
          payload?.role === "assistant" &&
          payload.phase === "final_answer"
        )
          return { state: "review", at: record.timestamp };
        if (
          (record.type === "event_msg" && payload?.type === "task_started") ||
          record.type === "response_item"
        )
          return { state: "working", at: record.timestamp };
      } else if (kind === "claude" || kind === "claudex") {
        if (
          record.type === "system" &&
          ["turn_duration", "stop_hook_summary"].includes(record.subtype)
        )
          return { state: "review", at: record.timestamp };
        if (record.type === "assistant")
          return {
            state: ["end_turn", "stop_sequence"].includes(record.message?.stop_reason)
              ? "review"
              : "working",
            at: record.timestamp,
          };
        if (record.type === "user") return { state: "working", at: record.timestamp };
      }
    } catch {
      /* Ignore incomplete records. */
    }
  }
  return null;
}

export function parseLastResponse(content: string, kind: string): SavedResponse | null {
  const lines = content.slice(0, content.lastIndexOf("\n") + 1).split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const record = JSON.parse(lines[index]!);
      const text = assistantText(record, kind);
      if (text === null) continue;
      return {
        text: text.slice(0, MAX_RESPONSE_LENGTH),
        at: timestampOf(record),
        truncated: text.length > MAX_RESPONSE_LENGTH,
        activity: parseLastTurnActivity(content, kind),
      };
    } catch {
      /* Partial or malformed records do not hide earlier responses. */
    }
  }
  return null;
}

export class LastResponseReader {
  private cache = new Map<
    string,
    { version: string; inode: number; size: number; response: SavedResponse | null }
  >();

  async read(file: string, kind: string): Promise<SavedResponse | null> {
    try {
      const info = await stat(file);
      const version = `${info.ino}:${info.size}:${info.mtimeMs}`;
      const key = `${kind}:${file}`;
      const cached = this.cache.get(key);
      if (cached?.version === version) return cached.response;
      const { text } = await readTranscriptTail(file, info.size);
      let response = parseLastResponse(text, kind);
      const activity = response?.activity ?? parseLastTurnActivity(text, kind);
      // Keep the last known response if tool output has pushed it out of the tail.
      if (!response && cached && info.ino === cached.inode && info.size > cached.size)
        response = cached.response
          ? { ...cached.response, activity: activity ?? cached.response.activity ?? null }
          : null;
      if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { version, inode: info.ino, size: info.size, response });
      return response;
    } catch {
      return null;
    }
  }
}

// Tail of the transcript, starting at a record boundary.
async function readTranscriptTail(
  file: string,
  size: number,
  maxBytes = MAX_READ_BYTES,
): Promise<{ text: string; partial: boolean }> {
  const handle = await open(file, "r");
  try {
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return { text: start > 0 ? text.slice(text.indexOf("\n") + 1) : text, partial: start > 0 };
  } finally {
    await handle.close();
  }
}

function joinText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part: { type?: string; text?: unknown }) =>
        (part?.type === "text" || part?.type === "output_text") && typeof part.text === "string",
    )
    .map((part: { text: string }) => part.text)
    .join("\n\n");
}

/** Visible assistant text of one transcript record, or null (tools, reasoning, other roles). */
function assistantText(record: any, kind: string): string | null {
  const message =
    kind === "codex"
      ? record.type === "response_item"
        ? record.payload
        : null
      : kind === "grok"
        ? record
        : record.message;
  if (!message || (message.role ?? message.type) !== "assistant") return null;
  if (record.isSidechain) return null;
  const text = joinText(message.content).trim();
  return text ? text : null;
}

// Harness-injected "user" records that the person never typed.
const INJECTED_USER_TEXT =
  /^\s*(<(task-notification|system-reminder|local-command-[a-z]+|bash-stdout|bash-stderr)>|\[Request interrupted by user)/;

/** Text the person actually submitted in this record, or null. */
function submittedPromptText(record: any, kind: string): string | null {
  let content: unknown;
  if (kind === "codex") {
    // Rollout user response_items also carry injected AGENTS.md/environment
    // context. These events hold exactly what was typed: `user_message` in
    // older Codex, a completed `UserMessage` item in newer Codex.
    if (record.type !== "event_msg") return null;
    if (record.payload?.type === "user_message") content = record.payload.message;
    else if (
      record.payload?.type === "item_completed" &&
      record.payload.item?.type === "UserMessage"
    )
      content = record.payload.item.content;
    else return null;
  } else if (kind === "grok") {
    if ((record.role ?? record.type) !== "user") return null;
    // Grok wraps typed prompts in <user_query>; other user records are
    // injected (<user_info>, <system-reminder>, images from tool results).
    const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(joinText(record.content));
    content = query ? query[1] : null;
  } else {
    if (record.type !== "user" || record.isMeta || record.isSidechain) return null;
    content = record.message?.content;
    if (Array.isArray(content) && content.some((part) => part?.type === "tool_result")) return null;
  }
  const text = joinText(content).trim();
  return text && !INJECTED_USER_TEXT.test(text) ? text : null;
}

export interface TranscriptEntry {
  text: string;
  at: string | null;
}
export interface SavedTurn {
  /** Last prompt the person submitted. A composer draft never appears here. */
  prompt: TranscriptEntry | null;
  /** Every assistant message after that prompt, oldest first. */
  responses: TranscriptEntry[];
  /** True when older responses (or the prompt) were dropped to fit `maxLength`. */
  truncated: boolean;
}

function timestampOf(record: any): string | null {
  return typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp))
    ? record.timestamp
    : null;
}

/**
 * The latest turn: the last submitted prompt and all assistant text after it.
 * Background notifications and tool results do not end a turn, so replies to
 * them stay attached to the prompt that started the work.
 */
export function parseLastTurn(content: string, kind: string, maxLength = 60_000): SavedTurn {
  const lines = content.slice(0, content.lastIndexOf("\n") + 1).split("\n");
  const responses: TranscriptEntry[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    let record: any;
    try {
      record = JSON.parse(lines[index]!);
    } catch {
      continue; // Partial or malformed records do not hide earlier entries.
    }
    const prompt = submittedPromptText(record, kind);
    if (prompt !== null) {
      return { prompt: { text: prompt, at: timestampOf(record) }, responses, truncated: false };
    }
    const text = assistantText(record, kind);
    if (text === null) continue;
    if (used + text.length > maxLength) return { prompt: null, responses, truncated: true };
    used += text.length;
    responses.unshift({ text, at: timestampOf(record) });
  }
  return { prompt: null, responses, truncated: false };
}

export async function readLastTurn(file: string, kind: string): Promise<SavedTurn | null> {
  try {
    const info = await stat(file);
    const tail = await readTranscriptTail(file, info.size);
    let turn = parseLastTurn(tail.text, kind);
    if (turn.prompt !== null || turn.truncated || !tail.partial) return turn;
    // Long tool output can push the prompt out of the usual tail; look
    // further back once before giving up.
    const wide = await readTranscriptTail(file, info.size, MAX_LAST_TURN_READ_BYTES);
    turn = parseLastTurn(wide.text, kind);
    // A prompt older than what we read means earlier responses may be missing.
    return turn.prompt === null && wide.partial ? { ...turn, truncated: true } : turn;
  } catch {
    return null;
  }
}

export interface CliTranscriptThread {
  cliKind?: string | null | undefined;
  cliSessionId?: string | null | undefined;
  title: string;
}

/** Finds the transcript file a terminal CLI thread writes. Caches lookups. */
export class CliTranscriptLocator {
  private paths = new Map<string, string>();

  constructor(private readonly codex: CodexSessionMetadataReader) {}

  /** Transcript `kind` for parsers, or null for non-CLI threads. */
  static kindOf(cliKind: string | null | undefined): string | null {
    if (!cliKind) return null;
    return cliKind === "claudex" ? "claude" : cliKind;
  }

  async resolve(thread: CliTranscriptThread): Promise<string | null> {
    const kind = CliTranscriptLocator.kindOf(thread.cliKind);
    const sessionId = thread.cliSessionId;
    if (kind === "codex") {
      const metadata = await this.codex.resolve(sessionId ?? null, thread.title);
      return metadata?.rolloutPath ?? null;
    }
    if (!kind || !sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
    const home =
      kind === "grok"
        ? process.env.GROK_HOME || path.join(os.homedir(), ".grok")
        : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const key = `${kind}:${home}:${sessionId}`;
    let file = this.paths.get(key);
    if (file) {
      try {
        await stat(file);
        return file;
      } catch {
        this.paths.delete(key);
      }
    }
    const pattern =
      kind === "grok"
        ? `sessions/*/${sessionId}/chat_history.jsonl`
        : `projects/*/${sessionId}.jsonl`;
    for await (const relative of glob(pattern, { cwd: home })) {
      file = path.join(home, relative);
      if (this.paths.size >= 200) this.paths.delete(this.paths.keys().next().value!);
      this.paths.set(key, file);
      return file;
    }
    return null;
  }
}

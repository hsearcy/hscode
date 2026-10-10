import { open, stat } from "node:fs/promises";

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
      const message =
        kind === "codex"
          ? record.type === "response_item"
            ? record.payload
            : null
          : kind === "grok"
            ? record
            : record.message;
      if (!message || (message.role ?? message.type) !== "assistant") continue;
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter(
                  (part: { type?: string; text?: unknown }) =>
                    (part?.type === "text" || part?.type === "output_text") &&
                    typeof part.text === "string",
                )
                .map((part: { text: string }) => part.text)
                .join("\n\n")
            : "";
      if (!text.trim()) continue;
      return {
        text: text.trim().slice(0, MAX_RESPONSE_LENGTH),
        at:
          typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp))
            ? record.timestamp
            : null,
        truncated: text.trim().length > MAX_RESPONSE_LENGTH,
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
      const handle = await open(file, "r");
      let response: SavedResponse | null;
      let activity: SavedTurnActivity | null = null;
      try {
        const start = Math.max(0, info.size - MAX_READ_BYTES);
        const buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        let text = buffer.subarray(0, bytesRead).toString("utf8");
        if (start > 0) text = text.slice(text.indexOf("\n") + 1);
        response = parseLastResponse(text, kind);
        activity = response?.activity ?? parseLastTurnActivity(text, kind);
      } finally {
        await handle.close();
      }
      // Keep the last known response if tool output has pushed it out of the tail.
      if (!response && cached && info.ino === cached.inode && info.size > cached.size)
        response = cached.response
          ? { ...cached.response, activity: activity ?? cached.response.activity }
          : null;
      if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { version, inode: info.ino, size: info.size, response });
      return response;
    } catch {
      return null;
    }
  }
}

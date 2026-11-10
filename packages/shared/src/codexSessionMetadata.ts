import { createReadStream } from "node:fs";
import { glob, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CodexSessionMetadata {
  sessionId: string;
  rolloutPath: string;
  title: string | null;
  previousTitles: ReadonlySet<string>;
}

export class CodexSessionMetadataReader {
  private indexVersion = "";
  private titles = new Map<string, { title: string; previousTitles: Set<string> }>();
  private rolloutPaths = new Map<string, string>();

  constructor(readonly homeDir: string) {}

  private async refreshTitles(): Promise<void> {
    const indexPath = path.join(this.homeDir, "session_index.jsonl");
    try {
      const info = await stat(indexPath);
      const version = `${info.ino}:${info.size}:${info.mtimeMs}`;
      if (version === this.indexVersion) return;
      const titles = new Map<string, { title: string; previousTitles: Set<string> }>();
      const content = await readFile(indexPath, "utf8");
      // Only consume complete records: Codex may still be appending the last line.
      for (const line of content.slice(0, content.lastIndexOf("\n") + 1).split("\n")) {
        try {
          const entry = JSON.parse(line);
          if (
            typeof entry?.id !== "string" ||
            !SESSION_ID.test(entry.id) ||
            typeof entry.thread_name !== "string"
          ) {
            continue;
          }
          const title = entry.thread_name.trim();
          if (!title) continue;
          const previousTitles = titles.get(entry.id)?.previousTitles ?? new Set<string>();
          previousTitles.add(title);
          titles.set(entry.id, { title, previousTitles });
        } catch {
          // A malformed record must not discard the rest of the index.
        }
      }
      this.titles = titles;
      this.indexVersion = version;
    } catch {
      // Missing/unreadable provider state must not prevent opening a terminal.
      this.titles.clear();
      this.indexVersion = "";
    }
  }

  private async isRootSession(sessionId: string): Promise<boolean> {
    if (!SESSION_ID.test(sessionId)) return false;
    const cachedPath = this.rolloutPaths.get(sessionId);
    if (cachedPath) {
      try {
        await stat(cachedPath);
        return true;
      } catch {
        this.rolloutPaths.delete(sessionId);
      }
    }
    try {
      for await (const relativePath of glob(`sessions/*/*/*/*-${sessionId}.jsonl`, {
        cwd: this.homeDir,
      })) {
        const rolloutPath = path.join(this.homeDir, relativePath);
        const stream = createReadStream(rolloutPath, { encoding: "utf8" });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            const record = JSON.parse(line);
            if (
              record.type === "session_meta" &&
              record.payload?.id === sessionId &&
              record.payload?.source === "cli" &&
              !record.payload?.parent_thread_id
            ) {
              this.rolloutPaths.set(sessionId, rolloutPath);
              return true;
            }
            break;
          }
        } finally {
          lines.close();
          stream.destroy();
        }
      }
    } catch {
      // An incomplete or missing rollout is not proof of a resumable root thread.
    }
    return false;
  }

  async resolve(sessionId: string | null, title?: string): Promise<CodexSessionMetadata | null> {
    await this.refreshTitles();
    let resolvedId = sessionId && (await this.isRootSession(sessionId)) ? sessionId : null;
    if (!resolvedId && title) {
      const matches = [...this.titles].filter(([, entry]) => entry.title === title.trim());
      const match = matches.length === 1 ? matches[0] : undefined;
      if (match && (await this.isRootSession(match[0]))) resolvedId = match[0];
    }
    if (!resolvedId) return null;
    const entry = this.titles.get(resolvedId);
    return {
      sessionId: resolvedId,
      rolloutPath: this.rolloutPaths.get(resolvedId)!,
      title: entry?.title ?? null,
      previousTitles: entry?.previousTitles ?? new Set<string>(),
    };
  }
}

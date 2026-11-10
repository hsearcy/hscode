import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodexSessionMetadataReader } from "./codexSessionMetadata";

const MAIN = "01a01759-0b3f-7a91-9425-d45d8ea76bc1";
const OTHER = "01a08374-a13e-7340-ab99-81687d266ae9";
const STALE = "01a08235-ef27-7bd1-a799-cbd81c892e17";

describe("Codex session metadata", () => {
  let homeDir: string;
  let reader: CodexSessionMetadataReader;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "hscode-codex-metadata-"));
    reader = new CodexSessionMetadataReader(homeDir);
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  async function session(id: string, source: unknown = "cli") {
    const dir = path.join(homeDir, "sessions", "2026", "09", "08");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `rollout-2026-09-08T12-00-00-${id}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id, source } })}\n`,
    );
  }

  async function title(id: string, name: string) {
    await fs.appendFile(
      path.join(homeDir, "session_index.jsonl"),
      `${JSON.stringify({ id, thread_name: name, updated_at: new Date().toISOString() })}\n`,
    );
  }

  it("reads automatic titles and later renames with JSON escapes", async () => {
    await session(MAIN);
    await title(MAIN, "Automatic title");
    expect(await reader.resolve(MAIN)).toMatchObject({ sessionId: MAIN, title: "Automatic title" });
    await title(MAIN, 'Fix "quotes" and \\paths');
    const result = await reader.resolve(MAIN);
    expect(result?.title).toBe('Fix "quotes" and \\paths');
    expect(result?.previousTitles.has("Automatic title")).toBe(true);
  });

  it("recovers a missing resume ID from a unique current name", async () => {
    await session(MAIN);
    await title(MAIN, "pipeline_refactor");
    expect(await reader.resolve(STALE, "pipeline_refactor")).toMatchObject({ sessionId: MAIN });
  });

  it("keeps a valid ID even when another session has the requested name", async () => {
    await session(MAIN);
    await session(OTHER);
    await title(OTHER, "Other session");
    expect(await reader.resolve(MAIN, "Other session")).toMatchObject({ sessionId: MAIN });
  });

  it("does not guess when names are duplicated or obsolete", async () => {
    await session(MAIN);
    await session(OTHER);
    await title(MAIN, "Shared");
    await title(OTHER, "Shared");
    expect(await reader.resolve(STALE, "Shared")).toBeNull();
    await title(MAIN, "Renamed");
    await title(OTHER, "Also renamed");
    expect(await reader.resolve(STALE, "Shared")).toBeNull();
  });

  it("rejects subagent sessions and missing rollout files", async () => {
    await session(OTHER, { subagent: { other: "reviewer" } });
    await title(OTHER, "Reviewer");
    await title(STALE, "Missing");
    expect(await reader.resolve(OTHER)).toBeNull();
    expect(await reader.resolve(STALE, "Reviewer")).toBeNull();
    expect(await reader.resolve(STALE, "Missing")).toBeNull();
  });

  it("retries missing files and ignores an unfinished index line", async () => {
    expect(await reader.resolve(MAIN)).toBeNull();
    await session(MAIN);
    await title(MAIN, "Ready");
    await fs.appendFile(path.join(homeDir, "session_index.jsonl"), '{"id":');
    expect(await reader.resolve(MAIN)).toMatchObject({ title: "Ready" });
  });
});

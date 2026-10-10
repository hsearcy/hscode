import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LastResponseReader, parseLastResponse, parseLastTurnActivity } from "./lastResponse";

describe("saved assistant responses", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });
  const line = (value: unknown) => JSON.stringify(value) + "\n";

  it("reads the latest Codex assistant message, excluding tools and reasoning", () => {
    const content =
      line({
        type: "response_item",
        timestamp: "2026-09-08T12:00:00Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "First reply" }],
        },
      }) +
      line({
        type: "response_item",
        timestamp: "2026-09-08T12:01:00Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Latest reply" }],
        },
      }) +
      line({
        type: "response_item",
        payload: { type: "reasoning", summary: [{ text: "Secret reasoning" }] },
      }) +
      line({
        type: "response_item",
        payload: { type: "function_call_output", output: "Tool output" },
      });
    expect(parseLastResponse(content, "codex")).toMatchObject({
      text: "Latest reply",
      at: "2026-09-08T12:01:00Z",
    });
  });

  it("joins Claude text blocks but ignores thinking and tool blocks", () => {
    const content = line({
      type: "assistant",
      timestamp: "2026-09-08T12:00:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "Done." },
          { type: "text", text: "Tests passed." },
          { type: "tool_use", name: "Bash" },
        ],
      },
    });
    expect(parseLastResponse(content, "claude")?.text).toBe("Done.\n\nTests passed.");
  });

  it("reads Grok responses and ignores incomplete records", () => {
    expect(
      parseLastResponse(line({ type: "assistant", content: "Saved reply" }) + '{"type":', "grok")
        ?.text,
    ).toBe("Saved reply");
    expect(parseLastResponse(line({ type: "user", content: "User prompt" }), "grok")).toBeNull();
  });

  it("caps response length and marks it as truncated", () => {
    const result = parseLastResponse(
      line({ type: "assistant", content: "x".repeat(20_000) }),
      "grok",
    );
    expect(result?.text.length).toBe(12_000);
    expect(result?.truncated).toBe(true);
  });

  it("refreshes appended responses and tolerates absent files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hscode-response-"));
    dirs.push(dir);
    const file = path.join(dir, "session.jsonl");
    const reader = new LastResponseReader();
    expect(await reader.read(file, "grok")).toBeNull();
    await fs.writeFile(file, line({ type: "assistant", content: "Before" }));
    expect((await reader.read(file, "grok"))?.text).toBe("Before");
    await fs.appendFile(file, line({ type: "assistant", content: "After" }));
    expect((await reader.read(file, "grok"))?.text).toBe("After");
  });
  it("does not reuse a cached response after file replacement", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hscode-response-"));
    dirs.push(dir);
    const file = path.join(dir, "session.jsonl");
    const reader = new LastResponseReader();
    await fs.writeFile(file, line({ type: "assistant", content: "Old response" }));
    expect((await reader.read(file, "grok"))?.text).toBe("Old response");
    await fs.rename(file, file + ".old");
    await fs.writeFile(file, line({ type: "user", content: "New session prompt" }));
    expect(await reader.read(file, "grok")).toBeNull();
  });

  it("detects saved final turns and subsequent tool activity", () => {
    const at = "2026-09-09T12:00:00Z";
    const claude = line({ type: "assistant", timestamp: at, message: { stop_reason: "end_turn" } });
    expect(parseLastTurnActivity(claude, "claude")).toEqual({ state: "review", at });
    expect(
      parseLastTurnActivity(claude + line({ type: "user", timestamp: at }), "claude")?.state,
    ).toBe("working");
    const codex = line({ type: "event_msg", timestamp: at, payload: { type: "task_complete" } });
    expect(parseLastTurnActivity(codex, "codex")?.state).toBe("review");
    expect(
      parseLastTurnActivity(
        codex + line({ type: "response_item", timestamp: at, payload: { type: "function_call" } }),
        "codex",
      )?.state,
    ).toBe("working");
  });
});

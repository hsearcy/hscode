import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LastResponseReader,
  parseLastResponse,
  parseLastTurn,
  parseLastTurnActivity,
  readLastTurn,
} from "./cliTranscript";

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

  describe("parseLastTurn", () => {
    const claudeUser = (timestamp: string, content: unknown, extra: object = {}) =>
      line({ type: "user", timestamp, message: { role: "user", content }, ...extra });
    const claudeText = (timestamp: string, text: string) =>
      line({
        type: "assistant",
        timestamp,
        message: { role: "assistant", content: [{ type: "text", text }] },
      });

    // Shape of the VCLab triage session: a long answer, then background-task
    // notifications and subagent hand-backs that the assistant answers too.
    it("keeps every reply after the last submitted prompt, ignoring injected user records", () => {
      const answer = "Here is what is waiting on you.\n**1. Replies to send**\n- Ben (177112): ...";
      const content =
        claudeUser("2026-11-10T17:31:01Z", "I am handling jukka's already") +
        claudeText("2026-11-10T17:31:05Z", "I stopped the agent.") +
        claudeUser("2026-11-10T20:20:20Z", "What is still waiting on me?") +
        line({
          type: "assistant",
          timestamp: "2026-11-10T20:20:24Z",
          message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] },
        }) +
        claudeUser("2026-11-10T20:20:31Z", [{ type: "tool_result", content: "23549 OPEN" }]) +
        claudeText("2026-11-10T20:21:06Z", answer) +
        claudeUser("2026-11-10T20:22:01Z", "<task-notification>\n<task-id>a8</task-id>") +
        claudeText("2026-11-10T20:22:03Z", "The agent is still running.") +
        claudeUser("2026-11-10T20:25:25Z", "Another Claude session sent a message", {
          isMeta: true,
        }) +
        claudeText("2026-11-10T20:25:29Z", "The CI failure on #23549 is fixed.") +
        line({
          type: "assistant",
          isSidechain: true,
          message: { role: "assistant", content: "x" },
        }) +
        '{"type":"assistant","mess';
      expect(parseLastTurn(content, "claude")).toEqual({
        prompt: { text: "What is still waiting on me?", at: "2026-11-10T20:20:20Z" },
        responses: [
          { text: answer, at: "2026-11-10T20:21:06Z" },
          { text: "The agent is still running.", at: "2026-11-10T20:22:03Z" },
          { text: "The CI failure on #23549 is fixed.", at: "2026-11-10T20:25:29Z" },
        ],
        truncated: false,
      });
    });

    it("returns long answers whole, unlike the Command view preview", () => {
      const long = "y".repeat(20_000);
      const turn = parseLastTurn(claudeUser("t", "go") + claudeText("t", long), "claude");
      expect(turn.responses[0]?.text).toBe(long);
      expect(turn.truncated).toBe(false);
    });

    it("drops older replies past maxLength and reports truncation", () => {
      const content =
        claudeUser("t", "go") + claudeText("t", "a".repeat(30)) + claudeText("t", "b");
      expect(parseLastTurn(content, "claude", 10)).toEqual({
        prompt: null,
        responses: [{ text: "b", at: null }],
        truncated: true,
      });
    });

    it("reads Codex user_message events, not injected user context", () => {
      const content =
        line({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<env>" }],
          },
        }) +
        line({ type: "event_msg", payload: { type: "user_message", message: "Fix the bug" } }) +
        line({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Fixed." }],
          },
        });
      expect(parseLastTurn(content, "codex")).toMatchObject({
        prompt: { text: "Fix the bug" },
        responses: [{ text: "Fixed." }],
      });
    });

    it("reads Grok prompts and handles missing files", async () => {
      const content =
        line({ type: "user", content: "Hi" }) + line({ type: "assistant", content: "Hello" });
      expect(parseLastTurn(content, "grok")).toMatchObject({
        prompt: { text: "Hi" },
        responses: [{ text: "Hello" }],
      });
      expect(await readLastTurn("/nonexistent/session.jsonl", "grok")).toBeNull();
    });
  });
});

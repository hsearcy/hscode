import { describe, expect, it } from "vitest";
import { sendTerminalInput, type TerminalInputWriter } from "./terminalInput.ts";

function recordingWriter(events: string[]): TerminalInputWriter {
  return {
    write: async (data) => {
      events.push(`write:${JSON.stringify(data)}`);
    },
    settle: async () => {
      events.push("settle");
    },
  };
}

describe("sendTerminalInput", () => {
  it("submits multiline text that ends with a line feed using a separate Enter write", async () => {
    const events: string[] = [];

    const bytesSent = await sendTerminalInput(
      recordingWriter(events),
      "first line\nsecond line\n",
      true,
    );

    expect(events).toEqual([
      'write:"first line\\nsecond line\\n"',
      "settle",
      'write:"§"',
      "settle",
      'write:"\u007f"',
      "settle",
      'write:"\\r"',
    ]);
    expect(bytesSent).toBe(Buffer.byteLength("first line\nsecond line\n§\u007f\r", "utf8"));
  });

  it("does not add Enter when submit is false", async () => {
    const events: string[] = [];

    const bytesSent = await sendTerminalInput(recordingWriter(events), "partial input", false);

    expect(events).toEqual(['write:"partial input"']);
    expect(bytesSent).toBe(Buffer.byteLength("partial input", "utf8"));
  });

  it("separates a caller-supplied trailing carriage return without duplicating it", async () => {
    const events: string[] = [];

    const bytesSent = await sendTerminalInput(recordingWriter(events), "ready\r", true);

    expect(events).toEqual([
      'write:"ready"',
      "settle",
      'write:"§"',
      "settle",
      'write:"\u007f"',
      "settle",
      'write:"\\r"',
    ]);
    expect(bytesSent).toBe(Buffer.byteLength("ready§\u007f\r", "utf8"));
  });

  it("can send only Enter as a submission fallback", async () => {
    const events: string[] = [];

    const bytesSent = await sendTerminalInput(recordingWriter(events), "", true);

    expect(events).toEqual([
      'write:"§"',
      "settle",
      'write:"\u007f"',
      "settle",
      'write:"\\r"',
    ]);
    expect(bytesSent).toBe(Buffer.byteLength("§\u007f\r", "utf8"));
  });
});

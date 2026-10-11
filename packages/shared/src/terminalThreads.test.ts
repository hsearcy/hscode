import { describe, expect, it } from "vitest";

import {
  defaultTerminalTitleForCliKind,
  deriveTerminalCommandIdentity,
  isTerminalTitleBusySignal,
  terminalCliKindFromValue,
} from "./terminalThreads";

describe("terminalThreads", () => {
  it("recognizes Claudex as a Claude-family terminal command", () => {
    expect(terminalCliKindFromValue("claudex")).toBe("claudex");
    expect(defaultTerminalTitleForCliKind("claudex")).toBe("Claudex");
    expect(deriveTerminalCommandIdentity("claudex --dangerously-skip-permissions")).toEqual({
      cliKind: "claudex",
      iconKey: "claude",
      title: "Claudex",
    });
  });

  it("recognizes Grok as a terminal command", () => {
    expect(terminalCliKindFromValue("grok")).toBe("grok");
    expect(defaultTerminalTitleForCliKind("grok")).toBe("Grok");
    expect(
      deriveTerminalCommandIdentity("grok --resume 550e8400-e29b-41d4-a716-446655440000"),
    ).toEqual({
      cliKind: "grok",
      iconKey: "grok",
      title: "Grok",
    });
  });
});

describe("isTerminalTitleBusySignal", () => {
  it("treats a leading braille spinner frame as busy", () => {
    expect(isTerminalTitleBusySignal("\u2826 Reduce CI test suite time | vclab")).toBe(true);
    expect(isTerminalTitleBusySignal("  \u280b codex")).toBe(true);
  });

  it("ignores idle titles", () => {
    expect(isTerminalTitleBusySignal("\u2733 Claude Code")).toBe(false);
    expect(isTerminalTitleBusySignal("Reduce CI test suite time")).toBe(false);
    expect(isTerminalTitleBusySignal("\u2800 blank braille")).toBe(false);
    expect(isTerminalTitleBusySignal("")).toBe(false);
  });
});

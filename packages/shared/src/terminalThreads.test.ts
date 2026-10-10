import { describe, expect, it } from "vitest";

import {
  defaultTerminalTitleForCliKind,
  deriveTerminalCommandIdentity,
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

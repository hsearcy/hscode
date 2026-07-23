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
});

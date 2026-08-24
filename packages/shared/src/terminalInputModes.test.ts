import { describe, expect, it } from "vitest";

import {
  TERMINAL_INPUT_REPORTING_RESET_SEQUENCE,
  isTerminalInputReportingModeSequence,
} from "./terminalInputModes";

describe("isTerminalInputReportingModeSequence", () => {
  it("matches single mouse and focus reporting modes", () => {
    for (const mode of [1000, 1002, 1003, 1004, 1006, 1015, 1016]) {
      expect(isTerminalInputReportingModeSequence(`?${mode}`, "h")).toBe(true);
      expect(isTerminalInputReportingModeSequence(`?${mode}`, "l")).toBe(true);
    }
  });

  it("matches combined parameter lists", () => {
    expect(isTerminalInputReportingModeSequence("?1002;1006", "h")).toBe(true);
  });

  it("ignores unrelated private modes", () => {
    expect(isTerminalInputReportingModeSequence("?25", "l")).toBe(false);
    expect(isTerminalInputReportingModeSequence("?1049", "h")).toBe(false);
    expect(isTerminalInputReportingModeSequence("?2004", "h")).toBe(false);
  });

  it("leaves mixed parameter lists alone", () => {
    expect(isTerminalInputReportingModeSequence("?25;1006", "h")).toBe(false);
  });

  it("ignores non-private and non-mode sequences", () => {
    expect(isTerminalInputReportingModeSequence("1006", "h")).toBe(false);
    expect(isTerminalInputReportingModeSequence("?1006", "m")).toBe(false);
    expect(isTerminalInputReportingModeSequence("?", "h")).toBe(false);
  });
});

describe("TERMINAL_INPUT_REPORTING_RESET_SEQUENCE", () => {
  it("is a private mode reset for every reporting mode", () => {
    expect(TERMINAL_INPUT_REPORTING_RESET_SEQUENCE).toBe(
      "\u001b[?1000;1001;1002;1003;1004;1005;1006;1015;1016l",
    );
  });
});

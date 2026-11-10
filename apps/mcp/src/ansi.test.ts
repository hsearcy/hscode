import { describe, expect, it } from "vitest";

import { composerDraft } from "./ansi.ts";

const rule = "─".repeat(40);

describe("composerDraft", () => {
  it("returns unsent composer text, not scrollback above it", () => {
    const screen = [
      "● The CI failure on #23549 is fixed.",
      "  - Tests: 384 runs across 3 test files, with 0 failures.",
      "",
      rule,
      "❯ see if there are new items in my queue",
      rule,
      "  ⏵⏵ auto mode on (shift+tab to cycle) · /tasks to see subagents",
    ].join("\n");
    expect(composerDraft(screen)).toBe("see if there are new items in my queue");
  });

  it("joins multi-line drafts", () => {
    expect(composerDraft([rule, "❯ first line", "  second line", rule].join("\n"))).toBe(
      "first line\nsecond line",
    );
  });

  it("is null for an empty composer, blank lines, or no composer", () => {
    expect(composerDraft([rule, "❯ ", rule].join("\n"))).toBeNull();
    expect(composerDraft(["● reply", "   ", "❯ looks like a draft", "   "].join("\n"))).toBeNull();
    expect(composerDraft("● just output")).toBeNull();
  });
});

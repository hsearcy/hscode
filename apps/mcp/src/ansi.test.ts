import { describe, expect, it } from "vitest";

import { renderOptionsForSnapshot, renderTerminal } from "./ansi.ts";

describe("renderOptionsForSnapshot", () => {
  it("uses the snapshot's live PTY dimensions", () => {
    expect(renderOptionsForSnapshot({ cols: 190, rows: 52 })).toEqual({ cols: 190, rows: 52 });
  });

  it("falls back to legacy defaults for snapshots without dimensions", () => {
    expect(renderOptionsForSnapshot({})).toEqual({ cols: 120, rows: 40 });
  });
});

describe("renderTerminal width fidelity", () => {
  // Regression: read_thread rendered history at a hardcoded 120 columns while
  // the live PTY ran wider (fit-addon sizes it to the window; observed ≥139
  // with 232-char rules). Cursor-addressed redraws targeting columns beyond
  // the render width clamp and overwrite the wrong cells — agents reading a
  // thread verbatim saw the last output "corrupted".
  it("renders cursor-addressed content correctly at the snapshot's width", async () => {
    const input = `${"X".repeat(150)}\u001b[1;130HMARK`;
    const atRealWidth = await renderTerminal(
      input,
      renderOptionsForSnapshot({ cols: 150, rows: 40 }),
    );
    expect(atRealWidth.split("\n")[0]).toBe(`${"X".repeat(129)}MARK${"X".repeat(17)}`);
  });

  it("demonstrates the clamp corruption at a mismatched width", async () => {
    const input = `${"X".repeat(150)}\u001b[1;130HMARK`;
    const atWrongWidth = await renderTerminal(input, { cols: 120, rows: 40 });
    // The 150-char line wraps and the cursor move clamps to column 120 — the
    // marker no longer lands where the TUI put it.
    expect(atWrongWidth.split("\n")[0]).not.toContain("MARK");
  });
});

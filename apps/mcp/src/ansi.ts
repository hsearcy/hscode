// Renders a raw PTY byte stream into plain text by feeding it through a
// headless xterm.js terminal — the same library the dpcode web UI uses,
// so the rendered output matches what a human sees in the Threads view.

import { Terminal } from "@xterm/headless";

export interface RenderOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
}

export async function renderTerminal(
  input: string,
  opts: RenderOptions = {},
): Promise<string> {
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 40;
  const scrollback = opts.scrollback ?? 20000;
  const term = new Terminal({
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
  });
  // write() is async — xterm parses on a microtask/idle queue. Awaiting
  // the callback is required, otherwise the buffer is empty when we read.
  await new Promise<void>((resolve) => term.write(input, () => resolve()));
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  term.dispose();
  return lines.join("\n");
}

export function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(lines.length - n).join("\n");
}

// Claude Code's spinner / "thinking" indicator emits lines that, after xterm
// rendering, contain only decorative glyphs. When a session is mid-turn the
// last visible viewport is dominated by these frames, pushing real content
// out of a "last N lines" window. This trims them so callers see the actual
// conversation tail.
const SPINNER_LINE = /^[\s✶✻✽✢*·…•⏵⏶⏷↑↓→←]*$/;

export function lastMeaningfulLines(text: string, n: number): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0 && kept.length < n; i--) {
    const line = lines[i]!;
    if (SPINNER_LINE.test(line)) continue;
    kept.push(line);
  }
  return kept.reverse().join("\n");
}

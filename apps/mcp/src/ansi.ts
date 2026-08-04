// Renders a raw PTY byte stream into plain text by feeding it through a
// headless xterm.js terminal — the same library the dpcode web UI uses,
// so the rendered output matches what a human sees in the Threads view.

import { Terminal } from "@xterm/headless";

export interface RenderOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
}

// The history stream is raw PTY bytes recorded at the live terminal's size —
// TUIs position the cursor absolutely within that width, so replaying into a
// differently sized headless terminal clamps those moves and garbles the most
// recent viewport (the exact "last output" callers ask about). Always render
// at the snapshot's real dimensions; the defaults only cover older servers
// whose snapshots predate the cols/rows fields.
export function renderOptionsForSnapshot(snapshot: {
  cols?: number | undefined;
  rows?: number | undefined;
}): RenderOptions {
  return {
    cols: snapshot.cols ?? 120,
    rows: snapshot.rows ?? 40,
  };
}

export async function renderTerminal(input: string, opts: RenderOptions = {}): Promise<string> {
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

// The composer at the bottom of the screen draws an input box bracketed by
// two horizontal-rule lines (`──...`) with a `❯ ...` draft line in between.
// It's not part of the assistant's output — strip it from the tail.
const HORIZONTAL_RULE = /^[\s─━]+$/;
const INPUT_BOX_LEAD = /^[╭┌]/;
const INPUT_BOX_TAIL = /^[╰└]/;

// TUI affordance noise — show up scattered through assistant output but carry
// no semantic content. We strip these line-by-line from extracted turns so a
// remote subscriber doesn't have to parse around them.
const NOISE_PATTERNS: RegExp[] = [
  // "Allowed by auto mode classifier" — auto-permission marker, fires for
  // every tool call when auto-mode is on. Nothing to act on.
  /^\s*[└╰]?\s*Allowed by auto mode classifier\s*$/i,
  // Tool-call meta annotations like "(timeout 5m)", "(retry 2/3)".
  /^\s*[└╰]?\s*\((timeout|retry|attempt|elapsed|cost)\b[^)]*\)\s*$/i,
  // "… +24 lines (ctrl+o to expand)" — collapsed output indicator.
  /^\s*…?\s*\+?\d*\s*(more\s+)?lines?\s*\(ctrl\+o to expand\)\s*$/i,
  // Bare "(ctrl+o to expand)" tail on otherwise-real output (e.g. "Called slack (ctrl+o to expand)").
  // Handled below by stripping the suffix in-place rather than dropping the line.
  // Composer / mode banners that sometimes appear mid-output during redraws.
  /^\s*(⏵⏵\s*)?auto mode (on|off)\s*\(.*?\)\s*$/i,
  /^\s*shift\+tab to cycle\s*$/i,
  /^\s*↑\/↓ for history\s*$/i,
  /^\s*←\s+for agents\s*$/i,
  // Stray horizontal rules in the middle of output (composer top/bottom).
  /^[\s─━]{3,}$/,
  // Bare box-drawing characters with no content.
  /^\s*[╭╮╯╰│┃└┘├┤┬┴┼]+\s*$/,
];

const CTRL_O_SUFFIX = /\s*\((ctrl\+o to expand|view full output)\)\s*$/i;

function stripInputBox(lines: string[]): string[] {
  // Walk from the bottom, dropping the composer box if we see one. Common
  // shapes: (a) `───…\n❯ draft\n───…`, (b) a `╭/╰` boxed variant. Stop at
  // the first non-decorative line.
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1]!;
    if (
      line === "" ||
      SPINNER_LINE.test(line) ||
      HORIZONTAL_RULE.test(line) ||
      INPUT_BOX_LEAD.test(line) ||
      INPUT_BOX_TAIL.test(line) ||
      /^[│┃]/.test(line) ||
      /^❯\s/.test(line) ||
      /^>\s*$/.test(line) ||
      /auto mode (on|off)/i.test(line) ||
      /shift\+tab to cycle/i.test(line)
    ) {
      end--;
      continue;
    }
    break;
  }
  return lines.slice(0, end);
}

// Walks the rendered scrollback to extract just the assistant's most recent
// turn — i.e. everything below the last user-message marker, with the input
// box composer stripped. Heuristic; falls back to `lastMeaningfulLines` if
// no user-message marker is found (e.g. a brand-new session that hasn't yet
// received a user input, or a non-Claude TUI without `> ` prefixes).
//
// Markers used:
//   `> <text>`   — user message bubble (Claude Code; also Codex in many cases)
//   `● <text>`   — assistant message (not used for boundary detection but
//                  useful as a sanity check that we kept assistant content)
export function lastAssistantTurn(text: string, fallbackLines = 80): string {
  const lines = text.split("\n");
  // Locate the LAST line that looks like a user-message bubble.
  let userIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // Match `> text` but NOT the empty-prompt indicator `>` (which is the
    // composer's input box marker when no draft is present).
    if (/^>\s+\S/.test(line)) {
      userIdx = i;
      break;
    }
  }
  if (userIdx === -1) {
    return lastMeaningfulLines(text, fallbackLines);
  }
  // Everything strictly below the user message is the assistant's response.
  // Walk forward past contiguous user-bubble continuation lines (multi-line
  // user input shows as adjacent `>` lines); start when we hit a non-`>` line.
  let start = userIdx + 1;
  while (start < lines.length) {
    const line = lines[start]!;
    if (/^>\s/.test(line)) {
      start++;
      continue;
    }
    break;
  }
  const tail = stripInputBox(lines.slice(start));
  // Drop leading blank lines.
  let first = 0;
  while (first < tail.length && tail[first]!.trim() === "") first++;
  return cleanNoise(tail.slice(first)).join("\n");
}

// Strip TUI affordance noise scattered through extracted assistant output:
// auto-mode-classifier markers, "ctrl+o to expand" hints, composer banners
// that leak from cursor-positioning redraws, etc. Collapses runs of resulting
// blank lines so the output stays readable.
function cleanNoise(lines: string[]): string[] {
  const out: string[] = [];
  let lastBlank = false;
  for (const raw of lines) {
    if (NOISE_PATTERNS.some((p) => p.test(raw))) continue;
    // Strip trailing "(ctrl+o to expand)" without dropping the rest of the
    // line — preserves info like "Called slack" while removing the affordance.
    const stripped = raw.replace(CTRL_O_SUFFIX, "");
    const isBlank = stripped.trim() === "";
    if (isBlank && lastBlank) continue;
    out.push(stripped);
    lastBlank = isBlank;
  }
  // Drop trailing blanks.
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}

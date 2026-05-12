// Renders a raw PTY byte stream / scrollback into plain text suitable for an LLM.
// Strips ANSI CSI/OSC sequences, drops cursor/scroll control codes, normalizes
// carriage returns. This is intentionally simple — for fancier needs swap in
// @xterm/headless and read its buffer.

const CSI = /\x1b\[[\d;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const SS = /\x1b[NOPVWXYZ\\^_]/g;
const C1 = /\x1b[\(\)\*\+][\x20-\x7e]/g; // charset designators
const OTHER_ESC = /\x1b[<=>78cDEHMZ]/g;
const BACKSPACE = /[^\b]\b/g;

export function stripAnsi(input: string): string {
  let out = input
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(SS, "")
    .replace(C1, "")
    .replace(OTHER_ESC, "")
    .replace(/\r\n?/g, "\n");

  // collapse simple backspace edits (e.g. spinner frames)
  let prev: string;
  do {
    prev = out;
    out = out.replace(BACKSPACE, "");
  } while (out !== prev);

  return out;
}

export function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(lines.length - n).join("\n");
}

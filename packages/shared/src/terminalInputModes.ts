/**
 * DEC private modes that make the *terminal* send reports to the process
 * (mouse tracking and focus reporting).
 *
 * These modes are a property of the live process, never of the scrollback.
 * Replaying recorded output that enabled them leaves the emulator reporting
 * to a process that never asked — a shell prompt then echoes every pointer
 * move as `^[[<35;12;34M` garbage until the terminal is discarded.
 */
export const TERMINAL_INPUT_REPORTING_MODES: readonly number[] = [
  1000, // X11 mouse: button press/release
  1001, // hilite mouse tracking
  1002, // button-event tracking (drag)
  1003, // any-event tracking (motion)
  1004, // focus in/out reporting
  1005, // UTF-8 extended coordinates
  1006, // SGR extended coordinates
  1015, // urxvt extended coordinates
  1016, // SGR pixel coordinates
];

const INPUT_REPORTING_MODE_SET = new Set(TERMINAL_INPUT_REPORTING_MODES);

/**
 * `CSI ? <modes> l` for every input-reporting mode, to force a known-quiet
 * state after replaying recorded output.
 */
export const TERMINAL_INPUT_REPORTING_RESET_SEQUENCE = `\u001b[?${TERMINAL_INPUT_REPORTING_MODES.join(
  ";",
)}l`;

/**
 * True for a `CSI ? <modes> h|l` sequence whose parameters are all
 * input-reporting modes. Mixed sequences are left alone so unrelated modes
 * (cursor visibility, alternate screen) keep their meaning.
 *
 * @param body CSI parameter bytes, without the leading `ESC [` or final byte.
 * @param finalByte The CSI final byte.
 */
export function isTerminalInputReportingModeSequence(body: string, finalByte: string): boolean {
  if (finalByte !== "h" && finalByte !== "l") return false;
  if (!body.startsWith("?")) return false;
  const params = body.slice(1).split(";");
  if (params.length === 0) return false;
  return params.every((param) => {
    if (!/^[0-9]+$/.test(param)) return false;
    return INPUT_REPORTING_MODE_SET.has(Number.parseInt(param, 10));
  });
}

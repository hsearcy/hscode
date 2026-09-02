export interface TerminalInputWriter {
  write(data: string): Promise<void>;
  settle(): Promise<void>;
}

const PASTE_BURST_RESET = "§";
const DELETE = "\u007f";

export async function sendTerminalInput(
  writer: TerminalInputWriter,
  text: string,
  submit: boolean,
): Promise<number> {
  if (!submit) {
    await writer.write(text);
    return Buffer.byteLength(text, "utf8");
  }

  const prompt = text.endsWith("\r") ? text.slice(0, -1) : text;
  if (prompt.length > 0) {
    await writer.write(prompt);
    await writer.settle();
  }

  // Codex can keep a large, fast terminal write in its paste-burst state. A
  // non-ASCII character clears that state. Delete it before Enter so that the
  // submitted prompt is unchanged.
  await writer.write(PASTE_BURST_RESET);
  await writer.settle();
  await writer.write(DELETE);
  await writer.settle();
  await writer.write("\r");
  return Buffer.byteLength(prompt + PASTE_BURST_RESET + DELETE + "\r", "utf8");
}

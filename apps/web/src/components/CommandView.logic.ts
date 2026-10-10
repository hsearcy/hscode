import type { CommandThread } from "@t3tools/contracts";
export type CommandColumn = "attention" | "working" | "idle";
export function commandColumn(thread: CommandThread): CommandColumn {
  if (thread.status === "attention" || thread.status === "review" || thread.status === "error")
    return "attention";
  return thread.status === "working" ? "working" : "idle";
}

export function filterCommandThreads(
  threads: readonly CommandThread[],
  input: { query: string; projectId: string; hours: number; now: number },
): CommandThread[] {
  const query = input.query.trim().toLowerCase();
  const rank = (thread: CommandThread) =>
    thread.status === "attention" || thread.status === "error" ? 0 : 1;
  return threads
    .filter((thread) => {
      if (input.projectId !== "all" && thread.projectId !== input.projectId) return false;
      if (
        input.hours > 0 &&
        Date.parse(thread.lastActivityAt) < input.now - input.hours * 3_600_000
      )
        return false;
      return (
        !query ||
        [thread.title, thread.projectTitle, thread.agent, thread.response ?? ""].some((value) =>
          value.toLowerCase().includes(query),
        )
      );
    })
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) ||
        a.id.localeCompare(b.id),
    );
}

import type { CommandThread, CommandThreadStatus } from "@t3tools/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type Override = { status: CommandThreadStatus; version: string };
export function commandStatusVersion(thread: CommandThread): string {
  return (
    thread.statusVersion ??
    JSON.stringify([thread.status, thread.responseAt, thread.lastActivityAt])
  );
}

export function displayCommandThread(
  thread: CommandThread,
  override?: Override,
  reviewedAt?: string,
): CommandThread {
  if (override?.version === commandStatusVersion(thread))
    return { ...thread, status: override.status };
  const completion = thread.reviewAt ?? thread.responseAt ?? thread.lastActivityAt;
  if (thread.status === "review" && reviewedAt && Date.parse(reviewedAt) >= Date.parse(completion))
    return { ...thread, status: "idle" };
  return thread;
}

interface CommandViewState {
  overrides: Record<string, Override>;
  reviewedAt: Record<string, string>;
  setStatus: (thread: CommandThread, status: CommandThreadStatus | "auto") => void;
  markReviewed: (id: string) => void;
}

export const useCommandViewState = create<CommandViewState>()(
  persist(
    (set) => ({
      overrides: {},
      reviewedAt: {},
      setStatus: (thread, status) =>
        set((state) => {
          const overrides = { ...state.overrides };
          if (status === "auto") delete overrides[thread.id];
          else overrides[thread.id] = { status, version: commandStatusVersion(thread) };
          return { overrides };
        }),
      markReviewed: (id) =>
        set((state) => ({ reviewedAt: { ...state.reviewedAt, [id]: new Date().toISOString() } })),
    }),
    { name: "hscode:command-status:v1" },
  ),
);

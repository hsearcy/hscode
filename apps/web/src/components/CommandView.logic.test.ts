import { describe, expect, it } from "vitest";
import type { CommandThread } from "@t3tools/contracts";
import { commandColumn, filterCommandThreads } from "./CommandView.logic";

const thread = (id: string, overrides: Partial<CommandThread> = {}) =>
  ({
    id,
    projectId: "hscode",
    projectTitle: "HS Code",
    title: "Fix resume",
    agent: "codex",
    status: "review",
    lastActivityAt: "2026-09-08T12:00:00Z",
    response: "The saved ID is now used.",
    ...overrides,
  }) as CommandThread;
const filters = { query: "", projectId: "all", hours: 24, now: Date.parse("2026-09-08T13:00:00Z") };

describe("Command board", () => {
  it("groups approvals, reviews and errors as needing attention", () => {
    for (const status of ["attention", "review", "error"] as const)
      expect(commandColumn(thread("1", { status }))).toBe("attention");
    expect(commandColumn(thread("2", { status: "working" }))).toBe("working");
    expect(commandColumn(thread("3", { status: "asleep" }))).toBe("idle");
  });
  it("filters old working threads and approval requests by the selected time window", () => {
    const old = "2026-09-01T12:00:00Z";
    const threads = [
      thread("old", { lastActivityAt: old }),
      thread("busy", { lastActivityAt: old, status: "working" }),
      thread("approval", { lastActivityAt: old, status: "attention" }),
    ];
    expect(filterCommandThreads(threads, filters).map((item) => item.id)).toEqual([]);
  });
  it("combines project and case-insensitive response search", () => {
    const threads = [
      thread("1"),
      thread("2", { projectId: "other" }),
      thread("3", { response: "Nothing" }),
    ];
    expect(
      filterCommandThreads(threads, { ...filters, query: "SAVED ID", projectId: "hscode" }).map(
        (item) => item.id,
      ),
    ).toEqual(["1"]);
  });
  it("puts approval requests before recent completed work", () => {
    expect(
      filterCommandThreads(
        [
          thread("new"),
          thread("approval", { status: "attention", lastActivityAt: "2026-09-08T11:00:00Z" }),
        ],
        filters,
      ).map((item) => item.id),
    ).toEqual(["approval", "new"]);
  });
  it("supports one-hour and four-hour boundaries", () => {
    const threads = [
      thread("recent", { lastActivityAt: "2026-09-08T12:30:00Z" }),
      thread("older", { lastActivityAt: "2026-09-08T10:00:00Z" }),
    ];
    expect(filterCommandThreads(threads, { ...filters, hours: 1 }).map((item) => item.id)).toEqual([
      "recent",
    ]);
    expect(filterCommandThreads(threads, { ...filters, hours: 4 }).map((item) => item.id)).toEqual([
      "recent",
      "older",
    ]);
  });
});

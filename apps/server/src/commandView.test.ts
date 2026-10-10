import { describe, expect, it } from "vitest";
import type { OrchestrationReadModel, OrchestrationThread } from "@t3tools/contracts";
import type { TerminalSessionActivity } from "./terminal/Services/Manager";
import { CommandViewReader, commandThreadStatus, commandThreadActivityAt } from "./commandView";

const thread = (overrides: Partial<OrchestrationThread> = {}) =>
  ({
    createdAt: "2026-09-08T10:00:00Z",
    updatedAt: "2026-09-08T10:00:00Z",
    cliKind: "codex",
    messages: [],
    session: null,
    latestTurn: null,
    ...overrides,
  }) as OrchestrationThread;
const terminal = (overrides: Partial<TerminalSessionActivity> = {}) =>
  ({
    status: "running",
    managedAgentRunning: false,
    managedAgentObserved: true,
    hasRunningSubprocess: false,
    detectedCliKind: "codex",
    ...overrides,
  }) as TerminalSessionActivity;

describe("Command thread status", () => {
  it("clears retained hook states after the provider process exits", () => {
    for (const agentState of ["review", "running", "attention"] as const) {
      expect(
        commandThreadStatus(thread(), terminal({ agentState, hasProviderProcess: false })),
      ).toBe("idle");
    }
  });
  it("uses saved completion when a Stop hook is missed, but never over newer input or approval", () => {
    const saved = { state: "review" as const, at: "2026-09-08T12:00:00Z" };
    expect(commandThreadStatus(thread(), terminal({ agentState: "running" }), saved)).toBe(
      "review",
    );
    expect(
      commandThreadStatus(
        thread(),
        terminal({ agentState: "running", lastInputAt: "2026-09-08T12:01:00Z" }),
        saved,
      ),
    ).toBe("working");
    expect(commandThreadStatus(thread(), terminal({ agentState: "attention" }), saved)).toBe(
      "attention",
    );
  });
  it("reports sleep before a retained completed-turn state", () => {
    expect(commandThreadStatus(thread(), terminal({ status: "slept", agentState: "review" }))).toBe(
      "asleep",
    );
  });
  it("does not call a missing terminal asleep or working", () => {
    expect(commandThreadStatus(thread({ latestTurn: { state: "running" } as never }), null)).toBe(
      "idle",
    );
  });
  it("prioritizes attention over subprocess activity", () => {
    expect(
      commandThreadStatus(
        thread(),
        terminal({ agentState: "attention", hasRunningSubprocess: true }),
      ),
    ).toBe("attention");
    expect(commandThreadStatus(thread(), terminal({ agentState: "running" }))).toBe("working");
    expect(
      commandThreadStatus(thread(), terminal({ agentState: "review", hasRunningSubprocess: true })),
    ).toBe("review");
  });
  it("handles native thread approvals, completion, and errors", () => {
    expect(
      commandThreadStatus(thread({ cliKind: undefined, hasPendingApprovals: true }), null),
    ).toBe("attention");
    expect(
      commandThreadStatus(
        thread({ cliKind: undefined, latestTurn: { state: "completed" } as never }),
        null,
      ),
    ).toBe("review");
    expect(commandThreadStatus(thread(), terminal({ status: "error" }))).toBe("error");
  });
  it("uses real terminal activity when it is newer than the projection", () => {
    expect(
      commandThreadActivityAt(thread(), terminal({ lastActivityAt: "2026-09-08T11:00:00Z" })),
    ).toBe("2026-09-08T11:00:00.000Z");
  });

  it("bounds the board while retaining active threads and excluding archived children", async () => {
    const recent = Array.from({ length: 101 }, (_, index) =>
      thread({
        id: `recent-${index}` as never,
        projectId: "project" as never,
        cliKind: undefined,
        modelSelection: { provider: "codex", model: "gpt-5" },
        title: `Recent ${index}`,
      }),
    );
    const model = {
      projects: [{ id: "project", title: "Project", workspaceRoot: "/repo" }],
      threads: [
        ...recent,
        thread({
          id: "active" as never,
          projectId: "project" as never,
          cliKind: "claude",
          title: "Active",
          createdAt: "2020-01-01T00:00:00Z",
          updatedAt: "2020-01-01T00:00:00Z",
        }),
        thread({
          id: "archived" as never,
          projectId: "project" as never,
          archivedAt: "2026-09-08T12:00:00Z",
        }),
        thread({
          id: "child" as never,
          projectId: "project" as never,
          parentThreadId: "active" as never,
        }),
      ],
    } as unknown as OrchestrationReadModel;
    const requested: string[] = [];
    const result = await new CommandViewReader().read(model, async (id) => {
      requested.push(id);
      return terminal({ agentState: "attention" });
    });
    expect(result.totalThreads).toBe(102);
    expect(result.threads).toHaveLength(100);
    expect(result.threads.find((item) => item.id === "active")?.status).toBe("attention");
    expect(requested).toEqual(["active"]);
  });
});

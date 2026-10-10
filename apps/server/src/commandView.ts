import type {
  CommandThread,
  CommandThreadStatus,
  CommandViewSnapshot,
  OrchestrationReadModel,
  OrchestrationThread,
} from "@t3tools/contracts";
import { resolveCodexHome } from "@t3tools/shared/codexConfig";
import { glob, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TerminalSessionActivity } from "./terminal/Services/Manager";
import { CodexSessionMetadataReader } from "./terminal/codexSessionMetadata";
import {
  LastResponseReader,
  type SavedResponse,
  type SavedTurnActivity,
} from "./terminal/lastResponse";

export function commandThreadStatus(
  thread: OrchestrationThread,
  terminal: TerminalSessionActivity | null,
  saved?: SavedTurnActivity | null,
): CommandThreadStatus {
  if (thread.cliKind || thread.interactionMode === "terminal-cli") {
    if (terminal?.status === "slept") return "asleep";
    if (terminal?.status === "error") return "error";
    if (!terminal || terminal.status === "exited") return "idle";
    if (terminal.hasProviderProcess === false) return "idle";
    if (terminal.agentState === "attention") return "attention";
    if (saved && Date.parse(saved.at) >= Date.parse(terminal.lastInputAt ?? "1970-01-01T00:00:00Z"))
      return saved.state;
    if (terminal.agentState === "review") return "review";
    if (
      terminal.agentState === "running" ||
      terminal.managedAgentRunning ||
      terminal.hasRunningSubprocess
    )
      return "working";
    return "idle";
  }
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "error";
  if (thread.session?.status === "running" || thread.session?.status === "starting")
    return "working";
  if (thread.latestTurn?.state === "completed" || thread.hasActionableProposedPlan) return "review";
  return "idle";
}

export function commandThreadActivityAt(
  thread: OrchestrationThread,
  terminal: TerminalSessionActivity | null,
): string {
  const times = [
    thread.createdAt,
    thread.updatedAt,
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.completedAt,
    terminal?.lastInputAt ?? terminal?.lastActivityAt,
    thread.messages.at(-1)?.updatedAt,
  ]
    .map((time) => (time ? Date.parse(time) : 0))
    .filter(Number.isFinite);
  return new Date(Math.max(0, ...times)).toISOString();
}

/** Shared read-only snapshot. No terminal.open/write calls or provider turns. */
export class CommandViewReader {
  private responses = new LastResponseReader();
  private codex = new CodexSessionMetadataReader(resolveCodexHome());
  private paths = new Map<string, string>();
  private pending: Promise<CommandViewSnapshot> | null = null;

  private async responseFor(thread: OrchestrationThread): Promise<SavedResponse | null> {
    if (!thread.cliKind) {
      const message = thread.messages.findLast(
        (entry) => entry.role === "assistant" && entry.text.trim(),
      );
      return message
        ? {
            text: message.text.slice(0, 12_000),
            at: message.updatedAt,
            truncated: message.text.length > 12_000,
          }
        : null;
    }
    const sessionId = thread.cliSessionId;
    if (thread.cliKind === "codex") {
      const metadata = await this.codex.resolve(sessionId ?? null, thread.title);
      return metadata ? this.responses.read(metadata.rolloutPath, "codex") : null;
    }
    if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
    const kind = thread.cliKind === "claudex" ? "claude" : thread.cliKind;
    const home =
      kind === "grok"
        ? process.env.GROK_HOME || path.join(os.homedir(), ".grok")
        : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const key = `${kind}:${home}:${sessionId}`;
    let file = this.paths.get(key);
    if (file) {
      try {
        await stat(file);
      } catch {
        this.paths.delete(key);
        file = undefined;
      }
    }
    if (!file) {
      const pattern =
        kind === "grok"
          ? `sessions/*/${sessionId}/chat_history.jsonl`
          : `projects/*/${sessionId}.jsonl`;
      for await (const relative of glob(pattern, { cwd: home })) {
        file = path.join(home, relative);
        if (this.paths.size >= 200) this.paths.delete(this.paths.keys().next().value!);
        this.paths.set(key, file);
        break;
      }
    }
    return file ? this.responses.read(file, kind) : null;
  }

  read(
    model: OrchestrationReadModel,
    activity: (id: string) => Promise<TerminalSessionActivity | null>,
  ): Promise<CommandViewSnapshot> {
    if (this.pending) return this.pending;
    this.pending = this.build(model, activity).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async build(
    model: OrchestrationReadModel,
    activity: (id: string) => Promise<TerminalSessionActivity | null>,
  ): Promise<CommandViewSnapshot> {
    const projects = new Map(
      model.projects
        .filter((project) => !project.deletedAt)
        .map((project) => [project.id, project]),
    );
    const candidates = [];
    for (const thread of model.threads) {
      if (
        thread.archivedAt ||
        thread.deletedAt ||
        thread.parentThreadId ||
        !projects.has(thread.projectId)
      )
        continue;
      const terminal =
        thread.cliKind || thread.interactionMode === "terminal-cli"
          ? await activity(thread.id)
          : null;
      candidates.push({ thread, terminal, at: commandThreadActivityAt(thread, terminal) });
    }
    const priority = (candidate: (typeof candidates)[number]) => {
      const status = commandThreadStatus(candidate.thread, candidate.terminal);
      return status === "working" || status === "attention" || status === "error" ? 1 : 0;
    };
    candidates.sort(
      (a, b) =>
        priority(b) - priority(a) ||
        b.at.localeCompare(a.at) ||
        a.thread.id.localeCompare(b.thread.id),
    );
    const recent = candidates.slice(0, 100);
    const results: CommandThread[] = [];
    // Bound concurrent disk reads across all connected Command views.
    for (let offset = 0; offset < recent.length; offset += 4) {
      const batch = await Promise.all(
        recent.slice(offset, offset + 4).map(async ({ thread, terminal, at }) => {
          const project = projects.get(thread.projectId)!;
          let response: SavedResponse | null = null;
          try {
            response = await this.responseFor(thread);
          } catch {
            /* Missing provider state is a per-card empty state. */
          }
          const status = commandThreadStatus(thread, terminal, response?.activity);
          const savedAt = response?.activity?.at ?? response?.at;
          const reviewAt =
            response?.activity?.state === "review"
              ? response.activity.at
              : (response?.at ?? thread.latestTurn?.completedAt ?? at);
          return {
            id: thread.id,
            projectId: thread.projectId,
            projectTitle: project.title,
            title: thread.title,
            agent: thread.cliKind ?? thread.modelSelection.provider,
            cwd: thread.worktreePath ?? project.workspaceRoot,
            status,
            reviewAt,
            statusVersion: JSON.stringify([
              status,
              terminal?.lastInputAt,
              response?.activity?.at,
              response?.at,
              thread.latestTurn?.completedAt,
            ]),
            lastActivityAt: savedAt && Date.parse(savedAt) > Date.parse(at) ? savedAt : at,
            response: response?.text ?? null,
            responseAt: response?.at ?? null,
            responseTruncated: response?.truncated ?? false,
          };
        }),
      );
      results.push(...batch);
    }
    results.sort(
      (a, b) =>
        Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) || a.id.localeCompare(b.id),
    );
    return {
      threads: results,
      totalThreads: candidates.length,
      generatedAt: new Date().toISOString(),
    };
  }
}

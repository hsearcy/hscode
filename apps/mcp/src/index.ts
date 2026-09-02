#!/usr/bin/env bun
// hscode-mcp: expose HS Code thread terminals as MCP tools.
//
// Reads thread metadata directly from ~/.hscode/userdata/state.sqlite (concurrent
// readers are safe in WAL mode) and drives terminals via the HS Code WebSocket
// API (terminal.open / terminal.write + terminal.event push).

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { lastAssistantTurn, lastMeaningfulLines, renderTerminal } from "./ansi.ts";
import {
  DpcodeDb,
  DpcodeWs,
  loadConfig,
  type ProjectRow,
  type TerminalActivity,
  type ThreadRow,
} from "./dpcodeClient.ts";
import {
  cloneRepo,
  commandAvailable,
  deriveProjectsRoot,
  gitAvailable,
  isDirEmptyOrMissing,
  isGitRepo,
  isInside,
  normalizeWorkspacePath,
  parseGitRepoUrl,
  resolveCloneTarget,
  scrubCredentials,
} from "./projects.ts";
import {
  findEquivalentSubscription,
  loadSubscriptions as loadSubscriptionsFromDisk,
  type PersistedSubscription,
  reconcileSubscriptions,
  type RuntimeSubscription,
  saveSubscriptions,
  type ScreenScope,
} from "./subscriptionStore.ts";
import { sendTerminalInput } from "./terminalInput.ts";
import { createThreadEventGate } from "./threadEventGate.ts";
import {
  claimWebhookDelivery,
  pruneWebhookDeliveryClaims,
} from "./webhookDeliveryClaims.ts";

const DEFAULT_MODEL_BY_PROVIDER = {
  codex: "gpt-5.5",
  claudeAgent: "claude-sonnet-4-6",
} as const;

function resolveProject(input: string): ProjectRow {
  const matches = db.findProjects(input, 5);
  if (matches.length === 0) {
    throw new Error(`no project found matching "${input}"`);
  }
  if (matches.length > 1) {
    const listed = matches
      .map((m) => `  - ${m.title} (${m.workspaceRoot}) [${m.projectId}]`)
      .join("\n");
    throw new Error(
      `"${input}" matched ${matches.length} projects — narrow the query or pass the projectId:\n${listed}`,
    );
  }
  return matches[0]!;
}

// ── Project provisioning ─────────────────────────────────────────────────

type ProvisionProvider = "claude" | "codex";

function providerKindFor(provider: ProvisionProvider): "claudeAgent" | "codex" {
  return provider === "claude" ? "claudeAgent" : "codex";
}

function defaultModelSelectionFor(provider: ProvisionProvider) {
  const kind = providerKindFor(provider);
  return { provider: kind, model: DEFAULT_MODEL_BY_PROVIDER[kind] };
}

// Find an already-registered project whose workspace root matches `root`
// (path-normalized), so registration is idempotent even if the caller passes a
// trailing slash or a slightly different spelling of the same directory.
function findProjectByWorkspaceRoot(root: string): ProjectRow | null {
  const target = normalizeWorkspacePath(root);
  for (const project of db.listProjects({ limit: 1000 })) {
    if (normalizeWorkspacePath(project.workspaceRoot) === target) return project;
  }
  return null;
}

// Resolve the default directory clones land in: the Settings-configured value
// (app_config table) wins, then HSCODE_PROJECTS_ROOT, then the parent that
// already holds the most registered projects, then ~/git.
function projectsRoot(): string {
  return deriveProjectsRoot({
    configuredRoot: db.getAppConfig("projectsRoot"),
    envRoot: process.env.HSCODE_PROJECTS_ROOT,
    existingWorkspaceRoots: db.listProjects({ limit: 1000 }).map((p) => p.workspaceRoot),
    home: homedir(),
  });
}

interface RegisterResult {
  project: ProjectRow;
  created: boolean;
}

// Register a project at `workspaceRoot` via the orchestration `project.create`
// command, deduping against existing projects first and recovering gracefully
// if the server reports a duplicate (projection lag race). The returned project
// uses the id we generated; we don't block on the projection catching up.
async function registerProject(opts: {
  title: string;
  workspaceRoot: string;
  provider: ProvisionProvider;
  createWorkspaceRootIfMissing: boolean;
}): Promise<RegisterResult> {
  const workspaceRoot = normalizeWorkspacePath(opts.workspaceRoot);
  const existing = findProjectByWorkspaceRoot(workspaceRoot);
  if (existing) return { project: existing, created: false };

  const projectId = randomUUID();
  const title = opts.title.trim() || workspaceRoot;
  try {
    await ws.dispatchOrchestrationCommand({
      type: "project.create",
      commandId: randomUUID(),
      projectId,
      kind: "project",
      title,
      workspaceRoot,
      createWorkspaceRootIfMissing: opts.createWorkspaceRootIfMissing,
      defaultModelSelection: defaultModelSelectionFor(opts.provider),
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    // The decider rejects a duplicate workspace root. If a project for this
    // root already exists (e.g. registered moments ago, projection still
    // catching up), recover it instead of surfacing the error.
    const message = error instanceof Error ? error.message : String(error);
    if (/already uses workspace root/i.test(message)) {
      const recovered = findProjectByWorkspaceRoot(workspaceRoot);
      if (recovered) return { project: recovered, created: false };
    }
    throw error instanceof Error ? error : new Error(message);
  }
  return { project: { projectId, title, workspaceRoot }, created: true };
}

const cfg = loadConfig();
const db = new DpcodeDb(cfg.homeDir);
const ws = new DpcodeWs(cfg);

// ── Global thread-event subscriptions (webhook fan-out) ──────────────────
//
// Remote callers register a webhook once and hscode-mcp POSTs to it every
// time *any* thread's agentState transitions. Events only flow for terminals
// the server has opened (web client, another MCP, or this process via
// read_thread/notify_on_idle), so newly created threads won't appear until
// someone opens them.

const subscriptions = new Map<string, RuntimeSubscription>();
let pushHandlerInstalled = false;

// Subscriptions outlive the MCP process: persist them to disk so a
// stop/start (e.g. picking up new code) doesn't force every remote client
// to re-subscribe. Only the durable fields are stored — throttle state
// (lastFiredAt) and timers are transient and reset on load.
const SUBSCRIPTIONS_PATH = join(cfg.homeDir, "userdata", "mcp-subscriptions.json");
const WEBHOOK_CLAIMS_PATH = join(cfg.homeDir, "userdata", "mcp-webhook-delivery-claims");
const WEBHOOK_CLAIM_RETENTION_MS = 24 * 60 * 60 * 1000;

function persistSubscriptions(): void {
  const rows: PersistedSubscription[] = Array.from(subscriptions.values()).map((s) => ({
    id: s.id,
    url: s.url,
    headers: s.headers,
    states: s.states,
    screenScope: s.screenScope,
    minIntervalMs: s.minIntervalMs,
  }));
  saveSubscriptions(SUBSCRIPTIONS_PATH, rows);
}

function loadSubscriptions(): number {
  reconcileSubscriptions(subscriptions, loadSubscriptionsFromDisk(SUBSCRIPTIONS_PATH));
  return subscriptions.size;
}

// Stabilization gate: transient attention (auto-allowed permission prompts)
// and Claude review churn (Stop while stop hooks / background subagents are
// still working) are held until the state sticks — see threadEventGate.ts.
const threadEventGate = createThreadEventGate({
  forward: (input) => {
    // The file is the source of truth across stdio MCP processes. Refresh it
    // here so an old process cannot keep a removed subscription in memory.
    loadSubscriptions();
    if (subscriptions.size === 0) return;
    void fanOutThreadEvent(input);
  },
});

function ensureGlobalPushHandler(): void {
  if (pushHandlerInstalled) return;
  pushHandlerInstalled = true;
  // Keep the WS to the desktop backend alive while subscriptions are active.
  // Without this, a restart race (MCP up before the backend) or a later
  // desktop restart closes the socket with nothing to reopen it, so restored
  // subscriptions stop delivering until someone manually re-subscribes.
  ws.enableAutoReconnect();
  ws.onPush((channel, data) => {
    if (channel !== "terminal.event" || !data || typeof data !== "object") return;
    loadSubscriptions();
    threadEventGate.handleActivity(data as Record<string, unknown>);
  });
}

async function fanOutThreadEvent(input: {
  threadId: string;
  state: string | null;
  ev: Record<string, unknown>;
}): Promise<void> {
  // Look up the thread row once — gives us project/title context for the
  // payload and the cwd needed to render the screen.
  const row = db.getThread(input.threadId);
  // Resolve the rendered scrollback once if anyone wants it. We render the
  // full thing here and let each subscriber pick its slice (tail vs lastTurn).
  let renderedText: string | null = null;
  const needsScreen = Array.from(subscriptions.values()).some((s) => s.screenScope !== "off");
  if (needsScreen && row) {
    try {
      // Peek only — rendering a notification screen must not wake a slept
      // CLI session.
      const snap = await ws.openTerminal({
        threadId: row.threadId,
        cwd: row.worktreePath ?? row.workspaceRoot,
        wake: false,
      });
      renderedText = await renderTerminal(snap.history);
    } catch {
      // Best-effort.
    }
  }
  const firedAt = new Date().toISOString();
  // Rendering can take time. Refresh again immediately before delivery so an
  // unsubscribe from another MCP process takes effect without a restart.
  loadSubscriptions();
  await Promise.all(
    Array.from(subscriptions.values()).map(async (sub) => {
      if (
        sub.states.length > 0 &&
        (!input.state || !sub.states.includes(input.state as "running" | "attention" | "review"))
      ) {
        return;
      }
      if (sub.minIntervalMs > 0) {
        const now = Date.now();
        const last = sub.lastFiredAt.get(input.threadId) ?? 0;
        if (now - last < sub.minIntervalMs) return;
        sub.lastFiredAt.set(input.threadId, now);
      }
      const payload: Record<string, unknown> = {
        subscriptionId: sub.id,
        threadId: input.threadId,
        threadTitle: row?.title ?? null,
        project: row?.projectTitle ?? null,
        workspaceRoot: row?.workspaceRoot ?? null,
        agentState: input.state,
        firedAt,
        activity: input.ev,
      };
      if (sub.screenScope !== "off" && renderedText !== null) {
        payload.screen =
          sub.screenScope === "lastTurn"
            ? lastAssistantTurn(renderedText)
            : lastMeaningfulLines(renderedText, 80);
        payload.screenScope = sub.screenScope;
      }
      // Stdio MCP hosts start one process per client. All of those processes
      // can receive this same terminal event and restore this same durable
      // subscription. An atomic claim file makes exactly one of them the
      // sender for this subscription event.
      if (!claimWebhookDelivery(WEBHOOK_CLAIMS_PATH, sub.id, input.ev)) return;
      try {
        await fetch(sub.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...sub.headers },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        console.error(
          `[hscode-mcp] subscribe_threads: POST to ${sub.url} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
}

function describeRow(row: ThreadRow, activity?: TerminalActivity | null) {
  return {
    threadId: row.threadId,
    title: row.title,
    project: row.projectTitle,
    workspaceRoot: row.workspaceRoot,
    cliKind: row.cliKind,
    cliSessionId: row.cliSessionId,
    branch: row.branch,
    worktreePath: row.worktreePath,
    updatedAt: row.updatedAt,
    latestUserMessageAt: row.latestUserMessageAt,
    pendingApprovalCount: row.pendingApprovalCount,
    pendingUserInputCount: row.pendingUserInputCount,
    archived: row.archived,
    // Activity is only known for terminals the server has emitted events for
    // since this MCP process connected. Null means "no event observed yet".
    agentState: activity?.agentState ?? null,
    hasRunningSubprocess: activity?.hasRunningSubprocess ?? null,
  };
}

function resolveThread(input: string): ThreadRow {
  // Accept either an exact thread id (UUID) or a title fuzzy-match.
  const byId = db.getThread(input);
  if (byId) return byId;
  const rows = db.listThreads({ query: input, limit: 5 });
  if (rows.length === 0) {
    throw new Error(`no thread found matching "${input}"`);
  }
  if (rows.length > 1) {
    const titles = rows.map((r) => `  - ${r.title} (${r.threadId})`).join("\n");
    throw new Error(
      `"${input}" matched ${rows.length} threads — pass the threadId instead:\n${titles}`,
    );
  }
  return rows[0]!;
}

// Keep the reset key events separate so that the terminal and TUI process them
// in order. This is long enough for a local PTY without delaying every prompt.
const TERMINAL_INPUT_KEY_SETTLE_MS = 100;

async function writeThreadInput(row: ThreadRow, text: string, submit: boolean): Promise<number> {
  const openSnap = await ws.openTerminal({
    threadId: row.threadId,
    cwd: row.worktreePath ?? row.workspaceRoot,
  });
  if (openSnap.wokeFromSleep) {
    // The open() respawned a slept PTY and the server typed the CLI resume
    // command. Wait until the TUI can accept input instead of writing into the
    // shell or a half-drawn composer.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  return sendTerminalInput(
    {
      write: (data) => ws.writeTerminal({ threadId: row.threadId, data }),
      settle: () => new Promise((resolve) => setTimeout(resolve, TERMINAL_INPUT_KEY_SETTLE_MS)),
    },
    text,
    submit,
  );
}

function makeServer(): McpServer {
  const server = new McpServer({
    name: "hscode-mcp",
    version: "0.0.1",
  });
  registerTools(server);
  return server;
}

function registerTools(server: McpServer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    "list_threads",
    {
      description:
        "List HS Code threads (Claude/Codex terminal sessions). Filter by project name/path or thread title. Sorted by latest user-message time, then by updatedAt.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Filter by project title or workspace path (substring match)."),
        query: z.string().optional().describe("Substring match against thread titles."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 25."),
        includeArchived: z.boolean().optional().describe("Default false."),
      },
    },
    async (args: {
      project?: string;
      query?: string;
      limit?: number;
      includeArchived?: boolean;
    }) => {
      const rows = db.listThreads({
        project: args.project,
        query: args.query,
        limit: args.limit,
        includeArchived: args.includeArchived,
      });
      const threads = rows.map((r) => describeRow(r, ws.getActivity(r.threadId)));
      return {
        content: [{ type: "text", text: JSON.stringify({ threads }, null, 2) }],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    "read_thread",
    {
      description:
        "Read the rendered terminal scrollback of an HS Code thread. Returns the last `lines` lines of meaningful content (spinner glyphs filtered out), default 80.\n\n" +
        "Interpreting the output (Claude Code / Codex TUI):\n" +
        "- Lines starting with `> ` (chat-bubble blocks in scrollback) are messages the USER actually sent. These are historical.\n" +
        "- Lines starting with `● ` are messages the ASSISTANT sent (Claude's responses, tool calls).\n" +
        "- A single line near the bottom that looks like `❯ <text>` bracketed by two horizontal rule lines (`────...`) is the CURRENT INPUT BOX DRAFT — text auto-populated by the CLI (e.g. a suggested next prompt) that has NOT been sent yet. Treat it as a draft, not a message.\n" +
        "- `✻ Cooked for Ns` / `※ recap: ...` / `⏵⏵ auto mode on ...` are TUI status decorations, not user/assistant content.\n" +
        "- If the screen looks sparse or all spinner-like, the CLI is mid-turn; either `wait_for_attention` or call `read_thread` again shortly.",
      inputSchema: {
        thread: z
          .string()
          .describe("Thread id (UUID) or a title fragment that uniquely identifies a thread."),
        lines: z.number().int().min(1).max(2000).optional().describe("Default 60."),
      },
    },
    async (args: { thread: string; lines?: number }) => {
      const row = resolveThread(args.thread);
      // Peek only — reading a thread must not wake a slept CLI session.
      const snap = await ws.openTerminal({
        threadId: row.threadId,
        cwd: row.worktreePath ?? row.workspaceRoot,
        wake: false,
      });
      const text = await renderTerminal(snap.history);
      const tail = lastMeaningfulLines(text, args.lines ?? 80);
      const activity = ws.getActivity(row.threadId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                thread: describeRow(row, activity),
                terminal: {
                  terminalId: snap.terminalId,
                  cwd: snap.cwd,
                  status: snap.status,
                  pid: snap.pid,
                  updatedAt: snap.updatedAt,
                },
                screen: tail,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    "send_input",
    {
      description:
        "Send text to an HS Code thread's terminal. By default, this writes the complete text, clears Codex paste-burst state with a temporary non-ASCII marker that it immediately deletes, and sends Enter separately. The submitted prompt does not contain the marker. Multiline text and a trailing line feed are preserved as prompt content. Set `submit: false` to type partial input without Enter. If a draft remains in the composer, use `submit_input`. WARNING: Before sending a normal chat message, call `read_thread` to confirm the CLI isn't sitting on an interactive prompt that would consume your text as a menu choice.",
      inputSchema: {
        thread: z.string().describe("Thread id (UUID) or unique title fragment."),
        text: z
          .string()
          .min(1)
          .describe(
            "Prompt text to type. Pass real multiline text, not escape notation such as the literal characters \\r.",
          ),
        submit: z
          .boolean()
          .optional()
          .describe(
            "If true (default), clear paste-burst state and send Enter separately after the prompt text.",
          ),
      },
    },
    async (args: { thread: string; text: string; submit?: boolean }) => {
      const row = resolveThread(args.thread);
      const submit = args.submit ?? true;
      const bytesSent = await writeThreadInput(row, args.text, submit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                threadId: row.threadId,
                bytesSent,
                submitRequested: submit,
                pasteStateReset: submit,
                enterSentSeparately: submit,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    "submit_input",
    {
      description:
        "Clear Codex paste-burst state, then send Enter to an HS Code thread. Use this as a fallback only after `read_thread` confirms that text from an earlier `send_input` call is still in the Codex or Claude composer. The tool types a temporary non-ASCII marker and deletes it before submission, so the draft text is unchanged.",
      inputSchema: {
        thread: z.string().describe("Thread id (UUID) or unique title fragment."),
      },
    },
    async (args: { thread: string }) => {
      const row = resolveThread(args.thread);
      const bytesSent = await writeThreadInput(row, "", true);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                threadId: row.threadId,
                bytesSent,
                pasteStateReset: true,
                enterSent: true,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    "interrupt",
    {
      description:
        "Send an interrupt (Ctrl+C, byte \\x03) to an HS Code thread's terminal — equivalent to pressing Ctrl+C in the CLI. Use this to cancel the agent's in-progress turn, dismiss an interactive prompt, or stop a long-running command. By default sends a single Ctrl+C; set `count` higher to send several in a row (some CLIs require a double Ctrl+C to exit). This sends a signal-style control byte, not chat text — to type a message use `send_input` instead.",
      inputSchema: {
        thread: z.string().describe("Thread id (UUID) or unique title fragment."),
        count: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe(
            "How many Ctrl+C bytes to send (default 1). Use 2 for CLIs that need a double interrupt to exit.",
          ),
      },
    },
    async (args: { thread: string; count?: number }) => {
      const row = resolveThread(args.thread);
      // Peek only — a slept session has nothing to interrupt, and waking a
      // CLI just to Ctrl+C it would be counterproductive. Writes to a slept
      // session are silently dropped by the server.
      await ws.openTerminal({
        threadId: row.threadId,
        cwd: row.worktreePath ?? row.workspaceRoot,
        wake: false,
      });
      const count = args.count ?? 1;
      const data = "\x03".repeat(count);
      let delivered = true;
      try {
        await ws.writeTerminal({ threadId: row.threadId, data });
      } catch {
        // No live session for this thread — nothing to interrupt.
        delivered = false;
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                threadId: row.threadId,
                interrupts: count,
                bytesSent: delivered ? Buffer.byteLength(data, "utf8") : 0,
                ...(delivered ? {} : { note: "no live terminal session; nothing to interrupt" }),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    "wait_for_attention",
    {
      description:
        'Block until the HS Code thread\'s CLI is idle — either it has finished a turn (agentState="review") or it is sitting on a permission prompt (agentState="attention") — or until the timeout elapses. Returns the latest activity record and a fresh screen snapshot. Useful after send_input to know when the CLI has finished responding and is ready for the next instruction.\n\nNote: in this codebase "review" is the post-turn idle state (CLI just stopped streaming) and "attention" is specifically a permission/approval prompt. By default this waits for either. Set permissionPromptOnly=true to wait only for an approval prompt.',
      inputSchema: {
        thread: z.string().describe("Thread id (UUID) or unique title fragment."),
        timeoutSeconds: z.number().int().min(1).max(900).optional().describe("Default 120."),
        permissionPromptOnly: z
          .boolean()
          .optional()
          .describe(
            'If true, only return when agentState="attention" (CLI is waiting on an approval prompt). Default false — also returns on agentState="review" (turn complete).',
          ),
      },
    },
    async (args: { thread: string; timeoutSeconds?: number; permissionPromptOnly?: boolean }) => {
      const row = resolveThread(args.thread);
      const target: ("attention" | "review")[] = args.permissionPromptOnly
        ? ["attention"]
        : ["attention", "review"];
      // Peek first: a slept session IS idle — answer immediately instead of
      // waking the CLI just to watch it sit at a finished turn.
      const peek = await ws.openTerminal({
        threadId: row.threadId,
        cwd: row.worktreePath ?? row.workspaceRoot,
        wake: false,
      });
      if (peek.status === "slept") {
        const sleptText = await renderTerminal(peek.history);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  threadId: row.threadId,
                  slept: true,
                  activity: null,
                  // A slept session finished its last turn ("review"). It can
                  // never reach an approval prompt while asleep, so a
                  // permission-only wait reports timedOut immediately.
                  agentState: args.permissionPromptOnly ? null : "review",
                  timedOut: args.permissionPromptOnly === true,
                  screen: lastMeaningfulLines(sleptText, 80),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (peek.status !== "running" && peek.status !== "starting") {
        // Exited or errored shell — restore the legacy behavior of reviving
        // the session so activity events can flow again.
        await ws.openTerminal({
          threadId: row.threadId,
          cwd: row.worktreePath ?? row.workspaceRoot,
        });
      }
      const activity = await ws.waitForAgentState(
        row.threadId,
        target,
        (args.timeoutSeconds ?? 120) * 1000,
      );
      // Re-fetch a fresh snapshot to return the current screen (peek only —
      // the session may have slept while we waited).
      const snap = await ws.openTerminal({
        threadId: row.threadId,
        cwd: row.worktreePath ?? row.workspaceRoot,
        wake: false,
      });
      const text = await renderTerminal(snap.history);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                threadId: row.threadId,
                activity,
                timedOut:
                  !activity || activity.agentState == null
                    ? true
                    : !target.includes(activity.agentState as "attention" | "review"),
                screen: lastMeaningfulLines(text, 80),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    "notify_on_idle",
    {
      description:
        'Register a webhook to be called when an HS Code thread\'s CLI goes idle (turn complete or sitting on an approval prompt). Unlike `wait_for_attention`, this returns IMMEDIATELY — the caller\'s turn is not blocked. A background watcher POSTs JSON to `notifyUrl` once the thread reaches the target agent state (`review` for turn-complete, `attention` for permission prompt) or when the timeout elapses. Useful for remote agents that should not hold an HTTP request open for minutes.\n\nWebhook body (POST, content-type application/json):\n```\n{\n  "threadId": "<uuid>",\n  "agentState": "review" | "attention" | null,\n  "timedOut": boolean,\n  "screen": "<last 80 meaningful lines of terminal scrollback>",\n  "activity": { ... raw activity record ... } | null\n}\n```\nThe webhook is best-effort: failures to POST are logged but not retried.',
      inputSchema: {
        thread: z.string().describe("Thread id (UUID) or unique title fragment."),
        notifyUrl: z
          .string()
          .url()
          .describe("Absolute http(s) URL to POST to when the thread goes idle (or times out)."),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(3600)
          .optional()
          .describe("Default 600 (10 min). Webhook still fires on timeout with timedOut=true."),
        permissionPromptOnly: z
          .boolean()
          .optional()
          .describe(
            'If true, only fire on agentState="attention" (approval prompt). Default false — also fires on "review" (turn complete).',
          ),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Optional extra HTTP headers to send with the webhook POST (e.g. an auth token).",
          ),
      },
    },
    async (args: {
      thread: string;
      notifyUrl: string;
      timeoutSeconds?: number;
      permissionPromptOnly?: boolean;
      headers?: Record<string, string>;
    }) => {
      const row = resolveThread(args.thread);
      // Peek only: a slept session is already idle, and waking it just to
      // watch for idleness would undo the server's idle-sleep policy.
      const peek = await ws.openTerminal({
        threadId: row.threadId,
        cwd: row.worktreePath ?? row.workspaceRoot,
        wake: false,
      });
      if (peek.status !== "slept" && peek.status !== "running" && peek.status !== "starting") {
        // Exited or errored shell — revive it so activity events can flow.
        await ws.openTerminal({
          threadId: row.threadId,
          cwd: row.worktreePath ?? row.workspaceRoot,
        });
      }
      const target: ("attention" | "review")[] = args.permissionPromptOnly
        ? ["attention"]
        : ["attention", "review"];
      const timeoutSeconds = args.timeoutSeconds ?? 600;
      const scheduledAt = new Date().toISOString();
      // Fire-and-forget: the tool replies immediately; the watcher posts later.
      void (async () => {
        let payload: Record<string, unknown>;
        try {
          if (peek.status === "slept") {
            // Slept = the CLI finished its last turn and was idle long
            // enough to be put to sleep. Report idleness immediately.
            const sleptText = await renderTerminal(peek.history);
            payload = {
              threadId: row.threadId,
              threadTitle: row.title,
              project: row.projectTitle,
              workspaceRoot: row.workspaceRoot,
              slept: true,
              agentState: args.permissionPromptOnly ? null : "review",
              timedOut: args.permissionPromptOnly === true,
              screen: lastMeaningfulLines(sleptText, 80),
              activity: null,
              scheduledAt,
              firedAt: new Date().toISOString(),
            };
          } else {
            const activity = await ws.waitForAgentState(
              row.threadId,
              target,
              timeoutSeconds * 1000,
            );
            const snap = await ws.openTerminal({
              threadId: row.threadId,
              cwd: row.worktreePath ?? row.workspaceRoot,
              wake: false,
            });
            const text = await renderTerminal(snap.history);
            const screen = lastMeaningfulLines(text, 80);
            const state = activity?.agentState ?? null;
            payload = {
              threadId: row.threadId,
              threadTitle: row.title,
              project: row.projectTitle,
              workspaceRoot: row.workspaceRoot,
              agentState: state,
              timedOut: !state || !target.includes(state as "attention" | "review"),
              screen,
              activity,
              scheduledAt,
              firedAt: new Date().toISOString(),
            };
          }
        } catch (err) {
          payload = {
            threadId: row.threadId,
            threadTitle: row.title,
            project: row.projectTitle,
            workspaceRoot: row.workspaceRoot,
            error: err instanceof Error ? err.message : String(err),
            scheduledAt,
            firedAt: new Date().toISOString(),
          };
        }
        try {
          await fetch(args.notifyUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(args.headers ?? {}),
            },
            body: JSON.stringify(payload),
          });
        } catch (err) {
          // Best-effort. Log to stderr so it shows up in the MCP server logs.
          console.error(
            `[hscode-mcp] notify_on_idle: POST to ${args.notifyUrl} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      })();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                watching: true,
                threadId: row.threadId,
                notifyUrl: args.notifyUrl,
                target,
                timeoutSeconds,
                scheduledAt,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    "subscribe_threads",
    {
      description:
        'Register a webhook to receive a POST every time ANY HS Code thread\'s CLI reaches an idle state (turn complete / approval prompt). Use this when a remote orchestrator wants to be paged about every thread without polling. Returns a `subscriptionId` you can pass to `unsubscribe_threads`.\n\nCaveats:\n- Events only flow for terminals the HS Code server has opened. New threads created via `start_thread` automatically open their terminal; others remain silent until something (the web UI, another MCP call) opens them.\n- The subscription is persisted to disk and restored automatically when hscode-mcp restarts (e.g. after a WSL/desktop restart), so you do NOT need to re-subscribe. The MCP also auto-reconnects to the desktop backend, so delivery resumes once the backend is back up.\n- Only state TRANSITIONS fire — repeated activity events with the same agentState are suppressed.\n- By default `running` transitions are NOT forwarded (they fire on every turn start and produce noise). Pass `states: ["running", "review", "attention"]` if you really want them.\n- Per-thread throttle: each (thread, subscription) pair is rate-limited to one POST per `minIntervalMs` (default 2000 ms) to absorb tight loops where a subscriber\'s reply immediately triggers the next turn.\n\nWebhook body (POST, content-type application/json):\n```\n{\n  "subscriptionId": "<uuid>",\n  "threadId": "<uuid>",\n  "threadTitle": "<thread title>",\n  "project": "<project name>",\n  "workspaceRoot": "<absolute path>",\n  "agentState": "running" | "review" | "attention" | null,\n  "firedAt": "<iso>",\n  "activity": { ... raw activity event ... },\n  "screen": "<assistant turn / tail, if screenScope != off>"\n}\n```',
      inputSchema: {
        notifyUrl: z
          .string()
          .url()
          .describe("Absolute http(s) URL to POST every matching thread event to."),
        states: z
          .array(z.enum(["running", "attention", "review"]))
          .optional()
          .describe(
            'Which agentState transitions to forward. Default ["review", "attention"] — only idle states. Pass [] (empty) to forward EVERY transition including "running" and null/idle.',
          ),
        includeScreen: z
          .boolean()
          .optional()
          .describe(
            'DEPRECATED — use `screenScope` instead. If true (and screenScope is omitted), behaves as screenScope="lastTurn".',
          ),
        screenScope: z
          .enum(["off", "tail", "lastTurn"])
          .optional()
          .describe(
            'What slice of the terminal to include in `screen`. "off" (default) omits the screen entirely. "lastTurn" returns just the assistant\'s most recent response (everything below the last user-message marker, with the input composer stripped) — usually what you want to know "what just happened". "tail" returns the last 80 meaningful lines, like read_thread.',
          ),
        minIntervalMs: z
          .number()
          .int()
          .min(0)
          .max(60000)
          .optional()
          .describe(
            "Minimum milliseconds between POSTs for the same thread on this subscription. Default 2000 (2 s). Set to 0 to disable throttling.",
          ),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Optional extra HTTP headers (e.g. an auth token)."),
      },
    },
    async (args: {
      notifyUrl: string;
      states?: Array<"running" | "attention" | "review">;
      includeScreen?: boolean;
      screenScope?: ScreenScope;
      minIntervalMs?: number;
      headers?: Record<string, string>;
    }) => {
      // Make sure the WS is connected so we receive terminal.event pushes.
      await ws.connect();
      ensureGlobalPushHandler();
      loadSubscriptions();
      // Resolve the screen scope from the new field, falling back to the
      // legacy boolean. Default: "off" (no screen) — explicit opt-in only.
      let screenScope: ScreenScope;
      if (args.screenScope) {
        screenScope = args.screenScope;
      } else if (args.includeScreen === true) {
        screenScope = "lastTurn";
      } else {
        screenScope = "off";
      }
      const requested = {
        url: args.notifyUrl,
        headers: args.headers ?? {},
        states: args.states ?? ["review", "attention"],
        screenScope,
        minIntervalMs: args.minIntervalMs ?? 2000,
      } satisfies Omit<PersistedSubscription, "id">;
      const existing = findEquivalentSubscription(Array.from(subscriptions.values()), requested);
      if (existing) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  created: false,
                  subscriptionId: existing.id,
                  notifyUrl: existing.url,
                  states: existing.states,
                  screenScope: existing.screenScope,
                  minIntervalMs: existing.minIntervalMs,
                  activeSubscriptions: subscriptions.size,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const id = randomUUID();
      const sub: RuntimeSubscription = {
        id,
        ...requested,
        lastFiredAt: new Map(),
      };
      subscriptions.set(id, sub);
      persistSubscriptions();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                created: true,
                subscriptionId: id,
                notifyUrl: sub.url,
                states: sub.states,
                screenScope: sub.screenScope,
                minIntervalMs: sub.minIntervalMs,
                activeSubscriptions: subscriptions.size,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    "unsubscribe_threads",
    {
      description:
        "Remove a webhook subscription previously registered with `subscribe_threads`. If `subscriptionId` is omitted, removes ALL subscriptions.",
      inputSchema: {
        subscriptionId: z
          .string()
          .optional()
          .describe("Subscription id returned by subscribe_threads. Omit to clear all."),
      },
    },
    async (args: { subscriptionId?: string }) => {
      loadSubscriptions();
      let removed: number;
      if (args.subscriptionId) {
        removed = subscriptions.delete(args.subscriptionId) ? 1 : 0;
      } else {
        removed = subscriptions.size;
        subscriptions.clear();
      }
      persistSubscriptions();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, removed, activeSubscriptions: subscriptions.size },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    "list_subscriptions",
    {
      description: "List active webhook subscriptions registered via `subscribe_threads`.",
      inputSchema: {},
    },
    async () => {
      loadSubscriptions();
      const list = Array.from(subscriptions.values()).map((s) => ({
        subscriptionId: s.id,
        notifyUrl: s.url,
        states: s.states,
        screenScope: s.screenScope,
        minIntervalMs: s.minIntervalMs,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ subscriptions: list }, null, 2) }],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    "start_thread",
    {
      description:
        "Create a new HS Code terminal thread that launches a Claude Code or Codex CLI session in the target project — equivalent to the desktop app's \"New Thread → Claude Code / Codex\" button. The thread is created in terminal-cli mode with the project's local workspace; the CLI starts as soon as the terminal is opened. Returns the new threadId so you can immediately drive it with `send_input` / `read_thread` / `wait_for_attention`.",
      inputSchema: {
        project: z
          .string()
          .describe(
            "Project to start the thread in. Matches against project title or workspace path (substring).",
          ),
        provider: z
          .enum(["claude", "codex"])
          .describe('Which CLI to launch. "claude" runs Claude Code, "codex" runs Codex.'),
        title: z
          .string()
          .optional()
          .describe(
            'Optional thread title. Defaults to "Claude Code — <project>" or "Codex — <project>".',
          ),
        openTerminal: z
          .boolean()
          .optional()
          .describe(
            "If true (default), also open the terminal session so the CLI actually starts. Set to false to create the thread without spawning the CLI yet.",
          ),
      },
    },
    async (args: {
      project: string;
      provider: "claude" | "codex";
      title?: string;
      openTerminal?: boolean;
    }) => {
      const project = resolveProject(args.project);
      const cliKind = args.provider; // "claude" | "codex" — matches TerminalCliKind in contracts
      const providerKind = cliKind === "claude" ? "claudeAgent" : "codex";
      const model = DEFAULT_MODEL_BY_PROVIDER[providerKind];
      const cliLabel = cliKind === "claude" ? "Claude Code" : "Codex";
      const title = args.title?.trim() || `${cliLabel} — ${project.title}`;
      const threadId = randomUUID();
      const createdAt = new Date().toISOString();
      const dispatched = await ws.dispatchOrchestrationCommand({
        type: "thread.create",
        commandId: randomUUID(),
        threadId,
        projectId: project.projectId,
        title,
        modelSelection: { provider: providerKind, model },
        runtimeMode: "full-access",
        interactionMode: "terminal-cli",
        envMode: "local",
        branch: null,
        worktreePath: null,
        cliKind,
        createdAt,
      });
      let terminal: Awaited<ReturnType<typeof ws.openTerminal>> | null = null;
      if (args.openTerminal !== false) {
        terminal = await ws.openTerminal({
          threadId,
          cwd: project.workspaceRoot,
        });
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                threadId,
                projectId: project.projectId,
                project: { title: project.title, workspaceRoot: project.workspaceRoot },
                title,
                provider: providerKind,
                cliKind,
                model,
                sequence: dispatched.sequence,
                terminal: terminal
                  ? {
                      terminalId: terminal.terminalId,
                      status: terminal.status,
                      pid: terminal.pid,
                    }
                  : null,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    "list_projects",
    {
      description:
        "List the projects registered in HS Code (the workspaces you can start threads in). Use this FIRST to check whether a repo is already registered before cloning or registering it — match on `workspaceRoot` (the absolute local path) or `title`. Returns each project's projectId, title, and workspaceRoot, plus `providers` (which CLIs — claude/codex — are installed on this machine) and `projectsRoot` (the default directory new repos are cloned into).",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Optional substring filter against project title or workspace path."),
        limit: z.number().int().min(1).max(500).optional().describe("Default 200."),
      },
    },
    async (args: { query?: string; limit?: number }) => {
      const projects = db.listProjects({ query: args.query, limit: args.limit });
      const [claudeOk, codexOk] = await Promise.all([
        commandAvailable("claude"),
        commandAvailable("codex"),
      ]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                projects,
                providers: { claude: claudeOk, codex: codexOk },
                projectsRoot: projectsRoot(),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    "register_project",
    {
      description:
        "Register an existing local directory as an HS Code project so threads can be started in it. The directory must already exist on this machine (use `clone_or_add_github_project` to clone a GitHub repo first). " +
        "Safe by default: `workspacePath` must live inside the projects root (see `projectsRoot` from `list_projects`); registering a directory outside it — which would let future `start_thread` calls run there — requires explicitly passing `allowOutsideProjectsRoot:true`. " +
        "Idempotent: if a project is already registered at that path, the existing one is returned unchanged. After registering, use `start_thread` to launch Claude/Codex in it.",
      inputSchema: {
        workspacePath: z
          .string()
          .min(1)
          .describe(
            "Absolute path to the project directory on the HS Code machine. Must be inside the projects root unless allowOutsideProjectsRoot is set.",
          ),
        title: z
          .string()
          .optional()
          .describe("Display name. Defaults to the directory's base name."),
        defaultProvider: z
          .enum(["claude", "codex"])
          .optional()
          .describe("Default CLI for the project's model selection. Defaults to codex."),
        createWorkspaceRootIfMissing: z
          .boolean()
          .optional()
          .describe(
            "If true, allow registering a path that doesn't exist yet (server creates it). Default false.",
          ),
        allowOutsideProjectsRoot: z
          .boolean()
          .optional()
          .describe(
            "Escape hatch: permit a workspacePath outside the projects root. Default false. Only set this for a path you have deliberately chosen — it lets agents run in arbitrary directories on the machine.",
          ),
      },
    },
    async (args: {
      workspacePath: string;
      title?: string;
      defaultProvider?: ProvisionProvider;
      createWorkspaceRootIfMissing?: boolean;
      allowOutsideProjectsRoot?: boolean;
    }) => {
      const workspacePath = args.workspacePath.trim();
      if (!isAbsolute(workspacePath)) {
        throw new Error(`workspacePath must be an absolute path, got "${workspacePath}".`);
      }
      if (args.allowOutsideProjectsRoot !== true) {
        const root = projectsRoot();
        if (!isInside(root, workspacePath)) {
          throw new Error(
            `refusing to register a path outside the projects root (${root}): ${workspacePath}. ` +
              "Pass allowOutsideProjectsRoot:true to override, or clone/place the project under the projects root.",
          );
        }
      }
      const createIfMissing = args.createWorkspaceRootIfMissing === true;
      if (!createIfMissing && !existsSync(workspacePath)) {
        throw new Error(
          `directory does not exist: ${workspacePath}. Pass createWorkspaceRootIfMissing:true to create it, or clone the repo first.`,
        );
      }
      const title = args.title?.trim() || basename(workspacePath);
      const result = await registerProject({
        title,
        workspaceRoot: workspacePath,
        provider: args.defaultProvider ?? "codex",
        createWorkspaceRootIfMissing: createIfMissing,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, created: result.created, project: result.project },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(
    "clone_or_add_github_project",
    {
      description:
        "Make a GitHub repo available on the HS Code machine and register it as a project, end-to-end. Given a repo URL (https or ssh) or `owner/repo` shorthand, this clones it (if not already present) into the projects root and registers it as an HS Code project so you can immediately `start_thread` in it. Fully idempotent: if the project is already registered, or the directory already exists as a git checkout, it is reused instead of re-cloned. The clone target is always kept inside the projects root — path traversal is rejected, and credentials are never echoed back.",
      inputSchema: {
        repo: z
          .string()
          .min(1)
          .describe(
            'GitHub repo to clone: an https URL ("https://github.com/owner/repo"), ssh URL ("git@github.com:owner/repo.git"), or shorthand ("owner/repo"). Tokens embedded in the URL are stripped from all responses.',
          ),
        title: z
          .string()
          .optional()
          .describe("Project display name. Defaults to the repository name."),
        targetDir: z
          .string()
          .optional()
          .describe(
            "Subdirectory name (relative to the projects root) or absolute path inside it to clone into. Defaults to <projectsRoot>/<repoName>. Paths that escape the projects root are rejected.",
          ),
        defaultProvider: z
          .enum(["claude", "codex"])
          .optional()
          .describe("Default CLI for the project's model selection. Defaults to codex."),
      },
    },
    async (args: {
      repo: string;
      title?: string;
      targetDir?: string;
      defaultProvider?: ProvisionProvider;
    }) => {
      const parsed = parseGitRepoUrl(args.repo);
      if (!parsed) {
        // Scrub before echoing: a malformed URL can still carry a token
        // (e.g. https://x-access-token:SECRET@github.com/...) and must never leak.
        throw new Error(
          `could not parse "${scrubCredentials(args.repo)}" as a GitHub repo. Use an https/ssh URL or "owner/repo".`,
        );
      }
      const root = projectsRoot();
      const targetDir = resolveCloneTarget({
        root,
        repoName: parsed.repoName,
        targetDir: args.targetDir,
      });
      const provider = args.defaultProvider ?? "codex";
      const title = args.title?.trim() || parsed.repoName;

      // Idempotency #1: already registered at this exact path → reuse.
      const already = findProjectByWorkspaceRoot(targetDir);
      let cloned = false;
      if (!already) {
        if (isGitRepo(targetDir)) {
          // Idempotency #2: directory already a git checkout → don't re-clone.
          cloned = false;
        } else if (!isDirEmptyOrMissing(targetDir)) {
          throw new Error(
            `target directory ${targetDir} already exists and is not a git checkout — refusing to overwrite. Pass a different targetDir.`,
          );
        } else {
          if (!(await gitAvailable())) {
            throw new Error("git is not available on the HS Code machine; cannot clone.");
          }
          const clone = await cloneRepo({ cloneUrl: parsed.cloneUrl, targetDir });
          if (!clone.ok) {
            throw new Error(`git clone failed: ${clone.error ?? "unknown error"}`);
          }
          cloned = true;
        }
      }

      const result = already
        ? { project: already, created: false }
        : await registerProject({
            title,
            workspaceRoot: targetDir,
            provider,
            createWorkspaceRootIfMissing: false,
          });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                cloned,
                created: result.created,
                repo: { name: parsed.repoName, slug: parsed.slug, cloneUrl: parsed.cloneUrl },
                project: result.project,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
} // end registerTools

function parseBind(raw: string): { host: string; port: number } {
  // Accepts "host:port", ":port", or "port". Defaults host to 0.0.0.0.
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return { host: "0.0.0.0", port: Number(trimmed) };
  const m = trimmed.match(/^(.*?):(\d+)$/);
  if (!m) throw new Error(`invalid DPCODE_MCP_BIND: ${raw}`);
  return { host: m[1] || "0.0.0.0", port: Number(m[2]) };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function runHttp(bind: { host: string; port: number }, bearer: string | undefined) {
  // The SDK's StreamableHTTPServerTransport in stateless mode (sessionIdGenerator: undefined)
  // is one-shot — it throws on the second handleRequest call. So we mint a fresh
  // McpServer + transport per HTTP request. Tool registration is cheap; the
  // long-lived state (HS Code WS client + activity cache) lives outside the McpServer.
  const http = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (bearer) {
      const header = req.headers["authorization"];
      const provided =
        typeof header === "string" && header.startsWith("Bearer ")
          ? header.slice("Bearer ".length)
          : undefined;
      if (provided !== bearer) {
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", "Bearer");
        res.end("unauthorized");
        return;
      }
    }
    if (req.url && req.url !== "/" && !req.url.startsWith("/mcp")) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined as unknown as () => string,
    });
    const reqServer = makeServer();
    try {
      await (reqServer.connect as (t: unknown) => Promise<void>)(transport);
      const body = await readBody(req);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      process.stderr.write(`[hscode-mcp] http error: ${(err as Error).stack ?? err}\n`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("internal error");
      }
    } finally {
      // Best-effort cleanup; transport closes itself when the response finishes.
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
    }
  });

  await new Promise<void>((resolve) => http.listen(bind.port, bind.host, resolve));
  process.stderr.write(
    `[hscode-mcp] listening on http://${bind.host}:${bind.port}/mcp (bearer: ${bearer ? "required" : "off"})\n`,
  );
}

async function main() {
  // Connect to HS Code first so we start collecting terminal.event activity
  // from the moment the MCP starts.
  try {
    await ws.connect();
  } catch (err) {
    process.stderr.write(
      `[hscode-mcp] failed to connect to ${cfg.wsUrl}: ${(err as Error).message}\n`,
    );
  }

  pruneWebhookDeliveryClaims(WEBHOOK_CLAIMS_PATH, WEBHOOK_CLAIM_RETENTION_MS);

  // Restore webhook subscriptions persisted by a prior process so a
  // stop/start doesn't force remote clients to re-subscribe.
  const restored = loadSubscriptions();
  if (restored > 0) {
    ensureGlobalPushHandler();
    process.stderr.write(`[hscode-mcp] restored ${restored} webhook subscription(s)\n`);
  }

  const bindRaw = process.env.DPCODE_MCP_BIND;
  if (bindRaw) {
    await runHttp(parseBind(bindRaw), process.env.DPCODE_MCP_BEARER || undefined);
    return;
  }
  const transport = new StdioServerTransport();
  const server = makeServer();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[hscode-mcp] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});

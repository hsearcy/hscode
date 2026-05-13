import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import WebSocket from "ws";

export interface DpcodeConfig {
  wsUrl: string | undefined;
  authToken: string | undefined;
  homeDir: string;
}

export function loadConfig(): DpcodeConfig {
  const home = process.env.DPCODE_HOME ?? join(homedir(), ".dpcode");
  // When DPCODE_MCP_URL is set, honor it verbatim. Otherwise leave undefined
  // and let DpcodeWs.connect() rediscover the running desktop backend on every
  // attempt — the AppImage picks an ephemeral port and rotates the auth token
  // on each launch, so static config breaks after a restart.
  const wsUrl = process.env.DPCODE_MCP_URL || undefined;
  const authToken = process.env.DPCODE_AUTH_TOKEN || undefined;
  return { wsUrl, authToken, homeDir: home };
}

// Walks /proc looking for the dpcode desktop backend (electron's child server
// process). Extracts the port + auth token from its environ — they were set
// by the Electron parent and are the only authoritative source.
export function discoverDesktopDpcode(): {
  wsUrl: string;
  authToken: string | undefined;
} | null {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  for (const pid of pids) {
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    // The bundled backend is launched as `dpcode <path>/app.asar/apps/server/dist/index.mjs`.
    if (!cmdline.includes("app.asar/apps/server/dist/index.mjs")) continue;
    let environRaw: string;
    try {
      environRaw = readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch {
      continue;
    }
    const env = new Map<string, string>();
    for (const kv of environRaw.split("\0")) {
      const idx = kv.indexOf("=");
      if (idx > 0) env.set(kv.slice(0, idx), kv.slice(idx + 1));
    }
    const port = env.get("DPCODE_PORT") ?? env.get("T3CODE_PORT");
    if (!port) continue;
    const token = env.get("DPCODE_AUTH_TOKEN") || env.get("T3CODE_AUTH_TOKEN") || undefined;
    const host = env.get("DPCODE_HOST") ?? env.get("T3CODE_HOST") ?? "127.0.0.1";
    return { wsUrl: `ws://${host}:${port}`, authToken: token };
  }
  return null;
}

export interface ProjectRow {
  projectId: string;
  title: string;
  workspaceRoot: string;
}

export interface ThreadRow {
  threadId: string;
  projectId: string;
  projectTitle: string;
  workspaceRoot: string;
  title: string;
  cliKind: string | null;
  cliSessionId: string | null;
  cliLaunchedOnce: boolean;
  worktreePath: string | null;
  branch: string | null;
  updatedAt: string;
  latestUserMessageAt: string | null;
  pendingApprovalCount: number;
  pendingUserInputCount: number;
  archived: boolean;
}

export class DpcodeDb {
  private db: Database;

  constructor(homeDir: string) {
    const dbPath = join(homeDir, "userdata", "state.sqlite");
    this.db = new Database(dbPath, { readonly: true });
    // The server is also reading/writing this file; let WAL handle it.
    this.db.exec("PRAGMA query_only = ON;");
  }

  listThreads(opts: {
    project?: string | undefined;
    query?: string | undefined;
    limit?: number | undefined;
    includeArchived?: boolean | undefined;
  }): ThreadRow[] {
    const conditions = ["t.deleted_at IS NULL"];
    const params: Record<string, string | number> = {};
    if (!opts.includeArchived) conditions.push("t.archived_at IS NULL");
    if (opts.project) {
      conditions.push("(p.title LIKE $project OR p.workspace_root LIKE $project)");
      params.$project = `%${opts.project}%`;
    }
    if (opts.query) {
      conditions.push("t.title LIKE $query");
      params.$query = `%${opts.query}%`;
    }
    const sql = `
      SELECT t.thread_id, t.project_id, p.title AS project_title,
             p.workspace_root, t.title, t.cli_kind, t.cli_session_id,
             t.cli_launched_once, t.worktree_path, t.branch,
             t.updated_at, t.latest_user_message_at,
             t.pending_approval_count, t.pending_user_input_count,
             t.archived_at
      FROM projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY COALESCE(t.latest_user_message_at, t.updated_at) DESC
      LIMIT $limit
    `;
    params.$limit = opts.limit ?? 25;
    const rows = this.db.query(sql).all(params) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      threadId: String(r.thread_id),
      projectId: String(r.project_id),
      projectTitle: String(r.project_title),
      workspaceRoot: String(r.workspace_root),
      title: String(r.title),
      cliKind: r.cli_kind == null ? null : String(r.cli_kind),
      cliSessionId: r.cli_session_id == null ? null : String(r.cli_session_id),
      cliLaunchedOnce: Number(r.cli_launched_once) === 1,
      worktreePath: r.worktree_path == null ? null : String(r.worktree_path),
      branch: r.branch == null ? null : String(r.branch),
      updatedAt: String(r.updated_at),
      latestUserMessageAt:
        r.latest_user_message_at == null ? null : String(r.latest_user_message_at),
      pendingApprovalCount: Number(r.pending_approval_count),
      pendingUserInputCount: Number(r.pending_user_input_count),
      archived: r.archived_at != null,
    }));
  }

  findProjects(query: string, limit = 5): ProjectRow[] {
    const sql = `
      SELECT project_id, title, workspace_root
      FROM projection_projects
      WHERE deleted_at IS NULL
        AND (title LIKE $q OR workspace_root LIKE $q)
      ORDER BY updated_at DESC
      LIMIT $limit
    `;
    const rows = this.db.query(sql).all({ $q: `%${query}%`, $limit: limit }) as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      projectId: String(r.project_id),
      title: String(r.title),
      workspaceRoot: String(r.workspace_root),
    }));
  }

  getThread(threadId: string): ThreadRow | null {
    const sql = `
      SELECT t.thread_id, t.project_id, p.title AS project_title,
             p.workspace_root, t.title, t.cli_kind, t.cli_session_id,
             t.cli_launched_once, t.worktree_path, t.branch,
             t.updated_at, t.latest_user_message_at,
             t.pending_approval_count, t.pending_user_input_count,
             t.archived_at
      FROM projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.thread_id = $id AND t.deleted_at IS NULL
    `;
    const r = this.db.query(sql).get({ $id: threadId }) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      threadId: String(r.thread_id),
      projectId: String(r.project_id),
      projectTitle: String(r.project_title),
      workspaceRoot: String(r.workspace_root),
      title: String(r.title),
      cliKind: r.cli_kind == null ? null : String(r.cli_kind),
      cliSessionId: r.cli_session_id == null ? null : String(r.cli_session_id),
      cliLaunchedOnce: Number(r.cli_launched_once) === 1,
      worktreePath: r.worktree_path == null ? null : String(r.worktree_path),
      branch: r.branch == null ? null : String(r.branch),
      updatedAt: String(r.updated_at),
      latestUserMessageAt:
        r.latest_user_message_at == null ? null : String(r.latest_user_message_at),
      pendingApprovalCount: Number(r.pending_approval_count),
      pendingUserInputCount: Number(r.pending_user_input_count),
      archived: r.archived_at != null,
    };
  }
}

// ── WS RPC + push subscription ────────────────────────────────────────

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export interface TerminalSessionSnapshot {
  threadId: string;
  terminalId: string;
  cwd: string;
  status: "starting" | "running" | "exited" | "error";
  pid: number | null;
  history: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
}

export type TerminalAgentState = "running" | "attention" | "review" | null;

export interface TerminalActivity {
  threadId: string;
  terminalId: string;
  hasRunningSubprocess: boolean;
  cliKind: "claude" | "codex" | null;
  agentState: TerminalAgentState;
  updatedAt: string;
}

type PushHandler = (channel: string, data: unknown) => void;

export class DpcodeWs {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private pushHandlers: Set<PushHandler> = new Set();
  private connectPromise: Promise<void> | null = null;
  private activity = new Map<string, TerminalActivity>();

  constructor(private readonly cfg: DpcodeConfig) {}

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    // Resetter: any rejection path below must null out connectPromise so the
    // next connect() retries discovery. Otherwise an MCP daemon that started
    // before the desktop app would cache the "No dpcode backend found" error
    // forever.
    const attempt = new Promise<void>((resolve, reject) => {
      // Resolve endpoint freshly on each connect. Manual DPCODE_MCP_URL wins;
      // otherwise auto-discover from the running desktop backend (port +
      // token rotate per AppImage launch).
      let endpoint: { wsUrl: string; authToken: string | undefined };
      if (this.cfg.wsUrl) {
        endpoint = { wsUrl: this.cfg.wsUrl, authToken: this.cfg.authToken };
      } else {
        const discovered = discoverDesktopDpcode();
        if (!discovered) {
          reject(
            new Error(
              "No dpcode backend found. Start the desktop app (`dpcode`) or set DPCODE_MCP_URL.",
            ),
          );
          return;
        }
        endpoint = {
          wsUrl: discovered.wsUrl,
          authToken: this.cfg.authToken ?? discovered.authToken,
        };
      }
      const url = new URL(endpoint.wsUrl);
      if (endpoint.authToken) url.searchParams.set("token", endpoint.authToken);
      const ws = new WebSocket(url.toString());
      this.ws = ws;
      ws.on("open", () => resolve());
      ws.on("error", (err) => {
        if (this.pending.size === 0) reject(err);
      });
      ws.on("close", () => {
        for (const [, p] of this.pending) p.reject(new Error("dpcode websocket closed"));
        this.pending.clear();
        this.ws = null;
        this.connectPromise = null;
      });
      ws.on("message", (raw) => this.handleMessage(raw.toString()));
    });
    this.connectPromise = attempt;
    // If this attempt rejects (no backend, connection error, etc), drop the
    // cached promise so a later connect() retries instead of replaying the
    // failure forever.
    attempt.catch(() => {
      if (this.connectPromise === attempt) this.connectPromise = null;
    });
    return attempt;
  }

  private handleMessage(raw: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.type === "push" && typeof m.channel === "string") {
      // Track terminal activity automatically so callers can poll/wait.
      if (m.channel === "terminal.event" && m.data && typeof m.data === "object") {
        const ev = m.data as Record<string, unknown>;
        if (ev.type === "activity") {
          const a: TerminalActivity = {
            threadId: String(ev.threadId),
            terminalId: String(ev.terminalId),
            hasRunningSubprocess: Boolean(ev.hasRunningSubprocess),
            cliKind: (ev.cliKind as TerminalActivity["cliKind"]) ?? null,
            agentState: (ev.agentState as TerminalAgentState) ?? null,
            updatedAt: String(ev.createdAt ?? new Date().toISOString()),
          };
          this.activity.set(this.activityKey(a.threadId, a.terminalId), a);
        }
      }
      for (const h of this.pushHandlers) h(m.channel, m.data);
      return;
    }
    if (typeof m.id === "string") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error && typeof m.error === "object") {
        const errMsg = (m.error as Record<string, unknown>).message;
        p.reject(new Error(typeof errMsg === "string" ? errMsg : "rpc error"));
      } else {
        p.resolve(m.result);
      }
    }
  }

  private activityKey(threadId: string, terminalId: string): string {
    return `${threadId}::${terminalId}`;
  }

  onPush(handler: PushHandler): () => void {
    this.pushHandlers.add(handler);
    return () => this.pushHandlers.delete(handler);
  }

  getActivity(threadId: string, terminalId = "default"): TerminalActivity | null {
    return this.activity.get(this.activityKey(threadId, terminalId)) ?? null;
  }

  async request<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) {
      throw new Error("dpcode websocket is not open");
    }
    const id = randomUUID();
    const payload = JSON.stringify({ id, body: { _tag: method, ...body } });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      ws.send(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  // ── Convenience wrappers ─────────────────────────────────────────────

  openTerminal(input: {
    threadId: string;
    cwd: string;
    terminalId?: string;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSessionSnapshot> {
    return this.request<TerminalSessionSnapshot>("terminal.open", {
      threadId: input.threadId,
      terminalId: input.terminalId ?? "default",
      cwd: input.cwd,
      cols: input.cols ?? 120,
      rows: input.rows ?? 40,
    });
  }

  dispatchOrchestrationCommand(command: Record<string, unknown>): Promise<{ sequence: number }> {
    return this.request<{ sequence: number }>("orchestration.dispatchCommand", {
      command,
    });
  }

  writeTerminal(input: { threadId: string; data: string; terminalId?: string }): Promise<void> {
    return this.request<void>("terminal.write", {
      threadId: input.threadId,
      terminalId: input.terminalId ?? "default",
      data: input.data,
    });
  }

  async waitForAgentState(
    threadId: string,
    target: Exclude<TerminalAgentState, null>[],
    timeoutMs: number,
    terminalId = "default",
  ): Promise<TerminalActivity | null> {
    const existing = this.getActivity(threadId, terminalId);
    if (existing && existing.agentState && target.includes(existing.agentState)) {
      return existing;
    }
    return new Promise<TerminalActivity | null>((resolve) => {
      const timer = setTimeout(() => {
        unsub();
        resolve(this.getActivity(threadId, terminalId));
      }, timeoutMs);
      const unsub = this.onPush((channel, data) => {
        if (channel !== "terminal.event" || !data || typeof data !== "object") return;
        const ev = data as Record<string, unknown>;
        if (ev.type !== "activity") return;
        if (ev.threadId !== threadId) return;
        if (ev.terminalId !== terminalId) return;
        const state = (ev.agentState as TerminalAgentState) ?? null;
        if (state && target.includes(state)) {
          clearTimeout(timer);
          unsub();
          resolve(this.getActivity(threadId, terminalId));
        }
      });
    });
  }
}

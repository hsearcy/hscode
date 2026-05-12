#!/usr/bin/env bun
// dpcode-mcp: expose dpcode thread terminals as MCP tools.
//
// Reads thread metadata directly from ~/.dpcode/userdata/state.sqlite (concurrent
// readers are safe in WAL mode) and drives terminals via the dpcode WebSocket
// API (terminal.open / terminal.write + terminal.event push).

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { lastMeaningfulLines, renderTerminal } from "./ansi.ts";
import {
  DpcodeDb,
  DpcodeWs,
  loadConfig,
  type TerminalActivity,
  type ThreadRow,
} from "./dpcodeClient.ts";

const cfg = loadConfig();
const db = new DpcodeDb(cfg.homeDir);
const ws = new DpcodeWs(cfg);

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

function makeServer(): McpServer {
  const server = new McpServer({
    name: "dpcode-mcp",
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
      "List dpcode threads (Claude/Codex terminal sessions). Filter by project name/path or thread title. Sorted by latest user-message time, then by updatedAt.",
    inputSchema: {
      project: z
        .string()
        .optional()
        .describe("Filter by project title or workspace path (substring match)."),
      query: z
        .string()
        .optional()
        .describe("Substring match against thread titles."),
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
    const threads = rows.map((r) =>
      describeRow(r, ws.getActivity(r.threadId)),
    );
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
      "Read the rendered terminal scrollback of a dpcode thread. Returns the last `lines` lines of meaningful content (spinner glyphs filtered out), default 80.\n\n" +
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
    const snap = await ws.openTerminal({
      threadId: row.threadId,
      cwd: row.worktreePath ?? row.workspaceRoot,
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
      "Send text to a dpcode thread's terminal. By default appends a carriage return so it submits as a line of input (e.g. a chat message, or a numeric menu choice). Set `submit: false` to send raw bytes without trailing CR — useful for typing partial input or appending escape sequences. WARNING: Before sending a normal chat message, call `read_thread` to confirm the CLI isn't sitting on an interactive prompt that would consume your text as a menu choice.",
    inputSchema: {
      thread: z
        .string()
        .describe("Thread id (UUID) or unique title fragment."),
      text: z.string().min(1).describe("Bytes to send. Use \\r for Enter, \\x1b for ESC."),
      submit: z
        .boolean()
        .optional()
        .describe("If true (default), append a carriage return so the CLI sees a complete line."),
    },
  },
  async (args: { thread: string; text: string; submit?: boolean }) => {
    const row = resolveThread(args.thread);
    // Ensure the terminal session is alive (server will resume the CLI if needed).
    await ws.openTerminal({
      threadId: row.threadId,
      cwd: row.worktreePath ?? row.workspaceRoot,
    });
    const submit = args.submit ?? true;
    const data = submit && !args.text.endsWith("\r") ? `${args.text}\r` : args.text;
    await ws.writeTerminal({ threadId: row.threadId, data });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              threadId: row.threadId,
              bytesSent: Buffer.byteLength(data, "utf8"),
              submitted: submit,
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
      "Block until the dpcode thread's CLI is idle/waiting for user input (agentState=\"attention\") or until the timeout elapses. Returns the latest activity record and a fresh screen snapshot. Useful after send_input to know when the CLI has finished responding and is ready for the next instruction.",
    inputSchema: {
      thread: z.string().describe("Thread id (UUID) or unique title fragment."),
      timeoutSeconds: z.number().int().min(1).max(900).optional().describe("Default 120."),
      includeReview: z
        .boolean()
        .optional()
        .describe(
          "If true, also return when agentState=\"review\" (CLI is waiting on an approval, not a chat prompt). Default false.",
        ),
    },
  },
  async (args: {
    thread: string;
    timeoutSeconds?: number;
    includeReview?: boolean;
  }) => {
    const row = resolveThread(args.thread);
    await ws.openTerminal({
      threadId: row.threadId,
      cwd: row.worktreePath ?? row.workspaceRoot,
    });
    const target: ("attention" | "review")[] = args.includeReview
      ? ["attention", "review"]
      : ["attention"];
    const activity = await ws.waitForAgentState(
      row.threadId,
      target,
      (args.timeoutSeconds ?? 120) * 1000,
    );
    // Re-fetch a fresh snapshot to return the current screen.
    const snap = await ws.openTerminal({
      threadId: row.threadId,
      cwd: row.worktreePath ?? row.workspaceRoot,
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
              timedOut: !activity || activity.agentState == null
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
}  // end registerTools

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
  // long-lived state (dpcode WS client + activity cache) lives outside the McpServer.
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
      process.stderr.write(
        `[dpcode-mcp] http error: ${(err as Error).stack ?? err}\n`,
      );
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
    `[dpcode-mcp] listening on http://${bind.host}:${bind.port}/mcp (bearer: ${bearer ? "required" : "off"})\n`,
  );
}

async function main() {
  // Connect to dpcode first so we start collecting terminal.event activity
  // from the moment the MCP starts.
  try {
    await ws.connect();
  } catch (err) {
    process.stderr.write(
      `[dpcode-mcp] failed to connect to ${cfg.wsUrl}: ${(err as Error).message}\n`,
    );
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
  process.stderr.write(`[dpcode-mcp] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});

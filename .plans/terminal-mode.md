# Terminal-mode threads

Goal: a thread can be created in "terminal-cli" mode. The main pane renders a real PTY (xterm.js) running the actual `claude` or `codex` CLI in the thread's cwd, instead of the SDK pass-through ChatView. Sidebar entry, naming, provider icon, branch chip, and other thread metadata UI all keep working. Reopening the thread resumes the same CLI session via `--resume <id>` (or `-c` fallback).

## Out of scope

- Push / Hand off / approval banner / structured event projections (we'll just hide them in terminal-cli mode; transcript is opaque PTY output).
- Multi-terminal split view inside terminal-cli threads (use the default single terminal).
- Worktree env mode (terminal-cli threads default `envMode: "local"`).

## Phase 1 — Contracts

File: `packages/contracts/src/orchestration.ts`

1. Extend the `ProviderInteractionMode` union to include a new literal `"terminal-cli"`.
2. Add a sibling schema `TerminalCliKind = Schema.Literal("claude", "codex")`.
3. Extend `OrchestrationThread` and `ThreadCreateCommand` with two optional fields:
   - `cliKind: Schema.optional(TerminalCliKind)` — only meaningful when `interactionMode === "terminal-cli"`
   - `cliSessionId: Schema.optional(Schema.String)` — server-supplied UUID; persisted on the thread row
4. Re-export the new type from `packages/contracts/src/index.ts` if not auto-covered by the existing `export *`.

## Phase 2 — Persistence

1. New migration file: `apps/server/src/persistence/Migrations/0XX_TerminalCliFields.ts` (next number after the existing highest; check existing migrations dir). Adds nullable columns to `projection_threads`:
   - `cli_kind TEXT`
   - `cli_session_id TEXT`
2. Update `apps/server/src/persistence/Layers/ProjectionThreads.ts`:
   - INSERT/UPSERT now writes `cli_kind` and `cli_session_id`
   - SELECT/row decoder reads them back into the OrchestrationThread shape

## Phase 3 — Server

### 3a. Skip provider session for terminal-cli threads

File: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`

When handling a `thread.create` (or thread-open / first-turn dispatch) whose `interactionMode === "terminal-cli"`:

- Do NOT start a Claude/Codex provider session.
- Emit whatever projection event represents "session ready / idle" so the sidebar status doesn't get stuck on `connecting`. Mirror the minimum projection used for an idle thread.

Likely also touch `apps/server/src/providerManager.ts` if that's where the session-creation branch lives. Read both before deciding.

### 3b. Generate cliSessionId at thread create

Wherever the server materializes a `thread.create` command into a thread row (likely the same reactor or a thread service), if `interactionMode === "terminal-cli"` and `cliSessionId` is not set on the inbound command, generate a UUID v4 and persist it onto the projected thread.

### 3c. Auto-launch CLI on first `terminalOpen`

File: `apps/server/src/wsServer.ts` — `terminalOpen` handler (around line 2062).
File: `apps/server/src/terminal/Layers/Manager.ts` — `open()` entry.

On `terminalOpen` for a thread whose `interactionMode === "terminal-cli"`:

1. Look up the thread record. Read `cliKind` and `cliSessionId`.
2. Inject env: `T3CODE_TERMINAL_CLI_KIND = cliKind` (uses existing detection).
3. After PTY spawn, write a launch command into the PTY stdin, terminated with `\n`:
   - **claude:** first open `claude --session-id <cliSessionId>`; subsequent opens `claude --resume <cliSessionId>`. Use the `cli_launched_once` column (added in Phase 2) to choose.
   - **codex:** first open `codex`; subsequent opens `codex resume --last`. (No session ID persisted — codex CLI doesn't accept one for new sessions.)

Implementation note: the cleanest place to do the "write command to PTY" is right after `ptyProcess` creation in `Manager.ts`. Add an optional internal `initialCommand: string` to the spawn path (NOT to `TerminalOpenInput` — keep it server-only) and have the open handler resolve it from the thread record. Do NOT plumb arbitrary user-supplied initial commands through the WS contract.

### 3d. Persist cli_launched_once (addendum to Phase 2)

Add a third nullable column `cli_launched_once INTEGER NOT NULL DEFAULT 0` to the same migration. Set to 1 on first successful `terminalOpen`. Use it to choose between `--session-id` and `--resume`.

## Phase 4 — Web

### 4a. New-thread CLI picker

File: `apps/web/src/components/ChatView.tsx` — modify the empty-state landing block (around lines 7409–7444).

Add a small segmented control above or beside the composer card with three options:
- "Chat" (default, current behavior — `interactionMode: "passthrough"` or whatever the current default is — read it from `DEFAULT_PROVIDER_INTERACTION_MODE`)
- "Claude Code" → `interactionMode: "terminal-cli"`, `cliKind: "claude"`
- "Codex" → `interactionMode: "terminal-cli"`, `cliKind: "codex"`

Wire the choice into the existing thread-create dispatch: when the user submits the first message (or just clicks the picker — TBD; simplest is to dispatch `thread.create` immediately on picker click and skip waiting for the composer). For the first cut, dispatch on picker click with title `"<CLI kind> — <project name>"`. The CLI itself will accept user input through its own TUI.

The picker should only render when the empty-state branch matches; it disappears as soon as the thread has any interaction.

### 4b. Route swap

File: `apps/web/src/routes/_chat.$threadId.tsx`

If `activeThread.interactionMode === "terminal-cli"`:

- Render a new `<ThreadTerminalCliPane threadId={activeThread.id} />` component as the main area, replacing `ChatView`.
- Keep all surrounding chrome: top header (title, branch chip, provider icon based on `cliKind`), sidebar.
- Hide buttons that don't apply: Push, Hand off, approvals banner, model picker, RuntimeUsageControls, BranchToolbar (or grey out — hidden is cleaner).

### 4c. ThreadTerminalCliPane

New file: `apps/web/src/components/ThreadTerminalCliPane.tsx`

A thin wrapper that:
1. Mounts an xterm viewport bound to the real `threadId` (NOT `workspaceThreadId(...)`) using the existing terminal runtime registry / renderer.
2. Calls `WS_METHODS.terminalOpen({ threadId, terminalId: "default", cwd: project.cwd })` on mount; closes on unmount only if the user explicitly says so (terminals should outlive view unmount — match Workspace behavior).
3. No split view, no tab strip — just one PTY occupying the pane.

Reuse internals from `ThreadTerminalDrawer.tsx` and `terminal/TerminalViewportPane.tsx` where possible. If the existing components are too workspace-coupled, factor out the minimum needed (a single-pane viewport + ws bindings) into a reusable hook/component used by both.

### 4d. Sidebar provider icon

The sidebar already detects CLI kind via `terminalThreads.ts` from PTY output. Verify that a terminal-cli thread shows the right icon ("A" for Anthropic / Claude, "OAI" for Codex) on first render before any output exists — if it relies purely on banner detection, we need to fall back to `cliKind` on the thread record. Check `apps/web/src/components/Sidebar.logic.ts` and patch if needed.

## Phase 5 — Verify

Run from repo root:

```bash
bun fmt
bun lint
bun typecheck
```

All three must pass. If types fail in unrelated files because of the contract change, fix them.

## Open questions / decision log

- **claude resume flags — VERIFIED.** `claude --session-id <uuid>` creates a new session with a chosen UUID; `claude --resume <uuid>` resumes by ID. Use deterministic UUID approach.
- **codex resume mechanics — VERIFIED.** `codex` does NOT accept a pre-supplied session UUID, but `codex resume <uuid>` does accept one. For v1 the strategy is: first launch runs plain `codex`; subsequent launches run `codex resume --last`. The thread does not store a codex session ID. (A future refinement could discover the UUID from `~/.codex/sessions/` and persist it, but that's out of scope.)
- **Picker placement.** Decided: on the empty-state landing screen as a segmented control above the composer. Selecting Claude Code or Codex creates the thread immediately and routes to the terminal pane.

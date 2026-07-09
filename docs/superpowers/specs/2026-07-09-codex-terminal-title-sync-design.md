# Codex Terminal Title Sync

## Goal

Make managed Codex conversations update their HS Code sidebar title when Codex assigns a title automatically or the user runs `/rename`, matching the existing Claude Code behavior. A title manually assigned in HS Code remains authoritative.

## Root Cause

The managed Codex wrapper records TUI operations but currently forwards only session ID and working-directory metadata. Codex emits title changes as a `from_tui` operation whose payload contains `SetThreadName`, so HS Code never receives the new name.

The server-side reconciliation path is also Claude-specific: it only recognizes generic or auto-derived Claude Code titles as safe to replace. A Codex title such as `Codex - hscode` is therefore preserved even if a Codex summary reaches the server.

## Design

### Codex wrapper

Extend the existing Codex session-log watcher in `managedTerminalWrappers.ts` to recognize `from_tui` `op` records containing `SetThreadName`. Extract the operation's `name` and emit it immediately through the existing `CliMeta` hook payload as `summary` alongside:

- `cli_kind: "codex"`
- the known Codex session ID, when available
- the most recently observed working directory, when available

The wrapper remains event-driven and does not read Codex's versioned SQLite state database. It continues to use the managed hook side channel so title metadata cannot corrupt the terminal's TUI output.

### Server reconciliation

Carry the CLI kind from the terminal manager's `cli-session` event into sidebar title reconciliation. Replace the Claude-only predicate with a provider-aware predicate that treats these titles as replaceable:

- the generic terminal placeholder
- an empty title
- the provider's base terminal title
- the provider's auto-derived base title followed by a hyphen, en dash, or em dash and a project suffix

The incoming title is applied only when it is non-empty, differs from the current title, and the current title is replaceable for the reporting provider. This preserves titles manually assigned in HS Code. Existing title length limits remain unchanged and apply consistently to Claude and Codex metadata.

## Data Flow

1. Codex automatically names a conversation or handles `/rename`.
2. The Codex TUI session log records `from_tui` → `op` → `SetThreadName`.
3. The managed wrapper emits a `CliMeta` hook payload containing the new summary.
4. The terminal manager decodes the payload and publishes a `cli-session` event.
5. The WebSocket server reconciles the summary against the current thread title using the event's CLI kind.
6. The orchestration engine persists and broadcasts `thread.meta.update`, causing the sidebar to render the new title.

## Failure Handling

Malformed or empty title operations are ignored. If the session ID or working directory is not known yet, the title signal may still be emitted because title reconciliation does not depend on either field. Repeated title events are idempotent because the server skips summaries equal to the current title.

## Tests

Add focused regression coverage that proves:

- the Codex wrapper recognizes a recorded `SetThreadName` operation and forwards its name as CLI metadata
- a Codex provider title replaces `Codex - <project>`
- the equivalent Claude behavior remains supported
- a title manually assigned in HS Code is not overwritten
- empty and duplicate provider titles do not dispatch metadata updates

Use `bun run test` with targeted test files during development. Per repository instructions, run `bun fmt`, `bun lint`, and `bun typecheck` together only in the final verification pass.

## Out of Scope

- polling or reading Codex's internal SQLite state database
- migrating managed terminal conversations to Codex app-server sessions
- changing manual sidebar rename UX
- changing title generation or truncation rules

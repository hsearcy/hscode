# Terminal-Mode CLI Parity Tracker

Threads now run a real PTY hosting an interactive CLI agent (Claude Code today, Codex next). The plumbing — OSC hook protocol, terminal manager, sidebar pills, checkpoint dispatch — is generic. The _meta extraction_ (titles, session ids, working dirs, transcripts) is currently shaped around Claude's on-disk layout.

This document lists what is built per CLI so we know what still needs Codex parity.

## Status legend

- ✅ implemented
- ⚠️ partially implemented (notes)
- ❌ not yet built

## Feature matrix

| Feature                                                           | Claude | Codex | Notes                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OSC hook events (Start / Stop / PermissionRequest)                | ✅     | ✅    | Generic; both CLIs wired in `managedTerminalWrappers.ts` (`buildClaudeSettingsJson` / `buildCodexHooksJson`).                                                                                                                                            |
| Terminal sidebar attention pill (Pending / Completed)             | ✅     | ✅    | Driven by generic `terminalAttentionStatesById`, no per-CLI logic.                                                                                                                                                                                       |
| Toast on completion / input needed (Open dismisses + clears pill) | ✅     | ✅    | Generic.                                                                                                                                                                                                                                                 |
| Session id capture for `--resume`                                 | ✅     | ❌    | Claude path: `_t3code_emit_claude_meta` reads `session_id` from hook input and emits via OSC. Codex needs a sibling extractor (its session id surfaces differently).                                                                                     |
| Auto title from in-session rename / summary                       | ✅     | ❌    | Claude reads `custom-title` / `ai-title` records out of the transcript `.jsonl`. Codex stores its session/rollout differently — needs its own extractor + an analogue to `isAutoDerivedClaudeTerminalTitle`.                                             |
| Diff panel follows worktree the CLI is editing in                 | ✅     | ❌    | Claude path: hook scans transcript for the most recent absolute `"file_path"` and emits its dirname; client overrides the worktree path when it falls outside the project root. Codex needs a transcript scan tuned to its event format.                 |
| Review / Summary panel populated for terminal turns               | ✅     | ❌    | `wsServer.ts` synthesizes `thread.turn.diff.complete` from `cliKind === "claude"` activity transitions. To enable for Codex: extend the gate to also accept `"codex"` (one-line change once Codex emits the same activity event, which it already does). |

## Where the Claude-shaped code lives

If you're porting any of the above to Codex, these are the files to mirror or generalize:

- `apps/server/src/terminal/managedTerminalWrappers.ts` — `_t3code_emit_claude_meta` shell function, the per-CLI hook config (`buildClaudeSettingsJson` / `buildCodexHooksJson`), and the OSC payload format.
- `apps/server/src/terminal/Layers/Manager.ts` — `extractClaudeSessionMetaSignal`, `claudeMetaSignals` plumbing, and the `claude-session` event emit.
- `packages/contracts/src/terminal.ts` — `TerminalClaudeSessionEvent` schema (would need a sibling or to be generalized to `TerminalCliSessionEvent`).
- `apps/server/src/wsServer.ts` — `applyClaudeSessionMeta`, `isAutoDerivedClaudeTerminalTitle`, the `claudeReportedCwdByThreadId` map, and the `cliKind === "claude"` gate in the checkpoint synthesizer.
- `apps/web/src/claudeSessionMetaStore.ts` + `apps/web/src/notifications/claudeSessionCwdSubscriber.tsx` — client-side store and global subscriber for the reported cwd.
- `apps/web/src/components/DiffPanel.tsx` — the override that uses the reported cwd as the effective worktree path.

## Suggested generalization path

If/when we add a third CLI, it's worth refactoring the Claude-named pieces into a `CliSessionMeta` shape keyed by `cliKind`, with per-CLI extractor strategies. Until then, duplicating to a `_t3code_emit_codex_meta` and a `codex-session` event is fine and lower risk.

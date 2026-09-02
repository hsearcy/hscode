# @t3tools/mcp

An MCP server (`hscode-mcp`) that exposes HS Code threads (Claude / Codex
terminal sessions) as tools for a supervising agent. It lets one agent monitor
and drive every HS Code thread you have open.

## What it talks to

- **Reads** thread metadata directly from `~/.hscode/userdata/state.sqlite`
  (concurrent readers are safe under WAL).
- **Writes** to terminals via the HS Code WebSocket API (`terminal.open`,
  `terminal.write`) and subscribes to `terminal.event` push messages to
  track each CLI's `agentState` ("running" | "attention" | "review").

## Tools

| Tool                                                                                    | Purpose                                                                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `list_threads({project?, query?, limit?})`                                              | Enumerate threads, sorted by latest user-message time.                                                              |
| `read_thread({thread, lines?})`                                                         | Return rendered terminal scrollback (ANSI-stripped).                                                                |
| `send_input({thread, text, submit?})`                                                   | Type prompt text, clear Codex paste-burst state, then send Enter separately by default.                             |
| `submit_input({thread})`                                                                | Clear Codex paste-burst state and send Enter when a draft is already present in the CLI composer.                   |
| `wait_for_attention({thread, timeoutSeconds?, permissionPromptOnly?})`                  | Block until the CLI is idle (turn complete or approval prompt).                                                     |
| `start_thread({project, provider, title?, openTerminal?})`                              | Create a new Claude / Codex CLI thread in a project (equivalent to "New Thread → Claude Code / Codex" in the app).  |
| `notify_on_idle({thread, notifyUrl, timeoutSeconds?, permissionPromptOnly?, headers?})` | Register a webhook fired once when the thread next goes idle. Non-blocking — caller returns immediately.            |
| `subscribe_threads({notifyUrl, states?, screenScope?, minIntervalMs?, headers?})`       | Register a webhook called on every thread's idle transitions across the whole desktop. Throttled and screen-scoped. |
| `unsubscribe_threads({subscriptionId?})`                                                | Remove a `subscribe_threads` subscription; omit id to clear all.                                                    |
| `list_subscriptions({})`                                                                | Inspect active subscriptions.                                                                                       |

`thread` accepts either a thread UUID or a substring of the thread title.

### Webhook subscription durability

`subscribe_threads` registrations are durable: they are written to
`$DPCODE_HOME/userdata/mcp-subscriptions.json` and restored automatically when
hscode-mcp restarts (e.g. after a WSL or desktop restart). Remote orchestrators
(Ares/Hermes) do **not** need to re-subscribe after a restart. To survive
restarts, the MCP also auto-reconnects to the desktop backend whenever
subscriptions are active, so webhook delivery resumes on its own once the
backend is back up.

Local stdio clients can run several hscode-mcp processes at the same time.
These processes share an atomic delivery claim for each subscription event, so
only one process sends the webhook. The durable file remains the source of
truth for every process. An unsubscribe therefore also stops processes that
loaded the subscription earlier. Repeating an identical `subscribe_threads`
call returns the existing subscription ID instead of creating a duplicate.

Auth headers (e.g. `X-Gitlab-Token`) are stored in that file so the webhook can
be replayed, but are never written to logs. Treat the file as a secret — it
lives under `$DPCODE_HOME` alongside `state.sqlite`. `notify_on_idle` webhooks
are one-shot and intentionally not persisted.

## Configuration

Environment variables (names preserved across the HS Code rename so existing
configs keep working):

- `DPCODE_MCP_URL` (default `ws://127.0.0.1:32480`) — WebSocket URL of the
  running HS Code server. Use the AppImage's port (visible via
  `ss -tlnp | grep hscode`) or the URL of a `bun run apps/server start`
  instance.
- `DPCODE_AUTH_TOKEN` — required if the HS Code server was started with
  `--auth-token`.
- `DPCODE_HOME` (default `~/.hscode`) — where `userdata/state.sqlite` lives.
- `DPCODE_MCP_BIND` — if set (e.g. `0.0.0.0:7331`, `:7331`, or
  `100.112.27.101:7331`), runs as a Streamable HTTP MCP server at `/mcp`
  instead of stdio. If unset, runs as stdio.
- `DPCODE_MCP_BEARER` — when binding HTTP, optional bearer token; requests
  must send `Authorization: Bearer <token>`.

## Running

**Shared HTTP mode** (recommended):

```bash
hscode-mcp-start
```

This starts one long-running server for all local and remote clients. To run it
directly from the repository:

```bash
DPCODE_MCP_BIND="$(tailscale ip -4):7331" \
DPCODE_MCP_URL="ws://127.0.0.1:32480" \
  bun run --cwd apps/mcp start
```

Do not register the repository command as a global stdio MCP server. Every HS
Code Codex or Claude session reads the global agent configuration, so a global
stdio entry starts one extra hscode-mcp process for each session.

## Wiring into Codex and Claude Code

Point both clients to the shared server:

```bash
codex mcp add hscode --url http://<wsl-tailnet-name>:7331/mcp
claude mcp add hscode --transport http --scope user \
  http://<wsl-tailnet-name>:7331/mcp
```

Remove an old hscode entry before changing its transport. Use the bearer-token
option for your client if you set `DPCODE_MCP_BEARER`.

## Typical loop

1. `list_threads({project: "vclab", limit: 3})` → pick the right thread.
2. `read_thread({thread: "Create API tools"})` → see what the CLI is currently showing. If it's on a menu (e.g. resume prompt), pick an option with `send_input({thread, text: "1"})`.
3. `wait_for_attention({thread})` → block until ready for the next instruction.
4. Ask the user what to send, then `send_input({thread, text: "..."})`. Multiline text is supported. The tool clears Codex paste-burst state with a temporary marker, deletes it, then sends Enter separately.
5. If the text remains in the composer, confirm that state with `read_thread`, then call `submit_input({thread: "..."})` once.

## Caveats

- This is an internal HS Code protocol; pin to a commit.
- `agentState` for a thread is only known after at least one `terminal.event` for it has been observed by this MCP process — typically that happens on the first `read_thread` / `send_input` (which calls `terminal.open`).
- "Selecting menu option 1" with `send_input({text: "1"})` only works if the menu is currently active. Always `read_thread` first to verify what the CLI is showing.

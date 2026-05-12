# @t3tools/mcp

A stdio MCP server that exposes dpcode threads (Claude / Codex terminal sessions) as tools for a supervising agent. Lets one agent monitor and drive every dpcode thread you have open.

## What it talks to

- **Reads** thread metadata directly from `~/.dpcode/userdata/state.sqlite` (concurrent readers are safe under WAL).
- **Writes** to terminals via the dpcode WebSocket API (`terminal.open`, `terminal.write`) and subscribes to `terminal.event` push messages to track each CLI's `agentState` ("running" | "attention" | "review").

## Tools

| Tool | Purpose |
| --- | --- |
| `list_threads({project?, query?, limit?})` | Enumerate threads, sorted by latest user-message time. |
| `read_thread({thread, lines?})` | Return rendered terminal scrollback (ANSI-stripped). |
| `send_input({thread, text, submit?})` | Send keystrokes; appends `\r` by default. |
| `wait_for_attention({thread, timeoutSeconds?, includeReview?})` | Block until the CLI is idle/waiting for input. |

`thread` accepts either a thread UUID or a substring of the thread title.

## Configuration

Environment variables:

- `DPCODE_MCP_URL` (default `ws://127.0.0.1:32480`) — WebSocket URL of the running dpcode server. Use the AppImage's port (visible via `ss -tlnp | grep dpcode`) or the URL of a `bun run apps/server start` instance.
- `DPCODE_AUTH_TOKEN` — required if the dpcode server was started with `--auth-token`.
- `DPCODE_HOME` (default `~/.dpcode`) — where `userdata/state.sqlite` lives.
- `DPCODE_MCP_BIND` — if set (e.g. `0.0.0.0:7331`, `:7331`, or `100.112.27.101:7331`), runs as a Streamable HTTP MCP server at `/mcp` instead of stdio. If unset, runs as stdio.
- `DPCODE_MCP_BEARER` — when binding HTTP, optional bearer token; requests must send `Authorization: Bearer <token>`.

## Running

**Stdio mode** (one instance per client, spawned by the MCP host):

```bash
bun run --cwd apps/mcp start
```

**HTTP mode** (one long-running server, multiple clients on your Tailnet):

```bash
DPCODE_MCP_BIND="$(tailscale ip -4):7331" \
DPCODE_MCP_URL="ws://127.0.0.1:32480" \
  bun run --cwd apps/mcp start
```

## Wiring into Claude Code

### Local stdio

```bash
claude mcp add dpcode \
  --scope user \
  --env DPCODE_MCP_URL=ws://127.0.0.1:32480 \
  -- bun run /home/hfsearcy/git/dpcode/apps/mcp/src/index.ts
```

### Remote HTTP (any machine on your Tailnet)

Run the MCP once on the host where dpcode lives:

```bash
DPCODE_MCP_BIND="$(tailscale ip -4):7331" \
DPCODE_MCP_URL="ws://127.0.0.1:32480" \
  bun run --cwd apps/mcp start
```

Then from any Tailnet machine:

```bash
claude mcp add dpcode --transport http http://<wsl-tailnet-name>:7331/mcp
```

Use `--header "Authorization: Bearer <token>"` if you set `DPCODE_MCP_BEARER`.

## Typical loop

1. `list_threads({project: "vclab", limit: 3})` → pick the right thread.
2. `read_thread({thread: "Create API tools"})` → see what the CLI is currently showing. If it's on a menu (e.g. resume prompt), pick an option with `send_input({thread, text: "1"})`.
3. `wait_for_attention({thread})` → block until ready for the next instruction.
4. Ask the user what to send, then `send_input({thread, text: "..."})`. Repeat.

## Caveats

- This is an internal dpcode protocol; pin to a commit.
- `agentState` for a thread is only known after at least one `terminal.event` for it has been observed by this MCP process — typically that happens on the first `read_thread` / `send_input` (which calls `terminal.open`).
- "Selecting menu option 1" with `send_input({text: "1"})` only works if the menu is currently active. Always `read_thread` first to verify what the CLI is showing.

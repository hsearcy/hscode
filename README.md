# DP Code

DP Code is a desktop GUI for running coding agents — Claude Code and Codex —
side by side, with persistent threads, real terminal sessions, and a
controllable MCP surface so one agent can supervise the others.

This is a fork of [Emanuele-web04/dpcode](https://github.com/Emanuele-web04/dpcode),
adapted to run the CLIs as real PTYs inside threads instead of using the
provider SDKs as passthrough chat.

## What it does

- **Terminal-cli threads.** Each thread can host a real `claude` or `codex`
  PTY (not just SDK passthrough chat). Hooks signal turn boundaries back to
  the UI so you get attention/completed indicators without polling.
- **Workspace area.** Multiple terminals per thread, with persistent cwd,
  branch/worktree awareness, and the diff panel docked to the chat.
- **MCP server (`apps/mcp`, `dpcode-mcp`).** Exposes every dpcode thread as
  tools to a supervising agent — `start_thread`, `send_input`, `read_thread`,
  `wait_for_attention`, `subscribe_threads`. Lets one agent orchestrate the
  rest. See `apps/mcp/README.md`.
- **Desktop app.** Electron build with auto-update, Linux/WSL2 support, and
  PTY-aware OOM hardening so a runaway CLI can't take the UI with it.

## Install

> [!WARNING]
> You need [Claude Code](https://docs.claude.com/en/docs/claude-code) and/or
> [Codex CLI](https://github.com/openai/codex) installed and authorized for
> the corresponding terminal-cli threads to work.

Run `scripts/install-local.sh` to build the Linux AppImage and install it to
`~/Applications/dpcode/`. The previous install is moved aside to
`~/Applications/dpcode.bak` so you can roll back.

The installer also drops four launcher scripts into `~/.local/bin/`:

- `dpcode` — launches the desktop app detached from the shell and starts
  dpcode-mcp alongside it.
- `dpcode-mcp-start` — starts the MCP server. Honors `$DPCODE_MCP_BIND` if
  set, else binds to your Tailscale IPv4 address on port 7331, else
  `127.0.0.1:7331`. Logs to `~/.dpcode/userdata/logs/mcp.log`.
- `dpcode-mcp-stop` — kills the MCP server.
- `dpcode-mcp-log` — `tail -f` the MCP log.

If `~/.local/bin` isn't on your `PATH`, the installer prints the line you
need to add to your shell rc.

## Repo layout

- `apps/server` — Node.js WebSocket server. Manages PTYs, codex app-server
  sessions, terminal hook events, and serves the web UI.
- `apps/web` — React/Vite UI. Owns conversation/thread rendering, the
  workspace area, the diff panel, and client-side state.
- `apps/desktop` — Electron shell that bundles the server + web build.
- `apps/mcp` — `dpcode-mcp` stdio/HTTP MCP server.
- `apps/marketing` — Marketing site.
- `packages/contracts` — Effect/Schema schemas shared between server and web.
- `packages/shared` — Runtime utilities shared between server and web.

## Status

Forked from [dpcode](https://github.com/Emanuele-web04/dpcode) and adapted to
run the CLIs as real terminal sessions inside threads rather than going
through the provider SDKs. Still a WIP that I'm polishing for what I
personally use it for — APIs, storage formats, and UI surfaces change without
warning.

Not actively accepting contributions. You can open an issue or PR but read
[CONTRIBUTING.md](./CONTRIBUTING.md) first.

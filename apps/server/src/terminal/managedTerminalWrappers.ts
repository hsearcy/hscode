// FILE: managedTerminalWrappers.ts
// Purpose: Create Superset-style managed command wrappers so terminal agent identity is canonical
// and survives zsh startup that rewrites PATH.

import fs from "node:fs";
import path from "node:path";

import {
  defaultTerminalTitleForCliKind,
  isClaudeTerminalCliKind,
  managedTerminalCommandNameForCliKind,
  T3CODE_TERMINAL_HOOK_OSC_PREFIX,
  T3CODE_TERMINAL_CLI_META_OSC_PREFIX,
  T3CODE_TERMINAL_CLI_KIND_ENV_KEY,
  type TerminalAgentHookEventType,
  type TerminalCliKind,
} from "@t3tools/shared/terminalThreads";

export interface ManagedTerminalWrapperState {
  binDir: string | null;
  hookScriptPath: string | null;
  claudeSettingsPath: string | null;
  zshDir: string | null;
  targetPathByCliKind: Partial<Record<TerminalCliKind, string>>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function envPathKeyFor(env: NodeJS.ProcessEnv): "PATH" | "Path" | "path" {
  if ("PATH" in env) return "PATH";
  if ("Path" in env) return "Path";
  return "path";
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableCandidates(commandName: string): string[] {
  if (process.platform !== "win32") {
    return [commandName];
  }

  const pathExt = process.env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT"];
  const lowerCommandName = commandName.toLowerCase();
  const hasExtension = pathExt.some((extension) =>
    lowerCommandName.endsWith(extension.toLowerCase()),
  );
  return hasExtension ? [commandName] : pathExt.map((extension) => `${commandName}${extension}`);
}

function resolveExecutableOnPath(commandName: string, env: NodeJS.ProcessEnv): string | null {
  const envPathKey = envPathKeyFor(env);
  const envPath = env[envPathKey]?.trim();
  if (!envPath) {
    return null;
  }

  for (const entry of envPath.split(path.delimiter)) {
    const directory = entry.trim();
    if (!directory) {
      continue;
    }
    for (const candidateName of executableCandidates(commandName)) {
      const candidatePath = path.join(directory, candidateName);
      if (isExecutableFile(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return null;
}

function buildHookOscSequence(eventType: TerminalAgentHookEventType): string {
  return `\\033]${T3CODE_TERMINAL_HOOK_OSC_PREFIX}${eventType}\\007`;
}

function buildNotifyHookScript(): string {
  return `#!/bin/sh
set -eu
if [ "$#" -gt 0 ]; then
  _t3code_hook_input="$1"
else
  _t3code_hook_input="$(cat)"
fi

_t3code_extract_event() {
  printf '%s' "$_t3code_hook_input" | sed -n "s/.*\\\"$1\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p" | head -n 1
}

_t3code_event="$(_t3code_extract_event hook_event_name)"
if [ -z "$_t3code_event" ]; then
  _t3code_type="$(_t3code_extract_event type)"
  case "$_t3code_type" in
    task_started|userPromptSubmitted|user_prompt_submit)
      _t3code_event="Start"
      ;;
    task_complete|agent-turn-complete|stop|session_end|sessionEnd)
      _t3code_event="Stop"
      ;;
    exec_approval_request|apply_patch_approval_request|request_user_input)
      _t3code_event="PermissionRequest"
      ;;
  esac
fi

_t3code_emit_osc() {
  _t3code_sequence="$1"
  # Primary channel: a side file the server tails (T3CODE_TERMINAL_EVENT_SINK).
  # Writing OSC bytes straight to the PTY interleaves them with — and corrupts
  # — the CLI's own TUI frames, because the hook subprocess and the CLI write
  # to the same PTY slave concurrently. The sink file keeps signalling fully
  # off the PTY data path. One OSC sequence per line.
  if [ -n "\${T3CODE_TERMINAL_EVENT_SINK:-}" ]; then
    printf '%b\\n' "$_t3code_sequence" >> "$T3CODE_TERMINAL_EVENT_SINK" 2>/dev/null && return
  fi
  # Fallbacks for unmanaged sessions / older servers that set no sink. The
  # wrapper captured the PTY device path in T3CODE_TERMINAL_TTY before exec
  # because Claude 2.1+ runs hooks detached from /dev/tty. Stdout is the last
  # resort — Claude swallows hook stdout, so the server never sees it.
  if [ -n "\${T3CODE_TERMINAL_TTY:-}" ] && [ -w "$T3CODE_TERMINAL_TTY" ]; then
    printf '%b' "$_t3code_sequence" > "$T3CODE_TERMINAL_TTY" 2>/dev/null && return
  fi
  if [ -w /dev/tty ]; then
    printf '%b' "$_t3code_sequence" > /dev/tty 2>/dev/null && return
  fi
  printf '%b' "$_t3code_sequence"
}

# Encode {cliKind, sessionId, summary, cwd} and push it up the unified CLI meta
# OSC channel. Shared by the Claude transcript scraper below and the Codex
# CliMeta event the wrapper forwards from the TUI session log.
_t3code_emit_cli_meta_payload() {
  _t3code_meta_cli_kind="$1"
  _t3code_meta_session_id="$2"
  _t3code_meta_summary="$3"
  _t3code_meta_cwd="$4"
  if [ -z "$_t3code_meta_session_id" ] && [ -z "$_t3code_meta_summary" ] && [ -z "$_t3code_meta_cwd" ]; then
    return
  fi
  if command -v base64 >/dev/null 2>&1; then
    _t3code_payload="$(printf '{"cliKind":"%s","sessionId":"%s","summary":"%s","cwd":"%s"}' \\
      "$_t3code_meta_cli_kind" "$_t3code_meta_session_id" "$_t3code_meta_summary" "$_t3code_meta_cwd" \\
      | base64 | tr -d '\\n')"
    _t3code_emit_osc "\\033]${T3CODE_TERMINAL_CLI_META_OSC_PREFIX}\${_t3code_payload}\\007"
  fi
}

_t3code_emit_claude_meta() {
  _t3code_session_id="$(_t3code_extract_event session_id)"
  if [ -z "$_t3code_session_id" ]; then
    return
  fi
  _t3code_transcript_path="$(_t3code_extract_event transcript_path)"
  _t3code_summary=""
  if [ -n "$_t3code_transcript_path" ] && [ -r "$_t3code_transcript_path" ]; then
    # Claude records titles as either {"type":"custom-title","customTitle":"..."}
    # (set via /rename) or {"type":"ai-title","aiTitle":"..."} (auto-generated).
    # User-set custom titles win; otherwise fall back to the most recent ai-title.
    _t3code_summary="$(grep '"type":"custom-title"' "$_t3code_transcript_path" 2>/dev/null \\
      | tail -n 1 \\
      | sed -n 's/.*"customTitle"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
    if [ -z "$_t3code_summary" ]; then
      _t3code_summary="$(grep '"type":"ai-title"' "$_t3code_transcript_path" 2>/dev/null \\
        | tail -n 1 \\
        | sed -n 's/.*"aiTitle"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
    fi
  fi
  # Claude's hook "cwd" is its launch dir and never moves (cd inside Bash
  # subshells doesn't change it), so it can't tell us which worktree the
  # actual edits are landing in. Instead, scan the transcript for the most
  # recent absolute "file_path" from an edit-style tool_use (Edit/Write/
  # MultiEdit/Update) and emit its directory. Git resolves the surrounding
  # worktree root from any path inside it, so feeding its parent into the
  # diff queries is enough.
  _t3code_cwd=""
  if [ -n "$_t3code_transcript_path" ] && [ -r "$_t3code_transcript_path" ]; then
    _t3code_recent_file="$(grep -oE '"file_path"[[:space:]]*:[[:space:]]*"/[^"]*"' \\
      "$_t3code_transcript_path" 2>/dev/null \\
      | tail -n 1 \\
      | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
    if [ -n "$_t3code_recent_file" ]; then
      _t3code_cwd="$(dirname "$_t3code_recent_file")"
    fi
  fi
  if [ -z "$_t3code_cwd" ]; then
    _t3code_cwd="$(_t3code_extract_event cwd)"
  fi
  _t3code_emit_cli_meta_payload "claude" "$_t3code_session_id" "$_t3code_summary" "$_t3code_cwd"
}

case "$_t3code_event" in
  UserPromptSubmit)
    _t3code_emit_osc '${buildHookOscSequence("Start")}'
    # /rename and other in-session updates land in the transcript without firing
    # a Stop hook. Re-read on every user prompt so the next message after a rename
    # flushes the fresh summary up to the sidebar.
    _t3code_emit_claude_meta
    ;;
  PostToolUse|PostToolUseFailure|Start)
    _t3code_emit_osc '${buildHookOscSequence("Start")}'
    ;;
  Stop)
    _t3code_emit_osc '${buildHookOscSequence("Stop")}'
    _t3code_emit_claude_meta
    ;;
  SessionStart)
    _t3code_emit_osc '${buildHookOscSequence("Start")}'
    _t3code_emit_claude_meta
    ;;
  PermissionRequest|PreToolUse|Notification)
    _t3code_emit_osc '${buildHookOscSequence("PermissionRequest")}'
    ;;
  CliMeta)
    # Forwarded by the Codex wrapper: carries provider title/session metadata
    # plus the cwd of the most recent exec.
    _t3code_meta_cli_kind="$(_t3code_extract_event cli_kind)"
    [ -n "$_t3code_meta_cli_kind" ] || _t3code_meta_cli_kind="codex"
    _t3code_emit_cli_meta_payload \\
      "$_t3code_meta_cli_kind" \\
      "$(_t3code_extract_event session_id)" \\
      "$(_t3code_extract_event summary)" \\
      "$(_t3code_extract_event cwd)"
    ;;
esac
`;
}

function buildClaudeSettingsJson(notifyHookPath: string): string {
  const command = notifyHookPath;
  return JSON.stringify(
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
        Stop: [{ hooks: [{ type: "command", command }] }],
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        Notification: [{ matcher: "*", hooks: [{ type: "command", command }] }],
      },
    },
    null,
    2,
  );
}

function buildCodexWrapperScript(input: {
  notifyHookPath: string;
  targetPath: string;
}): string {
  const { notifyHookPath, targetPath } = input;
  return [
    `if [ -f ${shellQuote(notifyHookPath)} ]; then`,
    "  export CODEX_TUI_RECORD_SESSION=1",
    '  if [ -z "${CODEX_TUI_SESSION_LOG_PATH:-}" ]; then',
    '    _t3code_codex_ts="$(date +%s 2>/dev/null || echo "$$")"',
    '    export CODEX_TUI_SESSION_LOG_PATH="${TMPDIR:-/tmp}/t3code-codex-session-$$_${_t3code_codex_ts}.jsonl"',
    "  fi",
    "  (",
    '    _t3code_log="$CODEX_TUI_SESSION_LOG_PATH"',
    `    _t3code_notify=${shellQuote(notifyHookPath)}`,
    '    _t3code_last_turn_id=""',
    '    _t3code_last_approval_id=""',
    '    _t3code_last_exec_call_id=""',
    '    _t3code_last_cwd=""',
    '    _t3code_last_thread_name=""',
    '    _t3code_session_id=""',
    "    _t3code_approval_fallback_seq=0",
    "",
    "    _t3code_emit_event() {",
    '      _t3code_event="$1"',
    `      _t3code_payload=$(printf '{"hook_event_name":"%s"}' "$_t3code_event")`,
    '      "$_t3code_notify" "$_t3code_payload" >/dev/null 2>&1 || true',
    "    }",
    "",
    "    # Persist the real Codex thread id so each HS Code thread resumes itself.",
    "    _t3code_emit_session_id() {",
    '      _t3code_new_session_id="$1"',
    '      [ -n "$_t3code_new_session_id" ] || return',
    '      [ "$_t3code_new_session_id" != "$_t3code_session_id" ] || return',
    '      _t3code_session_id="$_t3code_new_session_id"',
    `      _t3code_meta_payload=$(printf '{"hook_event_name":"CliMeta","cli_kind":"codex","session_id":"%s","cwd":"%s"}' "$_t3code_session_id" "$_t3code_last_cwd")`,
    '      "$_t3code_notify" "$_t3code_meta_payload" >/dev/null 2>&1 || true',
    "    }",
    "",
    "    # Forward Codex's own automatic and /rename title updates.",
    "    _t3code_emit_title() {",
    '      _t3code_thread_name_value="$1"',
    '      [ -n "$_t3code_thread_name_value" ] || return',
    `      _t3code_meta_payload=$(printf '{"hook_event_name":"CliMeta","cli_kind":"codex","session_id":"%s","summary":"%s","cwd":"%s"}' "$_t3code_session_id" "$_t3code_thread_name_value" "$_t3code_last_cwd")`,
    '      "$_t3code_notify" "$_t3code_meta_payload" >/dev/null 2>&1 || true',
    "    }",
    "",
    "    # Forward the cwd of Codex's most recent exec up the CLI meta channel so",
    "    # the server can follow Codex into worktrees it created on its own.",
    "    _t3code_emit_cwd() {",
    '      _t3code_cwd_value="$1"',
    '      [ -n "$_t3code_cwd_value" ] || return',
    `      _t3code_meta_payload=$(printf '{"hook_event_name":"CliMeta","cli_kind":"codex","session_id":"%s","cwd":"%s"}' "$_t3code_session_id" "$_t3code_cwd_value")`,
    '      "$_t3code_notify" "$_t3code_meta_payload" >/dev/null 2>&1 || true',
    "    }",
    "",
    "    _t3code_i=0",
    '    while [ ! -f "$_t3code_log" ] && [ "$_t3code_i" -lt 200 ]; do',
    "      _t3code_i=$((_t3code_i + 1))",
    "      sleep 0.05",
    "    done",
    '    if [ ! -f "$_t3code_log" ]; then',
    "      exit 0",
    "    fi",
    "",
    '    tail -n 0 -F "$_t3code_log" 2>/dev/null | while IFS= read -r _t3code_line; do',
    '      case "$_t3code_line" in',
    `        *'"dir":"to_tui"'*'"kind":"app_event"'*'thread_id: ThreadId { uuid: '*)`,
    `          _t3code_new_session_id=$(printf '%s\n' "$_t3code_line" | awk -F'thread_id: ThreadId { uuid: ' 'NF > 1 { sub(/[^0-9a-fA-F-].*/, "", $2); print $2; exit }')`,
    '          _t3code_emit_session_id "$_t3code_new_session_id"',
    "          ;;",
    `        *'"dir":"from_tui"'*'"kind":"op"'*'"SetThreadName"'*)`,
    `          _t3code_thread_name=$(printf '%s\n' "$_t3code_line" | awk -F'"name":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          if [ -n "$_t3code_thread_name" ] && [ "$_t3code_thread_name" != "$_t3code_last_thread_name" ]; then',
    '            _t3code_last_thread_name="$_t3code_thread_name"',
    '            _t3code_emit_title "$_t3code_thread_name"',
    "          fi",
    "          ;;",
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"session_configured"'*)`,
    `          _t3code_new_session_id=$(printf '%s\n' "$_t3code_line" | awk -F'"session_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    `          [ -n "$_t3code_new_session_id" ] || _t3code_new_session_id=$(printf '%s\n' "$_t3code_line" | awk -F'"conversation_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          _t3code_emit_session_id "$_t3code_new_session_id"',
    "          ;;",
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"task_started"'*)`,
    `          _t3code_turn_id=$(printf '%s\n' "$_t3code_line" | awk -F'"turn_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          [ -n "$_t3code_turn_id" ] || _t3code_turn_id="task_started"',
    '          if [ "$_t3code_turn_id" != "$_t3code_last_turn_id" ]; then',
    '            _t3code_last_turn_id="$_t3code_turn_id"',
    '            _t3code_emit_event "Start"',
    "          fi",
    "          ;;",
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"'*'_approval_request"'*)`,
    `          _t3code_approval_id=$(printf '%s\n' "$_t3code_line" | awk -F'"id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    `          [ -n "$_t3code_approval_id" ] || _t3code_approval_id=$(printf '%s\n' "$_t3code_line" | awk -F'"approval_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    `          [ -n "$_t3code_approval_id" ] || _t3code_approval_id=$(printf '%s\n' "$_t3code_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          if [ -z "$_t3code_approval_id" ]; then',
    "            _t3code_approval_fallback_seq=$((_t3code_approval_fallback_seq + 1))",
    '            _t3code_approval_id="approval_request_${_t3code_approval_fallback_seq}"',
    "          fi",
    '          if [ "$_t3code_approval_id" != "$_t3code_last_approval_id" ]; then',
    '            _t3code_last_approval_id="$_t3code_approval_id"',
    '            _t3code_emit_event "PermissionRequest"',
    "          fi",
    "          ;;",
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"exec_command_begin"'*)`,
    `          _t3code_exec_call_id=$(printf '%s\n' "$_t3code_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    `          _t3code_exec_cwd=$(printf '%s\n' "$_t3code_line" | awk -F'"cwd":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          if [ -n "$_t3code_exec_cwd" ] && [ "$_t3code_exec_cwd" != "$_t3code_last_cwd" ]; then',
    '            _t3code_last_cwd="$_t3code_exec_cwd"',
    '            _t3code_emit_cwd "$_t3code_exec_cwd"',
    "          fi",
    '          if [ -n "$_t3code_exec_call_id" ]; then',
    '            if [ "$_t3code_exec_call_id" != "$_t3code_last_exec_call_id" ]; then',
    '              _t3code_last_exec_call_id="$_t3code_exec_call_id"',
    '              _t3code_emit_event "Start"',
    "            fi",
    "          else",
    '            _t3code_emit_event "Start"',
    "          fi",
    "          ;;",
    "      esac",
    "    done",
    "  ) &",
    "  T3CODE_CODEX_START_WATCHER_PID=$!",
    "fi",
    `${shellQuote(targetPath)} --enable hooks -c ${shellQuote(`notify=["bash",${JSON.stringify(notifyHookPath)}]`)} "$@"`,
    "_t3code_status=$?",
    'if [ -n "${T3CODE_CODEX_START_WATCHER_PID:-}" ]; then',
    '  kill "$T3CODE_CODEX_START_WATCHER_PID" >/dev/null 2>&1 || true',
    '  wait "$T3CODE_CODEX_START_WATCHER_PID" 2>/dev/null || true',
    "fi",
    'exit "$_t3code_status"',
  ].join("\n");
}

function buildWrapperScript(input: {
  claudeSettingsPath: string;
  cliKind: TerminalCliKind;
  notifyHookPath: string;
  targetPath: string;
}): string {
  const { claudeSettingsPath, cliKind, notifyHookPath, targetPath } = input;
  const commandName = managedTerminalCommandNameForCliKind(cliKind);
  const title = defaultTerminalTitleForCliKind(cliKind);
  const commandBody =
    isClaudeTerminalCliKind(cliKind)
      ? `exec ${shellQuote(targetPath)} --settings ${shellQuote(claudeSettingsPath)} "$@"`
      : buildCodexWrapperScript({ notifyHookPath, targetPath });
  return [
    "#!/bin/sh",
    `# Managed ${commandName} wrapper injected by t3code terminal sessions.`,
    `printf '\\033]0;%s\\007' ${shellQuote(title)}`,
    `export ${T3CODE_TERMINAL_CLI_KIND_ENV_KEY}=${shellQuote(cliKind)}`,
    // Capture the PTY device path here (while we still have a usable
    // controlling terminal) so the hook subprocess — which Claude 2.1+
    // launches detached from /dev/tty — can still emit OSC sequences
    // back to the PTY for the server's sanitizer to parse.
    'if [ -z "${T3CODE_TERMINAL_TTY:-}" ]; then',
    '  _t3code_tty="$(tty 2>/dev/null || true)"',
    '  case "$_t3code_tty" in',
    '    /dev/*) export T3CODE_TERMINAL_TTY="$_t3code_tty" ;;',
    "  esac",
    "fi",
    commandBody,
    "",
  ].join("\n");
}

function writeFileIfChanged(filePath: string, content: string, mode: number): void {
  const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (currentContent !== content) {
    fs.writeFileSync(filePath, content, { mode });
  }
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Best effort.
  }
}

function buildManagedZshRc(quotedZshDir: string): string {
  return `# HS Code zsh rc wrapper
_t3code_home="\${T3CODE_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_t3code_home"
[[ -f "$_t3code_home/.zshrc" ]] && source "$_t3code_home/.zshrc"
export ZDOTDIR=${quotedZshDir}
if [ -n "\${T3CODE_MANAGED_BIN_DIR:-}" ] && [ -d "\${T3CODE_MANAGED_BIN_DIR}" ]; then
  case ":$PATH:" in
    *:\${T3CODE_MANAGED_BIN_DIR}:*) ;;
    *) export PATH="\${T3CODE_MANAGED_BIN_DIR}:$PATH" ;;
  esac
  unalias claude 2>/dev/null || true
  claude() {
    if [ -x "\${T3CODE_MANAGED_BIN_DIR}/claude" ] && [ ! -d "\${T3CODE_MANAGED_BIN_DIR}/claude" ]; then
      "\${T3CODE_MANAGED_BIN_DIR}/claude" "$@"
    else
      command claude "$@"
    fi
  }
  unalias codex 2>/dev/null || true
  codex() {
    if [ -x "\${T3CODE_MANAGED_BIN_DIR}/codex" ] && [ ! -d "\${T3CODE_MANAGED_BIN_DIR}/codex" ]; then
      "\${T3CODE_MANAGED_BIN_DIR}/codex" "$@"
    else
      command codex "$@"
    fi
  }
  typeset -ga precmd_functions 2>/dev/null || true
  _t3code_ensure_managed_bin() {
    case ":$PATH:" in
      *:\${T3CODE_MANAGED_BIN_DIR}:*) ;;
      *) PATH="\${T3CODE_MANAGED_BIN_DIR}:$PATH" ;;
    esac
  }
  {
    precmd_functions=(\${precmd_functions:#_t3code_ensure_managed_bin} _t3code_ensure_managed_bin)
  } 2>/dev/null || true
fi
`;
}

function ensureManagedZshWrappers(zshDir: string): void {
  fs.mkdirSync(zshDir, { recursive: true });
  const quotedZshDir = shellQuote(zshDir);
  writeFileIfChanged(
    path.join(zshDir, ".zshenv"),
    `# HS Code zsh env wrapper
_t3code_home="\${T3CODE_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_t3code_home"
[[ -f "$_t3code_home/.zshenv" ]] && source "$_t3code_home/.zshenv"
export ZDOTDIR=${quotedZshDir}
`,
    0o644,
  );
  writeFileIfChanged(
    path.join(zshDir, ".zprofile"),
    `# HS Code zsh profile wrapper
_t3code_home="\${T3CODE_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_t3code_home"
[[ -f "$_t3code_home/.zprofile" ]] && source "$_t3code_home/.zprofile"
export ZDOTDIR=${quotedZshDir}
`,
    0o644,
  );
  writeFileIfChanged(path.join(zshDir, ".zshrc"), buildManagedZshRc(quotedZshDir), 0o644);
}

export function prepareManagedTerminalWrappers(options: {
  baseEnv: NodeJS.ProcessEnv;
  rootDir: string;
  zshRootDir: string;
}): ManagedTerminalWrapperState {
  if (process.platform === "win32") {
    return {
      binDir: null,
      hookScriptPath: null,
      claudeSettingsPath: null,
      zshDir: null,
      targetPathByCliKind: {},
    };
  }

  const targetPathByCliKind: Partial<Record<TerminalCliKind, string>> = {};
  // Claudex stays a user shell alias so it can expand to the managed Claude wrapper.
  for (const cliKind of ["codex", "claude"] as const) {
    const commandName = managedTerminalCommandNameForCliKind(cliKind);
    const targetPath = resolveExecutableOnPath(commandName, options.baseEnv);
    if (!targetPath) {
      continue;
    }
    targetPathByCliKind[cliKind] = targetPath;
  }

  if (Object.keys(targetPathByCliKind).length === 0) {
    return {
      binDir: null,
      hookScriptPath: null,
      claudeSettingsPath: null,
      zshDir: null,
      targetPathByCliKind,
    };
  }

  fs.mkdirSync(options.rootDir, { recursive: true });
  const hookScriptPath = path.join(options.rootDir, "notify-hook.sh");
  const claudeSettingsPath = path.join(options.rootDir, "claude-settings.json");
  writeFileIfChanged(hookScriptPath, buildNotifyHookScript(), 0o755);
  writeFileIfChanged(claudeSettingsPath, buildClaudeSettingsJson(hookScriptPath), 0o644);
  for (const [cliKind, targetPath] of Object.entries(targetPathByCliKind) as Array<
    [TerminalCliKind, string]
  >) {
    const wrapperPath = path.join(options.rootDir, managedTerminalCommandNameForCliKind(cliKind));
    writeFileIfChanged(
      wrapperPath,
      buildWrapperScript({
        claudeSettingsPath,
        cliKind,
        notifyHookPath: hookScriptPath,
        targetPath,
      }),
      0o755,
    );
  }
  ensureManagedZshWrappers(options.zshRootDir);

  return {
    binDir: options.rootDir,
    hookScriptPath,
    claudeSettingsPath,
    zshDir: options.zshRootDir,
    targetPathByCliKind,
  };
}

function applyManagedTerminalWrapperEnvState(
  env: NodeJS.ProcessEnv,
  wrapperState: {
    binDir: string | null;
    zshDir: string | null;
  },
): NodeJS.ProcessEnv {
  if (!wrapperState.binDir) {
    return env;
  }

  const envPathKey = envPathKeyFor(env);
  const currentPath = env[envPathKey]?.trim() ?? "";
  const currentEntries = currentPath
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!currentEntries.includes(wrapperState.binDir)) {
    currentEntries.unshift(wrapperState.binDir);
  }

  return {
    ...env,
    T3CODE_MANAGED_BIN_DIR: wrapperState.binDir,
    T3CODE_ORIGINAL_ZDOTDIR: env.ZDOTDIR ?? env.HOME ?? "",
    ...(wrapperState.zshDir ? { ZDOTDIR: wrapperState.zshDir } : {}),
    [envPathKey]: currentEntries.join(path.delimiter),
  };
}

export function applyManagedTerminalAgentWrapperEnv(
  env: NodeJS.ProcessEnv,
  wrapperState: {
    binDir: string | null;
    zshDir: string | null;
  },
): NodeJS.ProcessEnv {
  return applyManagedTerminalWrapperEnvState(env, wrapperState);
}

export function prepareManagedTerminalAgentWrappers(options: {
  baseEnv: NodeJS.ProcessEnv;
  targetDir: string;
  zshDir: string;
}): ManagedTerminalWrapperState {
  return prepareManagedTerminalWrappers({
    baseEnv: options.baseEnv,
    rootDir: options.targetDir,
    zshRootDir: options.zshDir,
  });
}

export function prependManagedTerminalAgentWrapperPath(
  env: NodeJS.ProcessEnv,
  managedWrapperState: {
    binDir: string | null;
    zshDir: string | null;
  },
): NodeJS.ProcessEnv {
  return applyManagedTerminalWrapperEnvState(env, managedWrapperState);
}

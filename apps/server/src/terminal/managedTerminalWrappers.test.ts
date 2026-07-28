import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareManagedTerminalWrappers } from "./managedTerminalWrappers";

describe("managed terminal wrappers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves the inherited CODEX_HOME", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hscode-codex-home-"));
    tempDirs.push(tempDir);
    const sourceBinDir = path.join(tempDir, "source-bin");
    const wrapperDir = path.join(tempDir, "wrappers");
    const inheritedCodexHome = path.join(tempDir, "inherited-codex-home");
    fs.mkdirSync(sourceBinDir);
    fs.mkdirSync(inheritedCodexHome);

    fs.writeFileSync(
      path.join(sourceBinDir, "codex"),
      '#!/bin/sh\nprintf "%s" "${CODEX_HOME:-}"\n',
      { mode: 0o755 },
    );

    const state = prepareManagedTerminalWrappers({
      baseEnv: { PATH: sourceBinDir },
      rootDir: wrapperDir,
      zshRootDir: path.join(tempDir, "zsh"),
    });
    fs.rmSync(state.hookScriptPath!);

    const output = execFileSync(path.join(wrapperDir, "codex"), {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: inheritedCodexHome },
    });

    expect(output.endsWith(inheritedCodexHome)).toBe(true);
  });

  it("leaves CODEX_HOME unset when it was not inherited", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hscode-codex-home-"));
    tempDirs.push(tempDir);
    const sourceBinDir = path.join(tempDir, "source-bin");
    const wrapperDir = path.join(tempDir, "wrappers");
    fs.mkdirSync(sourceBinDir);

    fs.writeFileSync(
      path.join(sourceBinDir, "codex"),
      '#!/bin/sh\nprintf "%s" "${CODEX_HOME-unset}"\n',
      { mode: 0o755 },
    );

    const state = prepareManagedTerminalWrappers({
      baseEnv: { PATH: sourceBinDir },
      rootDir: wrapperDir,
      zshRootDir: path.join(tempDir, "zsh"),
    });
    fs.rmSync(state.hookScriptPath!);

    const output = execFileSync(path.join(wrapperDir, "codex"), {
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "CODEX_HOME")),
    });

    expect(output.endsWith("unset")).toBe(true);
  });

  it("enables the current Codex hooks feature without the deprecated alias", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hscode-codex-hooks-"));
    tempDirs.push(tempDir);
    const sourceBinDir = path.join(tempDir, "source-bin");
    const wrapperDir = path.join(tempDir, "wrappers");
    fs.mkdirSync(sourceBinDir);

    fs.writeFileSync(path.join(sourceBinDir, "codex"), "#!/bin/sh\n", { mode: 0o755 });

    prepareManagedTerminalWrappers({
      baseEnv: { PATH: sourceBinDir },
      rootDir: wrapperDir,
      zshRootDir: path.join(tempDir, "zsh"),
    });

    const wrapper = fs.readFileSync(path.join(wrapperDir, "codex"), "utf8");
    expect(wrapper).toContain("--enable hooks");
    expect(wrapper).not.toContain("--enable codex_hooks");
  });

  it("forwards Codex SetThreadName operations as CLI metadata", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hscode-codex-title-"));
    tempDirs.push(tempDir);
    const sourceBinDir = path.join(tempDir, "source-bin");
    const wrapperDir = path.join(tempDir, "wrappers");
    fs.mkdirSync(sourceBinDir);

    const codexPath = path.join(sourceBinDir, "codex");
    fs.writeFileSync(codexPath, "#!/bin/sh\n", { mode: 0o755 });

    const state = prepareManagedTerminalWrappers({
      baseEnv: { PATH: sourceBinDir },
      rootDir: wrapperDir,
      zshRootDir: path.join(tempDir, "zsh"),
    });

    const wrapper = fs.readFileSync(path.join(wrapperDir, "codex"), "utf8");
    expect(wrapper).toContain(`*'"dir":"from_tui"'*'"kind":"op"'*'"SetThreadName"'*)`);
    expect(wrapper).toContain(`awk -F'"name":"'`);
    expect(wrapper).toContain('"summary":"%s"');
    expect(wrapper).toContain('_t3code_emit_title "$_t3code_thread_name"');

    const notifyHook = fs.readFileSync(state.hookScriptPath!, "utf8");
    expect(notifyHook).toContain('"$(_t3code_extract_event summary)"');
    execFileSync("sh", ["-n", path.join(wrapperDir, "codex")]);
    execFileSync("sh", ["-n", state.hookScriptPath!]);
  });

  describe("Claude notify hook signal mapping", () => {
    const HOOK_OSC = (eventType: string) => `]633;T3CODE_AGENT_EVENT=${eventType}`;

    function runNotifyHook(payload: Record<string, unknown>): string {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hscode-notify-hook-"));
      tempDirs.push(tempDir);
      const sourceBinDir = path.join(tempDir, "source-bin");
      fs.mkdirSync(sourceBinDir);
      fs.writeFileSync(path.join(sourceBinDir, "claude"), "#!/bin/sh\n", { mode: 0o755 });

      const state = prepareManagedTerminalWrappers({
        baseEnv: { PATH: sourceBinDir },
        rootDir: path.join(tempDir, "wrappers"),
        zshRootDir: path.join(tempDir, "zsh"),
      });

      const sinkPath = path.join(tempDir, "events.sink");
      fs.writeFileSync(sinkPath, "");
      execFileSync("sh", [state.hookScriptPath!], {
        input: JSON.stringify(payload),
        env: { ...process.env, T3CODE_TERMINAL_EVENT_SINK: sinkPath },
      });
      return fs.readFileSync(sinkPath, "utf8");
    }

    it("emits an attention signal for permission-prompt Notifications", () => {
      const sink = runNotifyHook({
        hook_event_name: "Notification",
        message: "Claude needs your permission to use Bash",
      });
      expect(sink).toContain(HOOK_OSC("PermissionRequest"));
    });

    it("emits an attention signal for PermissionRequest hook events", () => {
      const sink = runNotifyHook({ hook_event_name: "PermissionRequest" });
      expect(sink).toContain(HOOK_OSC("PermissionRequest"));
    });

    it("drops the 60s idle waiting-for-input Notification instead of paging attention", () => {
      // Claude fires Notification("Claude is waiting for your input") 60s after
      // a turn ends. Mapping it to PermissionRequest bounced every idle thread
      // review → attention and paged webhook subscribers with nothing to do.
      const sink = runNotifyHook({
        hook_event_name: "Notification",
        message: "Claude is waiting for your input",
      });
      expect(sink).not.toContain("T3CODE_AGENT_EVENT=");
    });

    it("still emits a review signal for Stop hook events", () => {
      const sink = runNotifyHook({ hook_event_name: "Stop" });
      expect(sink).toContain(HOOK_OSC("Stop"));
    });

    it("forwards thread id and cwd from Codex agent-turn-complete payloads", () => {
      // Codex's notify payload uses hyphenated keys and is the only channel
      // that survives TUI log format drift — it must keep session-resume ids
      // and worktree following alive on its own.
      const sink = runNotifyHook({
        type: "agent-turn-complete",
        "thread-id": "019fa834-3ef8-76c1-a426-d281024a82df",
        "turn-id": "turn-1",
        cwd: "/home/user/repo/.worktrees/feature",
        "last-assistant-message": "done",
      });
      expect(sink).toContain(HOOK_OSC("Stop"));
      const metaLine = sink.split("\n").find((line) => line.includes("T3CODE_CLI_META="));
      expect(metaLine).toBeDefined();
      const encoded = /T3CODE_CLI_META=([A-Za-z0-9+/=]+)/.exec(metaLine!)?.[1];
      expect(encoded).toBeDefined();
      const meta = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
      expect(meta).toMatchObject({
        cliKind: "codex",
        sessionId: "019fa834-3ef8-76c1-a426-d281024a82df",
        cwd: "/home/user/repo/.worktrees/feature",
      });
    });

    it("emits no Codex CLI metadata for Claude Stop payloads", () => {
      const sink = runNotifyHook({ hook_event_name: "Stop", session_id: "" });
      expect(sink).not.toContain("T3CODE_CLI_META=");
    });
  });

  it("emits Start for submitted turns in the current Codex TUI log format", () => {
    // Newer Codex TUIs log no '"kind":"codex_event"' lines at all, so the
    // task_started/exec_command_begin patterns stopped matching and Start
    // signals vanished — sessions stuck in "review" while the agent worked.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hscode-codex-user-turn-"));
    tempDirs.push(tempDir);
    const sourceBinDir = path.join(tempDir, "source-bin");
    const wrapperDir = path.join(tempDir, "wrappers");
    fs.mkdirSync(sourceBinDir);
    fs.writeFileSync(path.join(sourceBinDir, "codex"), "#!/bin/sh\n", { mode: 0o755 });

    prepareManagedTerminalWrappers({
      baseEnv: { PATH: sourceBinDir },
      rootDir: wrapperDir,
      zshRootDir: path.join(tempDir, "zsh"),
    });

    const userTurnPattern = `*'"dir":"from_tui"'*'"kind":"op"'*'"UserTurn"'*`;
    const wrapper = fs.readFileSync(path.join(wrapperDir, "codex"), "utf8");
    expect(wrapper).toContain(`${userTurnPattern})`);
    // The UserTurn payload also carries the turn-context cwd — the only cwd
    // signal left in this log format (exec events are no longer logged).
    expect(wrapper).toContain('_t3code_emit_cwd "$_t3code_user_turn_cwd"');
    execFileSync("sh", ["-n", path.join(wrapperDir, "codex")]);

    // Prove the glob matches a real line from the current log format (sampled
    // from a live Codex session on 2026-07-28).
    const sampleLine =
      '{"ts":"2026-07-28T14:49:11.974Z","dir":"from_tui","kind":"op","payload":{"UserTurn":{"items":[{"type":"text","text":"What is the next performance fix?","text_elements":[]}],"cwd":"/home/user/repo"}}}';
    const matched = execFileSync(
      "sh",
      ["-c", `case "$1" in ${userTurnPattern}) echo match;; *) echo miss;; esac`, "sh", sampleLine],
      { encoding: "utf8" },
    ).trim();
    expect(matched).toBe("match");
  });

  it("forwards session ids from the current Codex TUI log format", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hscode-codex-session-id-"));
    tempDirs.push(tempDir);
    const sourceBinDir = path.join(tempDir, "source-bin");
    const wrapperDir = path.join(tempDir, "wrappers");
    fs.mkdirSync(sourceBinDir);
    fs.writeFileSync(path.join(sourceBinDir, "codex"), "#!/bin/sh\n", { mode: 0o755 });

    prepareManagedTerminalWrappers({
      baseEnv: { PATH: sourceBinDir },
      rootDir: wrapperDir,
      zshRootDir: path.join(tempDir, "zsh"),
    });

    const wrapper = fs.readFileSync(path.join(wrapperDir, "codex"), "utf8");
    expect(wrapper).toContain(
      `*'"dir":"to_tui"'*'"kind":"app_event"'*'thread_id: ThreadId { uuid: '*)`,
    );
    expect(wrapper).toContain(`awk -F'thread_id: ThreadId { uuid: '`);
    expect(wrapper).toContain('_t3code_emit_session_id "$_t3code_new_session_id"');
  });
});

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
});

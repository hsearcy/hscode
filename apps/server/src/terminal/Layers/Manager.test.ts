import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  PtySpawnError,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
} from "../Services/PTY";
import { classifyTerminalSubprocessTree, TerminalManagerRuntime } from "./Manager";
import { Effect, Encoding } from "effect";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  killed = false;
  paused = false;

  constructor(readonly pid: number) {}

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter implements PtyAdapterShape {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private nextPid = 9000;

  constructor(private readonly mode: "sync" | "async" = "sync") {}

  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtySpawnError({
          adapter: "fake",
          message: "Failed to spawn PTY process",
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtySpawnError({
            adapter: "fake",
            message: "Failed to spawn PTY process",
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 800): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(poll, 15);
    };
    poll();
  });
}

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function restartInput(overrides: Partial<TerminalRestartInput> = {}): TerminalRestartInput {
  return {
    threadId: "thread-1",
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function historyLogName(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}.log`;
}

function multiTerminalHistoryLogName(threadId: string, terminalId: string): string {
  const threadPart = `terminal_${Encoding.encodeBase64Url(threadId)}`;
  if (terminalId === DEFAULT_TERMINAL_ID) {
    return `${threadPart}.log`;
  }
  return `${threadPart}_${Encoding.encodeBase64Url(terminalId)}.log`;
}

function historyLogPath(logsDir: string, threadId = "thread-1"): string {
  return path.join(logsDir, historyLogName(threadId));
}

function multiTerminalHistoryLogPath(
  logsDir: string,
  threadId = "thread-1",
  terminalId = "default",
): string {
  return path.join(logsDir, multiTerminalHistoryLogName(threadId, terminalId));
}

describe("TerminalManager", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeManager(
    historyLineLimit = 5,
    options: {
      shellResolver?: () => string;
      subprocessChecker?: (terminalPid: number) => Promise<boolean>;
      subprocessPollIntervalMs?: number;
      processKillGraceMs?: number;
      maxRetainedInactiveSessions?: number;
      ptyAdapter?: FakePtyAdapter;
      historyByteLimit?: number;
      idleSleepMs?: number;
      idleSleepCheckIntervalMs?: number;
    } = {},
  ) {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-terminal-"));
    tempDirs.push(logsDir);
    const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();
    const manager = new TerminalManagerRuntime({
      logsDir,
      ptyAdapter,
      historyLineLimit,
      shellResolver: options.shellResolver ?? (() => "/bin/bash"),
      ...(options.subprocessChecker ? { subprocessChecker: options.subprocessChecker } : {}),
      ...(options.subprocessPollIntervalMs
        ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
        : {}),
      ...(options.processKillGraceMs ? { processKillGraceMs: options.processKillGraceMs } : {}),
      ...(options.maxRetainedInactiveSessions
        ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
        : {}),
      ...(options.historyByteLimit ? { historyByteLimit: options.historyByteLimit } : {}),
      ...(options.idleSleepMs !== undefined ? { idleSleepMs: options.idleSleepMs } : {}),
      ...(options.idleSleepCheckIntervalMs !== undefined
        ? { idleSleepCheckIntervalMs: options.idleSleepCheckIntervalMs }
        : {}),
    });
    return { logsDir, ptyAdapter, manager };
  }

  it("spawns lazily and reuses running terminal per thread", async () => {
    const { manager, ptyAdapter } = makeManager();
    const [first, second] = await Promise.all([
      manager.open(openInput()),
      manager.open(openInput()),
    ]);
    const third = await manager.open(openInput());

    expect(first.threadId).toBe("thread-1");
    expect(first.terminalId).toBe("default");
    expect(second.threadId).toBe("thread-1");
    expect(third.threadId).toBe("thread-1");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);

    manager.dispose();
  });

  it("supports asynchronous PTY spawn effects", async () => {
    const { manager, ptyAdapter } = makeManager(5, { ptyAdapter: new FakePtyAdapter("async") });

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(1);
    expect(ptyAdapter.processes).toHaveLength(1);

    manager.dispose();
  });

  it("forwards write and resize to active pty process", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.write({ threadId: "thread-1", data: "ls\n" });
    await manager.resize({ threadId: "thread-1", cols: 120, rows: 30 });

    expect(process.writes).toEqual(["ls\n"]);
    expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);

    manager.dispose();
  });

  it("resizes running terminal on open when a different size is requested", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ cols: 100, rows: 24 }));
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.open(openInput({ cols: 140, rows: 40 }));

    expect(process.resizeCalls).toEqual([{ cols: 140, rows: 40 }]);

    manager.dispose();
  });

  it("preserves existing terminal size on open when size is omitted", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ cols: 100, rows: 24 }));
    const ptyProcess = ptyAdapter.processes[0];
    expect(ptyProcess).toBeDefined();
    if (!ptyProcess) return;

    await manager.open({
      threadId: "thread-1",
      cwd: globalThis.process.cwd(),
    });

    expect(ptyProcess.resizeCalls).toEqual([]);

    ptyProcess.emitExit({ exitCode: 0, signal: 0 });
    await manager.open({
      threadId: "thread-1",
      cwd: globalThis.process.cwd(),
    });

    const resumedSpawn = ptyAdapter.spawnInputs[1];
    expect(resumedSpawn).toBeDefined();
    if (!resumedSpawn) return;
    expect(resumedSpawn.cols).toBe(100);
    expect(resumedSpawn.rows).toBe(24);

    manager.dispose();
  });

  it("uses default dimensions when opening a new terminal without size hints", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open({
      threadId: "thread-1",
      cwd: process.cwd(),
    });

    const spawned = ptyAdapter.spawnInputs[0];
    expect(spawned).toBeDefined();
    if (!spawned) return;
    expect(spawned.cols).toBe(120);
    expect(spawned.rows).toBe(30);

    manager.dispose();
  });

  it("supports multiple terminals per thread with isolated sessions", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput({ terminalId: "default" }));
    await manager.open(openInput({ terminalId: "term-2" }));

    const first = ptyAdapter.processes[0];
    const second = ptyAdapter.processes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    await manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
    await manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

    expect(first.writes).toEqual(["pwd\n"]);
    expect(second.writes).toEqual(["ls\n"]);
    expect(ptyAdapter.spawnInputs).toHaveLength(2);

    manager.dispose();
  });

  it("clears transcript and emits cleared event", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("hello\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    await manager.clear({ threadId: "thread-1" });
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === "");

    expect(events.some((event) => event.type === "cleared")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "cleared" &&
          event.threadId === "thread-1" &&
          event.terminalId === "default",
      ),
    ).toBe(true);

    manager.dispose();
  });

  it("restarts terminal with empty transcript and respawns pty", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    const firstProcess = ptyAdapter.processes[0];
    expect(firstProcess).toBeDefined();
    if (!firstProcess) return;
    firstProcess.emitData("before restart\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));

    const snapshot = await manager.restart(restartInput());
    expect(snapshot.history).toBe("");
    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    await waitFor(() => fs.readFileSync(historyLogPath(logsDir), "utf8") === "");

    manager.dispose();
  });

  it("emits exited event and reopens with clean transcript after exit", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData("old data\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));
    process.emitExit({ exitCode: 0, signal: 0 });

    await waitFor(() => events.some((event) => event.type === "exited"));
    const reopened = await manager.open(openInput());

    expect(reopened.history).toBe("");
    expect(ptyAdapter.spawnInputs).toHaveLength(2);
    expect(fs.readFileSync(historyLogPath(logsDir), "utf8")).toBe("");

    manager.dispose();
  });

  it("ignores trailing writes after terminal exit", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitExit({ exitCode: 0, signal: 0 });

    await expect(manager.write({ threadId: "thread-1", data: "\r" })).resolves.toBeUndefined();
    expect(process.writes).toEqual([]);

    manager.dispose();
  });

  it("emits subprocess activity events when child-process state changes", async () => {
    let hasRunningSubprocess = false;
    const { manager } = makeManager(5, {
      subprocessChecker: async () => hasRunningSubprocess,
      subprocessPollIntervalMs: 20,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    await waitFor(() => events.some((event) => event.type === "started"));
    expect(events.some((event) => event.type === "activity")).toBe(false);

    hasRunningSubprocess = true;
    await waitFor(
      () =>
        events.some((event) => event.type === "activity" && event.hasRunningSubprocess === true),
      1_200,
    );

    hasRunningSubprocess = false;
    await waitFor(
      () =>
        events.some((event) => event.type === "activity" && event.hasRunningSubprocess === false),
      1_200,
    );

    manager.dispose();
  });

  it("emits a completion activity event for every Stop hook, even from a stale review state", async () => {
    // Regression for the 2026-07-28 missed Codex webhook: newer Codex TUIs
    // stopped logging the events the wrapper derived Start signals from, so
    // the session sat in "review" while the agent kept working (only
    // subprocess metadata changed). The next genuine completion arrived as a
    // review→review Stop and the change-gated emit swallowed it entirely.
    let hasRunningSubprocess = false;
    const { manager, logsDir } = makeManager(5, {
      subprocessChecker: async () => hasRunningSubprocess,
      subprocessPollIntervalMs: 20,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    const activityEvents = () =>
      events.filter(
        (event): event is Extract<TerminalEvent, { type: "activity" }> => event.type === "activity",
      );

    await manager.open(openInput());
    // Hook events arrive through the managed event sink file, exactly as the
    // notify hook delivers them in production.
    const sinkPath = `${historyLogPath(logsDir)}.events`;
    await waitFor(() => fs.existsSync(sinkPath));
    const appendStop = () =>
      fs.appendFileSync(sinkPath, "\u001b]633;T3CODE_AGENT_EVENT=Stop\u0007\n");

    appendStop();
    await waitFor(() =>
      activityEvents().some(
        (event) => event.agentState === "review" && event.turnCompletionCount === 1,
      ),
    );

    // The agent goes back to work, but its Start signal is lost: only
    // subprocess metadata changes while the stored state stays "review".
    hasRunningSubprocess = true;
    await waitFor(
      () =>
        activityEvents().some(
          (event) => event.hasRunningSubprocess && event.agentState === "review",
        ),
      1_200,
    );
    hasRunningSubprocess = false;
    await waitFor(() => {
      const latest = activityEvents().at(-1);
      return (
        latest !== undefined &&
        !latest.hasRunningSubprocess &&
        latest.agentState === "review" &&
        latest.turnCompletionCount === 1
      );
    }, 1_200);

    // The next completion is a review→review Stop — it must still emit,
    // carrying a bumped turnCompletionCount.
    appendStop();
    await waitFor(() =>
      activityEvents().some(
        (event) => event.agentState === "review" && event.turnCompletionCount === 2,
      ),
    );

    manager.dispose();
  });

  it("caps persisted history to configured line limit", async () => {
    const { manager, ptyAdapter } = makeManager(3);
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("line1\nline2\nline3\nline4\n");
    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
    expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);

    manager.dispose();
  });

  it("caps history bytes when output stays under the line limit", async () => {
    const byteLimit = 2_048;
    const { manager, ptyAdapter } = makeManager(5_000, { historyByteLimit: byteLimit });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    // Full-screen TUI repaints: cursor addressing instead of newlines, so the
    // line cap never trips no matter how many bytes accumulate.
    for (let index = 0; index < 8; index += 1) {
      process.emitData(`\u001b[2J\u001b[Hframe-${index}-`.padEnd(1_000, "x"));
    }
    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history.length).toBeLessThanOrEqual(byteLimit);
    expect(reopened.history).toContain("frame-7-");

    manager.dispose();
  });

  it("caps oversized persisted history bytes when loading from disk", async () => {
    const byteLimit = 4_096;
    const { manager, logsDir } = makeManager(5_000, { historyByteLimit: byteLimit });
    fs.writeFileSync(
      multiTerminalHistoryLogPath(logsDir),
      `start${"y".repeat(1_000_000)}end`,
      "utf8",
    );

    const opened = await manager.open(openInput());
    expect(opened.history.length).toBeLessThanOrEqual(byteLimit);
    expect(opened.history.endsWith("end")).toBe(true);

    manager.dispose();
  });

  it("drops runaway unterminated control sequences instead of buffering them forever", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    // An OSC that never terminates (e.g. binary noise) would otherwise pin
    // every subsequent byte inside pendingControlSequence.
    process.emitData(`\u001b]${"a".repeat(300_000)}`);
    process.emitData("recovered\n");
    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toContain("recovered");

    manager.dispose();
  });

  it("strips replay-unsafe terminal query and reply sequences from persisted history", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("prompt ");
    process.emitData("\u001b[32mok\u001b[0m ");
    process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
    process.emitData("\u001b[1;1R");
    process.emitData("done\n");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("prompt \u001b[32mok\u001b[0m done\n");

    manager.dispose();
  });

  it("holds output during a resume repaint and releases it as one batch", async () => {
    const { manager, ptyAdapter } = makeManager();
    const outputs: string[] = [];
    manager.on("event", (event) => {
      if (event.type === "output") outputs.push(event.data);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    manager.holdOutputUntilQuiet({
      threadId: "thread-1",
      terminalId: "default",
      settleMs: 60,
      maxMs: 5_000,
    });
    process.emitData("frame-1");
    process.emitData("frame-2");
    process.emitData("frame-3");

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(outputs).toEqual([]);

    await waitFor(() => outputs.length > 0);
    expect(outputs).toEqual(["frame-1frame-2frame-3"]);

    // The hold is over: later output streams normally again.
    process.emitData("live");
    await waitFor(() => outputs.length > 1);
    expect(outputs[1]).toBe("live");

    manager.dispose();
  });

  it("does not pause the PTY for back-pressure while output is held", async () => {
    const { manager, ptyAdapter } = makeManager();
    const outputs: string[] = [];
    manager.on("event", (event) => {
      if (event.type === "output") outputs.push(event.data);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    manager.holdOutputUntilQuiet({
      threadId: "thread-1",
      terminalId: "default",
      settleMs: 60,
      maxMs: 5_000,
    });
    // Well past the normal 1 MB back-pressure watermark, well under the hold's
    // own ceiling: a transcript repaint must arrive as one uninterrupted batch.
    const frame = "x".repeat(600_000);
    process.emitData(frame);
    process.emitData(frame);
    process.emitData(frame);
    expect(process.paused).toBe(false);

    await waitFor(() => outputs.length > 0);
    expect(outputs).toEqual([frame.repeat(3)]);

    manager.dispose();
  });

  it("releases a held resume repaint as soon as the user types", async () => {
    const { manager, ptyAdapter } = makeManager();
    const outputs: string[] = [];
    manager.on("event", (event) => {
      if (event.type === "output") outputs.push(event.data);
    });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    manager.holdOutputUntilQuiet({
      threadId: "thread-1",
      terminalId: "default",
      settleMs: 5_000,
      maxMs: 30_000,
    });
    process.emitData("frame-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outputs).toEqual([]);

    await manager.write({ threadId: "thread-1", data: "x" });
    expect(outputs).toEqual(["frame-1"]);

    manager.dispose();
  });

  it("strips mouse and focus reporting mode switches from persisted history", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("prompt ");
    process.emitData("\u001b[?1002h\u001b[?1006h");
    process.emitData("\u001b[?1004h");
    process.emitData("\u001b[?25l");
    process.emitData("tui\u001b[?1002;1006l");
    process.emitData("\u001b[?1049h");
    process.emitData(" done\n");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("prompt \u001b[?25ltui\u001b[?1049h done\n");

    manager.dispose();
  });

  it("preserves clear and style control sequences while dropping chunk-split query traffic", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("before clear\n");
    process.emitData("\u001b[H\u001b[2J");
    process.emitData("prompt ");
    process.emitData("\u001b]11;");
    process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
    process.emitData("R\u001b[36mdone\u001b[0m\n");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe(
      "before clear\n\u001b[H\u001b[2Jprompt \u001b[36mdone\u001b[0m\n",
    );

    manager.dispose();
  });

  it("does not leak final bytes from ESC sequences with intermediate bytes", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("before ");
    process.emitData("\u001b(B");
    process.emitData("after\n");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("before \u001b(Bafter\n");

    manager.dispose();
  });

  it("preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    process.emitData("before ");
    process.emitData("\u001b(");
    process.emitData("Bafter\n");

    await manager.close({ threadId: "thread-1" });

    const reopened = await manager.open(openInput());
    expect(reopened.history).toBe("before \u001b(Bafter\n");

    manager.dispose();
  });

  it("deletes history file when close(deleteHistory=true)", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;
    process.emitData("bye\n");
    await waitFor(() => fs.existsSync(historyLogPath(logsDir)));

    await manager.close({ threadId: "thread-1", deleteHistory: true });
    expect(fs.existsSync(historyLogPath(logsDir))).toBe(false);

    manager.dispose();
  });

  it("closes all terminals for a thread when close omits terminalId", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();
    await manager.open(openInput({ terminalId: "default" }));
    await manager.open(openInput({ terminalId: "sidecar" }));
    const defaultProcess = ptyAdapter.processes[0];
    const sidecarProcess = ptyAdapter.processes[1];
    expect(defaultProcess).toBeDefined();
    expect(sidecarProcess).toBeDefined();
    if (!defaultProcess || !sidecarProcess) return;

    defaultProcess.emitData("default\n");
    sidecarProcess.emitData("sidecar\n");
    await waitFor(() => fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "default")));
    await waitFor(() => fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar")));

    await manager.close({ threadId: "thread-1", deleteHistory: true });

    expect(defaultProcess.killed).toBe(true);
    expect(sidecarProcess.killed).toBe(true);
    expect(fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "default"))).toBe(false);
    expect(fs.existsSync(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar"))).toBe(false);

    manager.dispose();
  });

  it("escalates terminal shutdown to SIGKILL when process does not exit in time", async () => {
    const { manager, ptyAdapter } = makeManager(5, { processKillGraceMs: 10 });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.close({ threadId: "thread-1" });
    await waitFor(() => process.killSignals.includes("SIGKILL"));

    expect(process.killSignals[0]).toBe("SIGTERM");
    expect(process.killSignals).toContain("SIGKILL");

    manager.dispose();
  });

  it("cancels SIGKILL escalation when the process exits after SIGTERM", async () => {
    const { manager, ptyAdapter } = makeManager(5, { processKillGraceMs: 30 });
    await manager.open(openInput());
    const process = ptyAdapter.processes[0];
    expect(process).toBeDefined();
    if (!process) return;

    await manager.close({ threadId: "thread-1" });
    process.emitExit({ exitCode: 0, signal: 15 });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(process.killSignals[0]).toBe("SIGTERM");
    expect(process.killSignals).not.toContain("SIGKILL");

    manager.dispose();
  });

  it("evicts oldest inactive terminal sessions when retention limit is exceeded", async () => {
    const { manager, ptyAdapter } = makeManager(5, { maxRetainedInactiveSessions: 1 });

    await manager.open(openInput({ threadId: "thread-1" }));
    await manager.open(openInput({ threadId: "thread-2" }));

    const first = ptyAdapter.processes[0];
    const second = ptyAdapter.processes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    first.emitExit({ exitCode: 0, signal: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    second.emitExit({ exitCode: 0, signal: 0 });

    await waitFor(() => {
      const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
      return sessions.size === 1;
    });

    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    const keys = [...sessions.keys()];
    expect(keys).toEqual(["thread-2\u0000default"]);

    manager.dispose();
  });

  it("migrates legacy transcript filenames to terminal-scoped history path on open", async () => {
    const { manager, logsDir } = makeManager();
    const legacyPath = path.join(logsDir, "thread-1.log");
    const nextPath = historyLogPath(logsDir);
    fs.writeFileSync(legacyPath, "legacy-line\n", "utf8");

    const snapshot = await manager.open(openInput());

    expect(snapshot.history).toBe("legacy-line\n");
    expect(fs.existsSync(nextPath)).toBe(true);
    expect(fs.readFileSync(nextPath, "utf8")).toBe("legacy-line\n");
    expect(fs.existsSync(legacyPath)).toBe(false);

    manager.dispose();
  });

  it("retries with fallback shells when preferred shell spawn fails", async () => {
    const { manager, ptyAdapter } = makeManager(5, {
      shellResolver: () => "/definitely/missing-shell -l",
    });
    ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

    const snapshot = await manager.open(openInput());

    expect(snapshot.status).toBe("running");
    expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
    expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/definitely/missing-shell");

    if (process.platform === "win32") {
      expect(
        ptyAdapter.spawnInputs.some(
          (input) => input.shell === "cmd.exe" || input.shell === "powershell.exe",
        ),
      ).toBe(true);
    } else {
      expect(
        ptyAdapter.spawnInputs.some((input) =>
          ["/bin/zsh", "/bin/bash", "/bin/sh", "zsh", "bash", "sh"].includes(input.shell),
        ),
      ).toBe(true);
    }

    manager.dispose();
  });

  it("filters app runtime env variables from terminal sessions", async () => {
    const originalValues = new Map<string, string | undefined>();
    const setEnv = (key: string, value: string | undefined) => {
      if (!originalValues.has(key)) {
        originalValues.set(key, process.env[key]);
      }
      if (value === undefined) {
        delete process.env[key];
        return;
      }
      process.env[key] = value;
    };
    const restoreEnv = () => {
      for (const [key, value] of originalValues) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    setEnv("PORT", "5173");
    setEnv("T3CODE_PORT", "3773");
    setEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
    setEnv("TEST_TERMINAL_KEEP", "keep-me");

    try {
      const { manager, ptyAdapter } = makeManager();
      await manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.T3CODE_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");

      manager.dispose();
    } finally {
      restoreEnv();
    }
  });

  it("injects runtime env overrides into spawned terminals", async () => {
    const { manager, ptyAdapter } = makeManager();
    await manager.open(
      openInput({
        env: {
          T3CODE_PROJECT_ROOT: "/repo",
          T3CODE_WORKTREE_PATH: "/repo/worktree-a",
          CUSTOM_FLAG: "1",
        },
      }),
    );
    const spawnInput = ptyAdapter.spawnInputs[0];
    expect(spawnInput).toBeDefined();
    if (!spawnInput) return;

    expect(spawnInput.env.T3CODE_PROJECT_ROOT).toBe("/repo");
    expect(spawnInput.env.T3CODE_WORKTREE_PATH).toBe("/repo/worktree-a");
    expect(spawnInput.env.CUSTOM_FLAG).toBe("1");

    manager.dispose();
  });

  it("starts zsh with prompt spacer disabled to avoid `%` end markers", async () => {
    if (process.platform === "win32") return;
    const { manager, ptyAdapter } = makeManager(5, {
      shellResolver: () => "/bin/zsh",
    });
    await manager.open(openInput());
    const spawnInput = ptyAdapter.spawnInputs[0];
    expect(spawnInput).toBeDefined();
    if (!spawnInput) return;

    expect(spawnInput.shell).toBe("/bin/zsh");
    expect(spawnInput.args).toEqual(["-o", "nopromptsp"]);

    manager.dispose();
  });

  it("sleeps an idle managed session and wakes it as a fresh spawn with resume semantics", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager(50, {
      subprocessChecker: async () => false,
      subprocessPollIntervalMs: 20,
      processKillGraceMs: 10,
      idleSleepMs: 60,
      idleSleepCheckIntervalMs: 20,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    const firstProcess = ptyAdapter.processes[0];
    expect(firstProcess).toBeDefined();
    if (!firstProcess) return;
    firstProcess.emitData("turn output\r\n");

    // A completed turn arrives through the managed hook event sink.
    const sinkPath = `${historyLogPath(logsDir)}.events`;
    await waitFor(() => fs.existsSync(sinkPath));
    fs.appendFileSync(sinkPath, "\u001b]633;T3CODE_AGENT_EVENT=Stop\u0007\n");

    await waitFor(() => events.some((event) => event.type === "slept"), 2_000);
    const sleptEvent = events.find(
      (event): event is Extract<TerminalEvent, { type: "slept" }> => event.type === "slept",
    );
    expect(sleptEvent?.snapshot.status).toBe("slept");
    expect(firstProcess.killed).toBe(true);
    // No "exited" crash event — sleeping is not an exit.
    expect(events.some((event) => event.type === "exited")).toBe(false);

    // Writes to a slept session are dropped silently instead of throwing.
    await expect(
      manager.write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "x" }),
    ).resolves.toBeUndefined();

    // Waking behaves like a fresh spawn: history survives and the caller's
    // auto-launch gate (consumeWasNewlySpawned) fires so the CLI resume
    // command gets typed.
    const woken = await manager.open(openInput());
    expect(woken.status).toBe("running");
    expect(woken.wokeFromSleep).toBe(true);
    expect(woken.history).toContain("turn output");
    expect(manager.consumeWasNewlySpawned("thread-1", DEFAULT_TERMINAL_ID)).toBe(true);
    expect(ptyAdapter.processes).toHaveLength(2);

    manager.dispose();
  });

  it("never sleeps a session that is mid-turn or waiting on an approval prompt", async () => {
    const { manager, logsDir, ptyAdapter } = makeManager(50, {
      subprocessChecker: async () => false,
      subprocessPollIntervalMs: 20,
      processKillGraceMs: 10,
      idleSleepMs: 40,
      idleSleepCheckIntervalMs: 15,
    });
    const events: TerminalEvent[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.open(openInput());
    const sinkPath = `${historyLogPath(logsDir)}.events`;
    await waitFor(() => fs.existsSync(sinkPath));
    // An approval prompt ("attention") must keep the PTY alive.
    fs.appendFileSync(sinkPath, "\u001b]633;T3CODE_AGENT_EVENT=PermissionRequest\u0007\n");
    await waitFor(() =>
      events.some((event) => event.type === "activity" && event.agentState === "attention"),
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events.some((event) => event.type === "slept")).toBe(false);
    expect(ptyAdapter.processes[0]?.killed).toBe(false);

    manager.dispose();
  });

  it("treats the provider CLI's own children as provider-owned, not user work", () => {
    // Regression: every claude session child-spawns its configured MCP
    // servers. Counting those as non-provider subprocesses flagged all agent
    // sessions as busy forever and permanently blocked idle sleep.
    const tree = new Map<number, Array<{ pid: number; command: string }>>([
      [100, [{ pid: 101, command: "/home/u/.local/bin/claude --settings /home/u/s.json" }]],
      [
        101,
        [
          { pid: 102, command: "/home/u/.local/share/slack-mcp/slack-mcp-server" },
          { pid: 103, command: "node /home/u/.nvm/versions/node/v24/bin/some-mcp" },
        ],
      ],
    ]);
    const activity = classifyTerminalSubprocessTree(100, tree);
    expect(activity.hasProviderDescendant).toBe(true);
    expect(activity.hasNonProviderSubprocess).toBe(false);
    expect(activity.hasRunningSubprocess).toBe(true);
    expect(activity.cliKind).toBe("claude");
  });

  it("still flags user-started subprocesses next to the provider CLI", () => {
    const tree = new Map<number, Array<{ pid: number; command: string }>>([
      [
        100,
        [
          { pid: 101, command: "/home/u/.local/bin/claude" },
          { pid: 104, command: "npm run build" },
        ],
      ],
    ]);
    const activity = classifyTerminalSubprocessTree(100, tree);
    expect(activity.hasProviderDescendant).toBe(true);
    expect(activity.hasNonProviderSubprocess).toBe(true);
  });

  it("peeks without spawning when wake is false", async () => {
    const { manager, ptyAdapter, logsDir } = makeManager();

    // No session entry: the peek serves persisted history from disk.
    fs.writeFileSync(historyLogPath(logsDir), "persisted scrollback\r\n");
    const peeked = await manager.open({ ...openInput(), wake: false });
    expect(peeked.status).toBe("slept");
    expect(peeked.history).toContain("persisted scrollback");
    expect(ptyAdapter.processes).toHaveLength(0);

    // A live session: the peek attaches without touching the process.
    const live = await manager.open(openInput());
    expect(live.status).toBe("running");
    const peekedLive = await manager.open({ ...openInput(), wake: false });
    expect(peekedLive.status).toBe("running");
    expect(peekedLive.pid).toBe(live.pid);
    expect(ptyAdapter.processes).toHaveLength(1);

    manager.dispose();
  });
});

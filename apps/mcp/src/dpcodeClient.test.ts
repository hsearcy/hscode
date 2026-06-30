import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// dpcodeClient.ts imports bun:sqlite for the unrelated DpcodeDb class, which the
// Node-based Vitest runner can't resolve. DpcodeWs (under test) never touches
// it, so a bare stub is enough to load the module.
vi.mock("bun:sqlite", () => ({ Database: class {} }));

const { DpcodeWs } = await import("./dpcodeClient.ts");

describe("DpcodeWs.enableAutoReconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function makeWs() {
    // wsUrl set so connect() never touches /proc discovery; we stub connect anyway.
    return new DpcodeWs({ wsUrl: "ws://127.0.0.1:1/mcp", authToken: undefined, homeDir: "/tmp" });
  }

  it("attempts an immediate connect when disconnected", () => {
    const ws = makeWs();
    const connect = vi.spyOn(ws, "connect").mockResolvedValue();
    ws.enableAutoReconnect(5000);
    expect(connect).toHaveBeenCalledTimes(1);
    ws.disableAutoReconnect();
  });

  it("keeps retrying on each interval while the socket stays down", async () => {
    const ws = makeWs();
    // Reconnect attempts reject (backend not up) — connected getter stays false.
    const connect = vi.spyOn(ws, "connect").mockRejectedValue(new Error("no backend"));
    ws.enableAutoReconnect(5000);
    expect(connect).toHaveBeenCalledTimes(1); // immediate kick
    await vi.advanceTimersByTimeAsync(5000);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(connect).toHaveBeenCalledTimes(3);
    ws.disableAutoReconnect();
  });

  it("stops calling connect once the socket is connected", async () => {
    const ws = makeWs();
    const connect = vi.spyOn(ws, "connect").mockImplementation(async () => {
      // Simulate a successful connection: `connected` flips to true.
      (ws as unknown as { ws: object }).ws = {};
    });
    ws.enableAutoReconnect(5000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(ws.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(15000);
    // No further connect attempts while connected.
    expect(connect).toHaveBeenCalledTimes(1);
    ws.disableAutoReconnect();
  });

  it("is idempotent — repeated enable calls create a single watcher", async () => {
    const ws = makeWs();
    const connect = vi.spyOn(ws, "connect").mockRejectedValue(new Error("no backend"));
    ws.enableAutoReconnect(5000);
    ws.enableAutoReconnect(5000);
    ws.enableAutoReconnect(5000);
    // Repeat calls are no-ops: one immediate kick, one interval registered.
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(connect).toHaveBeenCalledTimes(2); // single timer fired once
    ws.disableAutoReconnect();
  });

  it("disableAutoReconnect halts further attempts", async () => {
    const ws = makeWs();
    const connect = vi.spyOn(ws, "connect").mockRejectedValue(new Error("no backend"));
    ws.enableAutoReconnect(5000);
    ws.disableAutoReconnect();
    await vi.advanceTimersByTimeAsync(20000);
    expect(connect).toHaveBeenCalledTimes(1); // only the immediate kick
  });
});

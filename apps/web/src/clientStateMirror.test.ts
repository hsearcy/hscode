// FILE: clientStateMirror.test.ts
// Purpose: Verify the server mirror restores a wiped profile and only pushes changed entries.

import { describe, expect, it, vi } from "vitest";

import {
  CLIENT_STATE_MIRROR_MARKER_KEY,
  collectChangedClientState,
  restoreClientState,
} from "./clientStateMirror";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const storage = new Map(Object.entries(initial));
  return {
    map: storage,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
}

describe("collectChangedClientState", () => {
  it("reports every mirrored key before the first sync, then only changes", () => {
    const storage = createMemoryStorage({ "dpcode:theme": "dark", unrelated: "x" });
    const first = collectChangedClientState(storage, new Map());
    expect(first["dpcode:theme"]).toBe("dark");
    expect(first["dpcode:app-settings:v1"]).toBeNull();
    expect(first).not.toHaveProperty("unrelated");

    const lastSynced = new Map(Object.entries(first));
    expect(collectChangedClientState(storage, lastSynced)).toEqual({});

    storage.setItem("dpcode:theme", "light");
    expect(collectChangedClientState(storage, lastSynced)).toEqual({ "dpcode:theme": "light" });
  });
});

describe("restoreClientState", () => {
  it("overwrites local defaults with server values and sets the marker", async () => {
    const storage = createMemoryStorage({
      "dpcode:app-settings:v1": "defaults",
      "dpcode:sidebar-ui:v1": "local-only",
    });
    const api = {
      getClientState: vi.fn(async () => ({
        entries: { "dpcode:app-settings:v1": "saved", "not-mirrored": "ignored" },
      })),
      setClientState: vi.fn(async () => undefined),
    };

    await expect(restoreClientState(storage, api)).resolves.toBe(true);
    expect(storage.getItem("dpcode:app-settings:v1")).toBe("saved");
    expect(storage.getItem("dpcode:sidebar-ui:v1")).toBe("local-only");
    expect(storage.getItem("not-mirrored")).toBeNull();
    expect(storage.getItem(CLIENT_STATE_MIRROR_MARKER_KEY)).toBe("1");
    expect(api.setClientState).not.toHaveBeenCalled();
  });

  it("reports no change when the server has nothing new", async () => {
    const storage = createMemoryStorage({ "dpcode:theme": "dark" });
    const api = {
      getClientState: vi.fn(async () => ({ entries: { "dpcode:theme": "dark" } })),
      setClientState: vi.fn(async () => undefined),
    };
    await expect(restoreClientState(storage, api)).resolves.toBe(false);
    expect(storage.getItem(CLIENT_STATE_MIRROR_MARKER_KEY)).toBe("1");
  });

  it("does not set the marker when the server read fails", async () => {
    const storage = createMemoryStorage();
    const api = {
      getClientState: vi.fn(async () => {
        throw new Error("offline");
      }),
      setClientState: vi.fn(async () => undefined),
    };
    await expect(restoreClientState(storage, api)).rejects.toThrow("offline");
    expect(storage.getItem(CLIENT_STATE_MIRROR_MARKER_KEY)).toBeNull();
  });
});

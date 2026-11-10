// FILE: clientStateMirror.ts
// Purpose: Mirrors selected localStorage entries (settings, theme, sidebar layout) into the
// server db, and restores them after the browser profile is wiped (e.g. a crash corrupts
// Electron's localStorage leveldb and Chromium recreates it empty).
// Layer: Web bootstrap utility
// Exports: CLIENT_STATE_MIRRORED_KEYS, collectChangedClientState, restoreClientState,
//   startClientStateMirror

import type { NativeApi } from "@t3tools/contracts";

// Durable user preferences and layout only. Ephemeral or churny state (composer drafts,
// terminal state, browser state) stays local-only.
export const CLIENT_STATE_MIRRORED_KEYS = [
  "dpcode:app-settings:v1",
  "dpcode:theme",
  "dpcode:renderer-state:v8",
  "dpcode:sidebar-ui:v1",
  "dpcode:pinned-threads:v1",
  "dpcode:workspace-pages:v2",
  "dpcode:latest-project:v1",
  "dpcode:last-editor",
  "dpcode:feature-flags",
  "chat_thread_sidebar_width",
  "chat_right_panel_width",
] as const;

// Present once this profile has synced with the server at least once. A missing marker
// means the profile is new or was wiped, so the server copy must win over local values.
export const CLIENT_STATE_MIRROR_MARKER_KEY = "hscode:client-state-mirror:v1";

const SYNC_INTERVAL_MS = 2_000;
const RESTORE_RETRY_MS = 5_000;

type ClientStateApi = Pick<NativeApi["server"], "getClientState" | "setClientState">;
type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

export function collectChangedClientState(
  storage: KeyValueStorage,
  lastSynced: ReadonlyMap<string, string | null>,
): Record<string, string | null> {
  const changed: Record<string, string | null> = {};
  for (const key of CLIENT_STATE_MIRRORED_KEYS) {
    const value = storage.getItem(key);
    if (!lastSynced.has(key) || lastSynced.get(key) !== value) {
      changed[key] = value;
    }
  }
  return changed;
}

/**
 * Copies the server's mirrored entries into storage and sets the marker.
 * Returns true when any local value changed (the caller must reload, since
 * stores already hydrated from the old values).
 */
export async function restoreClientState(
  storage: KeyValueStorage,
  api: ClientStateApi,
): Promise<boolean> {
  const { entries } = await api.getClientState();
  let changed = false;
  for (const key of CLIENT_STATE_MIRRORED_KEYS) {
    const value = entries[key];
    if (value !== undefined && storage.getItem(key) !== value) {
      storage.setItem(key, value);
      changed = true;
    }
  }
  storage.setItem(CLIENT_STATE_MIRROR_MARKER_KEY, "1");
  return changed;
}

export function startClientStateMirror(
  api: ClientStateApi,
  storage: KeyValueStorage = window.localStorage,
): () => void {
  let disposed = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cleanupSyncing: (() => void) | null = null;
  const lastSynced = new Map<string, string | null>();

  const sync = () => {
    if (disposed || inFlight) return;
    let entries: Record<string, string | null>;
    try {
      entries = collectChangedClientState(storage, lastSynced);
    } catch {
      return;
    }
    if (Object.keys(entries).length === 0) return;
    inFlight = true;
    api
      .setClientState({ entries })
      .then(() => {
        for (const [key, value] of Object.entries(entries)) {
          lastSynced.set(key, value);
        }
      })
      // Failed pushes stay out of lastSynced, so the next tick retries them.
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };

  const startSyncing = () => {
    if (disposed) return;
    sync();
    const interval = setInterval(sync, SYNC_INTERVAL_MS);
    window.addEventListener("pagehide", sync);
    cleanupSyncing = () => {
      clearInterval(interval);
      window.removeEventListener("pagehide", sync);
    };
  };

  const restore = () => {
    if (disposed) return;
    restoreClientState(storage, api)
      .then((changed) => {
        if (disposed) return;
        if (changed) {
          window.location.reload();
          return;
        }
        startSyncing();
      })
      .catch(() => {
        // Never push before the server copy was read: that would overwrite the
        // good server values with this wiped profile's defaults.
        if (!disposed) timer = setTimeout(restore, RESTORE_RETRY_MS);
      });
  };

  let hasMarker = false;
  try {
    hasMarker = storage.getItem(CLIENT_STATE_MIRROR_MARKER_KEY) !== null;
  } catch {
    // Storage unavailable: nothing to mirror.
    return () => undefined;
  }
  if (hasMarker) {
    startSyncing();
  } else {
    restore();
  }

  return () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    cleanupSyncing?.();
  };
}

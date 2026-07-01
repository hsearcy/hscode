// Durable storage for global thread-event webhook subscriptions.
//
// Subscriptions outlive the hscode-mcp process: they are persisted to a JSON
// file so a stop/start (picking up new code) or a WSL/desktop restart doesn't
// force every remote orchestrator (Ares/Hermes) to re-subscribe. Only the
// durable fields are stored — throttle state (lastFiredAt) and timers are
// transient and reset on load.
//
// Secrets note: subscription `headers` may carry auth tokens (e.g.
// X-Gitlab-Token). They are written to the on-disk file (required to replay the
// webhook) but MUST NOT be echoed into logs. The reporter callbacks below only
// ever receive the file path and fs/parse error text — never header or URL
// contents.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ScreenScope = "off" | "tail" | "lastTurn";
export type SubscriptionState = "running" | "attention" | "review";

export interface PersistedSubscription {
  id: string;
  url: string;
  headers: Record<string, string>;
  states: SubscriptionState[];
  screenScope: ScreenScope;
  minIntervalMs: number;
}

/** Reports a non-fatal storage problem. Must never be passed secret material. */
export type Reporter = (message: string) => void;

const defaultReport: Reporter = (message) => {
  console.error(message);
};

const VALID_SCOPES: ReadonlySet<string> = new Set(["off", "tail", "lastTurn"]);
const VALID_STATES: ReadonlySet<string> = new Set(["running", "attention", "review"]);

const DEFAULT_STATES: SubscriptionState[] = ["review", "attention"];
const DEFAULT_MIN_INTERVAL_MS = 2000;

/**
 * Coerce one raw JSON value into a PersistedSubscription, applying the same
 * defaults `subscribe_threads` would. Returns null when the row lacks the
 * irreducible fields (id + url) and is therefore unusable.
 */
export function normalizeSubscriptionRow(row: unknown): PersistedSubscription | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.url !== "string") return null;

  const headers: Record<string, string> = {};
  if (r.headers && typeof r.headers === "object") {
    for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
    }
  }

  const states = Array.isArray(r.states)
    ? r.states.filter((s): s is SubscriptionState => typeof s === "string" && VALID_STATES.has(s))
    : [...DEFAULT_STATES];

  const screenScope =
    typeof r.screenScope === "string" && VALID_SCOPES.has(r.screenScope)
      ? (r.screenScope as ScreenScope)
      : "off";

  const minIntervalMs =
    typeof r.minIntervalMs === "number" && Number.isFinite(r.minIntervalMs)
      ? r.minIntervalMs
      : DEFAULT_MIN_INTERVAL_MS;

  return { id: r.id, url: r.url, headers, states, screenScope, minIntervalMs };
}

/** Parse the raw file contents into subscriptions. Throws only on invalid JSON. */
export function parseSubscriptions(raw: string): PersistedSubscription[] {
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data)) return [];
  const out: PersistedSubscription[] = [];
  for (const row of data) {
    const norm = normalizeSubscriptionRow(row);
    if (norm) out.push(norm);
  }
  return out;
}

export function serializeSubscriptions(subs: PersistedSubscription[]): string {
  return JSON.stringify(subs, null, 2);
}

/**
 * Load persisted subscriptions from `path`. A missing file (first run) yields
 * an empty list silently; a corrupt file is reported (path only) and ignored
 * so a bad write never wedges startup.
 */
export function loadSubscriptions(
  path: string,
  report: Reporter = defaultReport,
): PersistedSubscription[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return []; // No file yet — first run.
  }
  try {
    return parseSubscriptions(raw);
  } catch {
    report(`[hscode-mcp] subscriptions file ${path} is corrupt — ignoring.`);
    return [];
  }
}

/** Persist subscriptions to `path`, creating the parent directory as needed. */
export function saveSubscriptions(
  path: string,
  subs: PersistedSubscription[],
  report: Reporter = defaultReport,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializeSubscriptions(subs));
  } catch (err) {
    report(
      `[hscode-mcp] failed to persist subscriptions to ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

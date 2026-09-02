import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findEquivalentSubscription,
  loadSubscriptions,
  normalizeSubscriptionRow,
  type PersistedSubscription,
  parseSubscriptions,
  reconcileSubscriptions,
  saveSubscriptions,
  serializeSubscriptions,
} from "./subscriptionStore.ts";

const SECRET = "glpat-super-secret-token";

function sampleSub(overrides: Partial<PersistedSubscription> = {}): PersistedSubscription {
  return {
    id: "bc298910-ced7-4c9e-b713-c597fa9d86f8",
    url: "http://ares:8644/webhooks/hscode-idle-to-ares",
    headers: { "X-Gitlab-Token": SECRET },
    states: ["review", "attention"],
    screenScope: "lastTurn",
    minIntervalMs: 5000,
    ...overrides,
  };
}

describe("normalizeSubscriptionRow", () => {
  it("preserves all durable fields including auth headers", () => {
    const sub = sampleSub();
    expect(normalizeSubscriptionRow(sub)).toEqual(sub);
  });

  it("rejects rows missing id or url", () => {
    expect(normalizeSubscriptionRow({ url: "http://x" })).toBeNull();
    expect(normalizeSubscriptionRow({ id: "x" })).toBeNull();
    expect(normalizeSubscriptionRow(null)).toBeNull();
    expect(normalizeSubscriptionRow("nope")).toBeNull();
  });

  it("applies defaults for missing optional fields", () => {
    const norm = normalizeSubscriptionRow({ id: "a", url: "http://x" });
    expect(norm).toEqual({
      id: "a",
      url: "http://x",
      headers: {},
      states: ["review", "attention"],
      screenScope: "off",
      minIntervalMs: 2000,
    });
  });

  it("drops invalid states, scopes, and non-string header values", () => {
    const norm = normalizeSubscriptionRow({
      id: "a",
      url: "http://x",
      states: ["review", "bogus", 7],
      screenScope: "weird",
      minIntervalMs: "fast",
      headers: { Good: "y", Bad: 5 },
    });
    expect(norm).toEqual({
      id: "a",
      url: "http://x",
      headers: { Good: "y" },
      states: ["review"],
      screenScope: "off",
      minIntervalMs: 2000,
    });
  });
});

describe("parse / serialize round-trip", () => {
  it("round-trips a subscription through serialize+parse without loss", () => {
    const sub = sampleSub();
    const restored = parseSubscriptions(serializeSubscriptions([sub]));
    expect(restored).toEqual([sub]);
    expect(restored[0]?.headers["X-Gitlab-Token"]).toBe(SECRET);
  });

  it("returns [] for a non-array payload", () => {
    expect(parseSubscriptions('{"not":"an array"}')).toEqual([]);
  });

  it("skips unusable rows but keeps valid ones", () => {
    const raw = JSON.stringify([sampleSub(), { junk: true }, { id: "b", url: "http://y" }]);
    const parsed = parseSubscriptions(raw);
    expect(parsed.map((s) => s.id)).toEqual([sampleSub().id, "b"]);
  });
});

describe("loadSubscriptions / saveSubscriptions", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subs-store-"));
    path = join(dir, "nested", "mcp-subscriptions.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists and restores subscriptions across a simulated restart", () => {
    const sub = sampleSub();
    saveSubscriptions(path, [sub]);
    // Fresh load — mimics a new process reading durable state on startup.
    expect(loadSubscriptions(path)).toEqual([sub]);
  });

  it("returns [] for a missing file without reporting an error", () => {
    const reports: string[] = [];
    expect(loadSubscriptions(join(dir, "absent.json"), (m) => reports.push(m))).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("ignores a corrupt file and reports only the path (never secrets)", () => {
    writeFileSync(path.replace("nested/", ""), "{ this is not json");
    const corruptPath = path.replace("nested/", "");
    const reports: string[] = [];
    expect(loadSubscriptions(corruptPath, (m) => reports.push(m))).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(corruptPath);
    expect(reports.join("\n")).not.toContain(SECRET);
  });

  it("does not leak header secrets through the error reporter on write failure", () => {
    // A directory path that cannot be created as a file forces a write error.
    const reports: string[] = [];
    saveSubscriptions(dir, [sampleSub()], (m) => reports.push(m));
    expect(reports.join("\n")).not.toContain(SECRET);
  });

  it("writes only the durable fields to disk", () => {
    saveSubscriptions(path, [sampleSub()]);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(onDisk[0]).sort()).toEqual(
      ["headers", "id", "minIntervalMs", "screenScope", "states", "url"].sort(),
    );
  });

  it("stores subscription secrets in a private file", () => {
    saveSubscriptions(path, [sampleSub()]);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("reconcileSubscriptions", () => {
  it("removes stale process state and preserves throttle state for durable subscriptions", () => {
    const keep = sampleSub({ id: "keep", minIntervalMs: 3000 });
    const stale = sampleSub({ id: "stale" });
    const lastFiredAt = new Map([["thread-1", 1234]]);
    const active = new Map([
      [keep.id, { ...keep, lastFiredAt }],
      [stale.id, { ...stale, lastFiredAt: new Map<string, number>() }],
    ]);
    const added = sampleSub({ id: "added" });

    reconcileSubscriptions(active, [{ ...keep, minIntervalMs: 9000 }, added]);

    expect([...active.keys()]).toEqual(["keep", "added"]);
    expect(active.get("keep")?.minIntervalMs).toBe(9000);
    expect(active.get("keep")?.lastFiredAt).toBe(lastFiredAt);
    expect(active.get("added")?.lastFiredAt).toEqual(new Map());
  });
});

describe("findEquivalentSubscription", () => {
  it("finds the existing ID when registration fields are equivalent", () => {
    const existing = sampleSub({ states: ["attention", "review"] });
    const requested = {
      ...sampleSub({ id: "ignored", states: ["review", "attention"] }),
      id: undefined,
    };
    const { id: _id, ...config } = requested;

    expect(findEquivalentSubscription([existing], config)?.id).toBe(existing.id);
  });

  it("does not merge subscriptions with different delivery settings", () => {
    const existing = sampleSub();
    const { id: _id, ...config } = sampleSub({ minIntervalMs: 9000 });

    expect(findEquivalentSubscription([existing], config)).toBeNull();
  });
});

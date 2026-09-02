import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimWebhookDelivery, pruneWebhookDeliveryClaims } from "./webhookDeliveryClaims.ts";

describe("claimWebhookDelivery", () => {
  let claimsDir: string;

  beforeEach(() => {
    claimsDir = mkdtempSync(join(tmpdir(), "webhook-claims-"));
  });

  afterEach(() => {
    rmSync(claimsDir, { recursive: true, force: true });
  });

  it("lets only one MCP process claim the same subscription event", () => {
    const event = {
      type: "activity",
      threadId: "11111111-2222-3333-4444-555555555555",
      terminalId: "default",
      agentState: "review",
      createdAt: "2026-09-01T13:00:00.000Z",
      turnCompletionCount: 8,
    };

    expect(claimWebhookDelivery(claimsDir, "subscription-1", event)).toBe(true);
    expect(claimWebhookDelivery(claimsDir, "subscription-1", event)).toBe(false);
  });

  it("allows a later event for the same subscription", () => {
    const first = {
      threadId: "11111111-2222-3333-4444-555555555555",
      agentState: "review",
      createdAt: "2026-09-01T13:00:00.000Z",
    };
    const second = { ...first, createdAt: "2026-09-01T13:01:00.000Z" };

    expect(claimWebhookDelivery(claimsDir, "subscription-1", first)).toBe(true);
    expect(claimWebhookDelivery(claimsDir, "subscription-1", second)).toBe(true);
  });

  it("allows separate subscriptions to receive the same event", () => {
    const event = {
      threadId: "11111111-2222-3333-4444-555555555555",
      agentState: "review",
      createdAt: "2026-09-01T13:00:00.000Z",
    };

    expect(claimWebhookDelivery(claimsDir, "subscription-1", event)).toBe(true);
    expect(claimWebhookDelivery(claimsDir, "subscription-2", event)).toBe(true);
  });

  it("removes expired claims but keeps recent claims", () => {
    const oldEvent = { threadId: "thread-1", createdAt: "old" };
    const recentEvent = { threadId: "thread-1", createdAt: "recent" };
    claimWebhookDelivery(claimsDir, "subscription-1", oldEvent);
    const oldClaim = join(claimsDir, readdirSync(claimsDir)[0]!);
    claimWebhookDelivery(claimsDir, "subscription-1", recentEvent);
    const recentClaim = readdirSync(claimsDir)
      .map((name) => join(claimsDir, name))
      .find((path) => path !== oldClaim)!;
    utimesSync(oldClaim, new Date(0), new Date(0));

    pruneWebhookDeliveryClaims(claimsDir, 60_000, 120_000);

    expect(existsSync(oldClaim)).toBe(false);
    expect(existsSync(recentClaim)).toBe(true);
  });
});

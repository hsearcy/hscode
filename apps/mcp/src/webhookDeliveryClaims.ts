import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

function claimKey(subscriptionId: string, event: Record<string, unknown>): string {
  return createHash("sha256")
    .update(subscriptionId)
    .update("\0")
    .update(JSON.stringify(event))
    .digest("hex");
}

/**
 * Atomically claim one subscription event across all local MCP processes.
 * The claim contains no webhook payload or subscription secret.
 */
export function claimWebhookDelivery(
  claimsDir: string,
  subscriptionId: string,
  event: Record<string, unknown>,
): boolean {
  mkdirSync(claimsDir, { recursive: true, mode: 0o700 });
  const path = join(claimsDir, claimKey(subscriptionId, event));

  try {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    // Delivery is more important than duplicate suppression if the local
    // claim store is temporarily unavailable.
    return true;
  }
}

/** Remove old claim files. Cleanup is best-effort and never blocks delivery. */
export function pruneWebhookDeliveryClaims(
  claimsDir: string,
  maxAgeMs: number,
  now = Date.now(),
): void {
  let names: string[];
  try {
    names = readdirSync(claimsDir);
  } catch {
    return;
  }

  for (const name of names) {
    const path = join(claimsDir, name);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) unlinkSync(path);
    } catch {
      // Another process can remove the same expired claim first.
    }
  }
}

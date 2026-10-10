import { expect, it } from "vitest";
import type { CommandThread } from "@t3tools/contracts";
import { displayCommandThread } from "./commandViewState";

const thread = {
  status: "review",
  statusVersion: "turn-1",
  reviewAt: "2026-09-09T12:00:00Z",
} as CommandThread;

it("clears reviewed completions and shows a later completion again", () => {
  const visited = "2026-09-09T12:01:00Z";
  expect(displayCommandThread(thread, undefined, visited).status).toBe("idle");
  expect(
    displayCommandThread({ ...thread, reviewAt: "2026-09-09T12:02:00Z" }, undefined, visited)
      .status,
  ).toBe("review");
  expect(displayCommandThread({ ...thread, status: "attention" }, undefined, visited).status).toBe(
    "attention",
  );
});

it("keeps a manual status until new activity and supports manual review", () => {
  const override = { status: "idle" as const, version: "turn-1" };
  expect(displayCommandThread({ ...thread, status: "working" }, override).status).toBe("idle");
  expect(displayCommandThread({ ...thread, statusVersion: "turn-2" }, override).status).toBe(
    "review",
  );
  expect(
    displayCommandThread(thread, { status: "review", version: "turn-1" }, "2026-09-09T13:00:00Z")
      .status,
  ).toBe("review");
});

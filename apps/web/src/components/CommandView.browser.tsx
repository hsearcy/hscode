import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CommandViewSnapshot, ThreadId, ProjectId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useCommandViewState } from "../commandViewState";
import { CommandView } from "./CommandView";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  getCommandView: vi.fn(),
  open: vi.fn(),
  getSnapshot: vi.fn(),
  dispatchCommand: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  syncConfig: vi.fn(),
  onEvent: vi.fn(() => () => {}),
}));
vi.mock("./terminal/terminalRuntimeRegistry", () => ({
  buildTerminalRuntimeKey: (threadId: string, terminalId: string) => `${threadId}::${terminalId}`,
  terminalRuntimeRegistry: {
    attach: mocks.attach,
    detach: mocks.detach,
    syncConfig: mocks.syncConfig,
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("./SidebarHeaderNavigationControls", () => ({
  SidebarHeaderNavigationControls: () => null,
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    server: { getCommandView: mocks.getCommandView },
    terminal: mocks,
    orchestration: { getSnapshot: mocks.getSnapshot, dispatchCommand: mocks.dispatchCommand },
  }),
  readNativeApi: () => undefined,
}));

let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  useCommandViewState.setState({ overrides: {}, reviewedAt: {} });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.getSnapshot.mockResolvedValue({
    threads: [
      {
        id: "sleeping",
        cliKind: "codex",
        interactionMode: "terminal-cli",
      },
    ],
  });
  mocks.dispatchCommand.mockResolvedValue({ sequence: 1 });
  const now = new Date().toISOString();
  mocks.getCommandView.mockResolvedValue({
    generatedAt: now,
    totalThreads: 2,
    threads: [
      {
        id: "sleeping" as ThreadId,
        projectId: "hscode" as ProjectId,
        projectTitle: "HS Code",
        title: "Fix resume",
        agent: "codex",
        cwd: "/repo",
        status: "asleep",
        lastActivityAt: now,
        response: "The saved session ID is now used.\n\n**All focused tests passed.**",
        responseAt: now,
        responseTruncated: false,
      },
      {
        id: "working" as ThreadId,
        projectId: "other" as ProjectId,
        projectTitle: "Other project",
        title: "Build search",
        agent: "claude",
        cwd: "/repo",
        status: "working",
        lastActivityAt: now,
        response: null,
        responseAt: null,
        responseTruncated: false,
      },
    ],
  } satisfies CommandViewSnapshot);
});
afterEach(() => client.clear());

function mount() {
  return render(
    <QueryClientProvider client={client}>
      <CommandView />
    </QueryClientProvider>,
  );
}

it("previews a sleeping response without opening its terminal, then opens the selected thread", async () => {
  await page.viewport(1440, 900);
  await mount();
  const previewButton = page.getByRole("button", { name: "Preview last response from Fix resume" });
  await previewButton.click();
  await expect
    .element(page.getByRole("complementary", { name: "Response preview: Fix resume" }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Close response preview" })).toHaveFocus();
  expect(document.querySelector(".command-preview strong")?.textContent).toBe(
    "All focused tests passed.",
  );
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await expect.element(previewButton).toHaveFocus();
  await previewButton.click();
  await page.getByRole("button", { name: "Open thread", exact: true }).click();
  expect(mocks.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ to: "/$threadId", params: { threadId: "sleeping" } }),
  );
});

it("filters by response text and project and can clear empty results", async () => {
  await mount();
  await page.getByRole("textbox", { name: "Search threads" }).fill("saved session");
  await expect.element(page.getByRole("button", { name: "Open Fix resume" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Open Build search" }))
    .not.toBeInTheDocument();
  await page.getByRole("combobox", { name: "Filter by project" }).selectOptions("other");
  await expect.element(page.getByRole("heading", { name: "No matching threads" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect.element(page.getByRole("button", { name: "Open Build search" })).toBeVisible();
});

it("keeps the response preview within a narrow screen", async () => {
  await page.viewport(390, 844);
  await mount();
  await page.getByRole("button", { name: "Preview last response from Fix resume" }).click();
  await expect
    .element(page.getByRole("button", { name: "Open thread", exact: true }))
    .toBeVisible();
  const bounds = document.querySelector(".command-preview")!.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(390);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});

it("opens terminal input inside Command only after Wake and reply, and detaches on close", async () => {
  await page.viewport(1440, 900);
  await mount();
  await page.getByRole("button", { name: "Preview last response from Fix resume" }).click();
  expect(document.querySelector(".command-read-more")).toBeNull();
  expect(mocks.attach).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Wake and reply", exact: true }).click();
  await expect.poll(() => mocks.attach.mock.calls.length).toBe(1);
  expect(mocks.attach).toHaveBeenCalledWith(
    expect.objectContaining({
      threadId: "sleeping",
      terminalId: "default",
      cwd: "/repo",
      terminalCliKind: "codex",
    }),
    expect.anything(),
    expect.any(HTMLDivElement),
  );
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(
    document.querySelector(".command-preview-top .command-open-thread")?.textContent,
  ).toContain("Open thread");
  expect(document.querySelector(".command-preview-reply .command-live-terminal")).not.toBeNull();
  expect(document.querySelector(".command-preview-body")?.textContent).toContain(
    "The saved session ID is now used.",
  );
  await expect
    .element(page.getByRole("button", { name: "Wake and reply", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Close response preview" }).click();
  expect(mocks.detach).toHaveBeenCalledWith("sleeping::default");
});

it("keeps a failed native prompt, then sends it without leaving Command", async () => {
  mocks.getSnapshot.mockResolvedValue({
    threads: [
      {
        id: "sleeping",
        interactionMode: "default",
        runtimeMode: "approval-required",
        modelSelection: { provider: "codex", model: "gpt-5" },
      },
    ],
  });
  mocks.dispatchCommand.mockRejectedValueOnce(new Error("Connection interrupted"));
  await mount();
  await page.getByRole("button", { name: "Preview last response from Fix resume" }).click();
  await page.getByRole("button", { name: "Wake and reply", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Prompt", exact: true });
  await input.fill("Please check the result.\nKeep the same settings.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Connection interrupted");
  await expect.element(input).toHaveValue("Please check the result.\nKeep the same settings.");
  await page.getByRole("button", { name: "Close response preview" }).click();
  await page.getByRole("button", { name: "Preview last response from Fix resume" }).click();
  await page.getByRole("button", { name: "Wake and reply", exact: true }).click();
  await expect.element(input).toHaveValue("Please check the result.\nKeep the same settings.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Prompt sent.");
  await expect.element(input).toHaveValue("");
  expect(mocks.dispatchCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "thread.turn.start",
      threadId: "sleeping",
      runtimeMode: "approval-required",
      modelSelection: { provider: "codex", model: "gpt-5" },
      message: expect.objectContaining({
        text: "Please check the result.\nKeep the same settings.",
      }),
    }),
  );
  expect(mocks.attach).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("opens an awake terminal immediately and keeps the next sleeping preview asleep", async () => {
  mocks.getSnapshot.mockResolvedValue({
    threads: [
      {
        id: "working",
        cliKind: "claude",
        interactionMode: "terminal-cli",
      },
    ],
  });
  await page.viewport(1440, 900);
  await mount();
  await page.getByRole("button", { name: "Preview last response from Build search" }).click();
  await expect.poll(() => mocks.attach.mock.calls.length).toBe(1);
  expect(mocks.attach).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: "working" }),
    expect.anything(),
    expect.any(HTMLDivElement),
  );
  await expect
    .element(page.getByRole("button", { name: "Wake and reply", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Close response preview" }).click();
  await page.getByRole("button", { name: "Preview last response from Fix resume" }).click();
  await expect
    .element(page.getByRole("button", { name: "Wake and reply", exact: true }))
    .toBeVisible();
  expect(mocks.attach).toHaveBeenCalledTimes(1);
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("shows an awake chat prompt immediately", async () => {
  mocks.getSnapshot.mockResolvedValue({
    threads: [
      {
        id: "working",
        interactionMode: "default",
        runtimeMode: "approval-required",
        modelSelection: { provider: "codex", model: "gpt-5" },
      },
    ],
  });
  await mount();
  await page.getByRole("button", { name: "Preview last response from Build search" }).click();
  await expect.element(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Wake and reply", exact: true }))
    .not.toBeInTheDocument();
  expect(mocks.attach).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("clears reviewed cards and supports a manual status until new activity", async () => {
  const snapshot = await mocks.getCommandView();
  snapshot.threads[0] = {
    ...snapshot.threads[0],
    status: "review",
    statusVersion: "turn-1",
    reviewAt: "2026-09-01T12:00:00Z",
  };
  mocks.getCommandView.mockResolvedValue(snapshot);
  await mount();
  await page.getByRole("button", { name: "Preview last response from Fix resume" }).click();
  await expect
    .poll(() => document.querySelector(".command-column-idle .command-card-title")?.textContent)
    .toContain("Fix resume");
  await page.getByRole("combobox", { name: "Set thread status" }).selectOptions("working");
  await expect
    .poll(() => document.querySelectorAll(".command-column-working .command-card").length)
    .toBe(2);
  await page.getByRole("combobox", { name: "Set thread status" }).selectOptions("idle");
  await expect
    .poll(() => document.querySelectorAll(".command-column-working .command-card").length)
    .toBe(1);
  client.setQueryData(["command-view"], {
    ...snapshot,
    threads: [
      { ...snapshot.threads[0], status: "working", statusVersion: "turn-2" },
      snapshot.threads[1],
    ],
  });
  await expect
    .element(page.getByRole("combobox", { name: "Set thread status" }))
    .toHaveValue("auto");
  await page.getByRole("combobox", { name: "Activity period" }).selectOptions("1");
  await page.getByRole("combobox", { name: "Activity period" }).selectOptions("4");
});

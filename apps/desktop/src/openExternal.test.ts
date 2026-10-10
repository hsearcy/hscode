import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  openExternal: vi.fn(),
  release: vi.fn(() => "6.6.0-microsoft-standard-WSL2"),
}));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:os", () => ({ release: mocks.release }));
vi.mock("electron", () => ({ shell: { openExternal: mocks.openExternal } }));

import { isRunningOnWSL, openExternal } from "./openExternal";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.release.mockReturnValue("6.6.0-microsoft-standard-WSL2");
  mocks.execFile.mockImplementation((_command, _args, _options, callback) => callback(null));
  mocks.openExternal.mockResolvedValue(undefined);
});

describe("isRunningOnWSL", () => {
  it("detects WSL from its environment or kernel", () => {
    expect(isRunningOnWSL("linux", { WSL_DISTRO_NAME: "Ubuntu" }, "generic")).toBe(true);
    expect(isRunningOnWSL("linux", { WSL_INTEROP: "/run/WSL/1_interop" }, "generic")).toBe(true);
    expect(isRunningOnWSL("linux", {}, "6.6-microsoft-standard-WSL2")).toBe(true);
    expect(isRunningOnWSL("linux", {}, "6.6-generic")).toBe(false);
    expect(isRunningOnWSL("win32", { WSL_DISTRO_NAME: "Ubuntu" }, "microsoft")).toBe(false);
  });
});

describe("openExternal", () => {
  it("opens WSL links through Windows with the URL kept as literal data", async () => {
    const url = "https://example.com/?a=';$(whoami)&b=日本語#section";
    await openExternal(url);
    expect(mocks.openExternal).not.toHaveBeenCalled();
    const [command, args, options] = mocks.execFile.mock.calls[0]!;
    expect(command).toBe("powershell.exe");
    expect(options).toMatchObject({ timeout: 15_000, windowsHide: true });
    expect(args.slice(0, -1)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    expect(script).toContain("-ErrorAction Stop");
    expect(script).toContain(url.replaceAll("'", "''"));
  });

  it("returns Windows launch errors without opening a Linux browser", async () => {
    mocks.execFile.mockImplementation((_command, _args, _options, callback) =>
      callback(new Error("Windows interop unavailable")),
    );
    await expect(openExternal("https://example.com")).rejects.toThrow(
      "Windows interop unavailable",
    );
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("uses Electron outside WSL", async () => {
    vi.stubEnv("WSL_DISTRO_NAME", "");
    vi.stubEnv("WSL_INTEROP", "");
    mocks.release.mockReturnValue("6.6-generic");
    try {
      await openExternal("https://example.com");
      expect(mocks.openExternal).toHaveBeenCalledWith("https://example.com");
      expect(mocks.execFile).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

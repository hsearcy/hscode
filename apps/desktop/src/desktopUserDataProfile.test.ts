import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveDesktopAppDataBase,
  resolveDesktopUserDataPath,
  resolveLegacyDesktopUserDataPaths,
  seedDesktopUserDataProfileFromLegacy,
} from "./desktopUserDataProfile";

describe("desktopUserDataProfile", () => {
  it("resolves HS Code profile names without reusing legacy profile paths", () => {
    const appDataBase = "/Users/tester/Library/Application Support";

    expect(resolveDesktopUserDataPath({ appDataBase, isDevelopment: true })).toBe(
      "/Users/tester/Library/Application Support/hscode-dev",
    );
    expect(resolveDesktopUserDataPath({ appDataBase, isDevelopment: false })).toBe(
      "/Users/tester/Library/Application Support/hscode",
    );
    expect(resolveLegacyDesktopUserDataPaths({ appDataBase, isDevelopment: true })).toEqual([
      "/Users/tester/Library/Application Support/dpcode-dev",
      "/Users/tester/Library/Application Support/t3code-dev",
      "/Users/tester/Library/Application Support/DP Code (Dev)",
    ]);
  });

  it("uses XDG_CONFIG_HOME on Linux when available", () => {
    expect(
      resolveDesktopAppDataBase({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/tmp/xdg" },
        homeDir: "/home/tester",
      }),
    ).toBe("/tmp/xdg");
  });

  it("seeds local persistent renderer data into the new HS profile once", () => {
    const tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "hscode-userdata-profile-"));
    try {
      const legacyPath = Path.join(tempDir, "dpcode-dev");
      const targetPath = Path.join(tempDir, "hscode-dev");
      FS.mkdirSync(Path.join(legacyPath, "Local Storage", "leveldb"), { recursive: true });
      FS.writeFileSync(
        Path.join(legacyPath, "Local Storage", "leveldb", "000003.log"),
        "t3code:pinned-threads:v1",
      );

      const result = seedDesktopUserDataProfileFromLegacy({
        targetPath,
        legacyPaths: [legacyPath],
      });

      expect(result.status).toBe("seeded");
      expect(
        FS.readFileSync(Path.join(targetPath, "Local Storage", "leveldb", "000003.log"), "utf8"),
      ).toBe("t3code:pinned-threads:v1");

      // Nothing left for the legacy profile to give: it holds no other store.
      const secondResult = seedDesktopUserDataProfileFromLegacy({
        targetPath,
        legacyPaths: [legacyPath],
      });
      expect(secondResult.status).toBe("legacy-missing");
      expect(
        FS.readFileSync(Path.join(targetPath, "Local Storage", "leveldb", "000003.log"), "utf8"),
      ).toBe("t3code:pinned-threads:v1");
    } finally {
      FS.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("re-seeds a single store Chromium recreated, leaving the rest untouched", () => {
    const tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "hscode-userdata-profile-"));
    try {
      const legacyPath = Path.join(tempDir, "dpcode");
      const targetPath = Path.join(tempDir, "hscode");
      FS.mkdirSync(Path.join(legacyPath, "Local Storage", "leveldb"), { recursive: true });
      FS.writeFileSync(
        Path.join(legacyPath, "Local Storage", "leveldb", "000003.log"),
        "dpcode:theme",
      );
      FS.mkdirSync(Path.join(legacyPath, "Session Storage"), { recursive: true });
      FS.writeFileSync(Path.join(legacyPath, "Session Storage", "stale.log"), "legacy");

      // The profile survives, but its Local Storage was wiped and rebuilt.
      FS.mkdirSync(Path.join(targetPath, "Session Storage"), { recursive: true });
      FS.writeFileSync(Path.join(targetPath, "Session Storage", "current.log"), "current");
      FS.writeFileSync(Path.join(targetPath, "Preferences"), "{}");

      const result = seedDesktopUserDataProfileFromLegacy({
        targetPath,
        legacyPaths: [legacyPath],
      });

      expect(result.status).toBe("seeded");
      expect(
        FS.readFileSync(Path.join(targetPath, "Local Storage", "leveldb", "000003.log"), "utf8"),
      ).toBe("dpcode:theme");
      // Stores the profile still had are left exactly as they were.
      expect(FS.existsSync(Path.join(targetPath, "Session Storage", "stale.log"))).toBe(false);
      expect(FS.readFileSync(Path.join(targetPath, "Preferences"), "utf8")).toBe("{}");
    } finally {
      FS.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports target-exists when every store is present", () => {
    const tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "hscode-userdata-profile-"));
    try {
      const legacyPath = Path.join(tempDir, "dpcode");
      const targetPath = Path.join(tempDir, "hscode");
      FS.mkdirSync(Path.join(legacyPath, "Local Storage"), { recursive: true });
      for (const entryName of ["Local Storage", "IndexedDB", "Session Storage"]) {
        FS.mkdirSync(Path.join(targetPath, entryName), { recursive: true });
      }
      FS.writeFileSync(Path.join(targetPath, "Preferences"), "{}");

      expect(
        seedDesktopUserDataProfileFromLegacy({ targetPath, legacyPaths: [legacyPath] }).status,
      ).toBe("target-exists");
    } finally {
      FS.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// FILE: LinuxWindowControls.tsx
// Purpose: Renders minimize / maximize / close buttons inside the Electron
// titlebar area on Linux, where the Electron window is frameless to avoid
// WSLg's Weston server-side decorations.
// Layer: Shared web shell chrome
// Depends on: window.desktopBridge.window IPC

import { useEffect, useState } from "react";
import {
  VscChromeClose,
  VscChromeMaximize,
  VscChromeMinimize,
  VscChromeRestore,
} from "react-icons/vsc";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";

const isLinuxPlatform = (() => {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform ?? "";
  const ua = navigator.userAgent ?? "";
  return /Linux/i.test(platform) && !/Android/i.test(ua);
})();

export function LinuxWindowControls({ className }: { className?: string }) {
  const bridge = typeof window !== "undefined" ? window.desktopBridge?.window : undefined;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.isMaximized().then((value) => {
      if (!cancelled) setMaximized(value);
    });
    const off = bridge.onMaximizeChange(setMaximized);
    return () => {
      cancelled = true;
      off();
    };
  }, [bridge]);

  if (!isElectron || !isLinuxPlatform || !bridge) {
    return null;
  }

  return (
    <div className={cn("flex shrink-0 items-center [-webkit-app-region:no-drag]", className)}>
      <button
        type="button"
        aria-label="Minimize"
        onClick={() => bridge.minimize()}
        className="flex h-8 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <VscChromeMinimize className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => bridge.toggleMaximize()}
        className="flex h-8 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {maximized ? (
          <VscChromeRestore className="size-3.5" />
        ) : (
          <VscChromeMaximize className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={() => bridge.close()}
        className="flex h-8 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-600 hover:text-white"
      >
        <VscChromeClose className="size-3.5" />
      </button>
    </div>
  );
}

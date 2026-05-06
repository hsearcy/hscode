import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useWorkspaceStore } from "~/workspaceStore";

function WorkspaceIndexRouteView() {
  const navigate = useNavigate();
  const workspaceId = useWorkspaceStore((state) => {
    const lastVisited = state.lastVisitedWorkspaceId;
    if (
      lastVisited !== null &&
      state.workspacePages.some((workspace) => workspace.id === lastVisited)
    ) {
      return lastVisited;
    }
    return state.workspacePages[0]?.id ?? null;
  });
  const redirectedRef = useRef(false);

  useEffect(() => {
    if (!workspaceId || redirectedRef.current) {
      return;
    }
    redirectedRef.current = true;
    void navigate({
      to: "/workspace/$workspaceId",
      params: { workspaceId },
      replace: true,
    });
  }, [navigate, workspaceId]);

  return null;
}

export const Route = createFileRoute("/_chat/workspace/")({
  component: WorkspaceIndexRouteView,
});

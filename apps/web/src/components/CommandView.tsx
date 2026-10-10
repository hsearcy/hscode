import {
  IconClock as ClockIcon,
  IconAlertCircle as CircleAlertIcon,
  IconExternalLink as ExternalLinkIcon,
  IconCircleCheck as CircleCheckIcon,
  IconLoader2 as LoaderCircleIcon,
  IconMoon as MoonIcon,
  IconSearch as SearchIcon,
  IconX as XIcon,
} from "@tabler/icons-react";
import type { CommandThread, CommandThreadStatus } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useCommandViewState,
  displayCommandThread,
  commandStatusVersion,
} from "~/commandViewState";
import { ensureNativeApi } from "~/nativeApi";
import ChatMarkdown from "./ChatMarkdown";
import { CommandReply } from "./CommandReply";
import { SidebarHeaderNavigationControls } from "./SidebarHeaderNavigationControls";
import { SidebarInset } from "./ui/sidebar";
import { commandColumn, filterCommandThreads, type CommandColumn } from "./CommandView.logic";
import "./CommandView.css";

const QUERY_KEY = ["command-view"] as const;
const EMPTY_THREADS: readonly CommandThread[] = [];
const STATUS: Record<CommandThreadStatus, { label: string; icon: typeof ClockIcon }> = {
  attention: { label: "Needs attention", icon: CircleAlertIcon },
  working: { label: "Working", icon: LoaderCircleIcon },
  review: { label: "Ready for review", icon: CircleCheckIcon },
  asleep: { label: "Asleep", icon: MoonIcon },
  idle: { label: "Idle", icon: ClockIcon },
  error: { label: "Error", icon: CircleAlertIcon },
};
const AGENTS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  claudeAgent: "Claude",
  claudex: "Claudex",
  grok: "Grok",
  gemini: "Gemini",
  opencode: "OpenCode",
};
const COLUMNS: { id: CommandColumn; label: string; icon: typeof ClockIcon; empty: string }[] = [
  {
    id: "attention",
    label: "Needs attention",
    icon: CircleAlertIcon,
    empty: "Nothing needs your attention.",
  },
  { id: "working", label: "Working", icon: LoaderCircleIcon, empty: "No threads are working." },
  { id: "idle", label: "Asleep & idle", icon: MoonIcon, empty: "No sleeping or inactive threads." },
];

function relativeTime(value: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  if (!Number.isFinite(minutes)) return "Unknown";
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function StatusBadge({ status }: { status: CommandThreadStatus }) {
  const { label, icon: Icon } = STATUS[status];
  return (
    <span className={`command-status command-status-${status}`}>
      <Icon aria-hidden="true" size={15} />
      {label}
    </span>
  );
}

function ThreadCard({
  thread,
  selected,
  now,
  onSelect,
  onOpen,
}: {
  thread: CommandThread;
  selected: boolean;
  now: number;
  onSelect: (thread: CommandThread, button: HTMLButtonElement) => void;
  onOpen: (thread: CommandThread) => void;
}) {
  return (
    <article className={`command-card${selected ? " is-selected" : ""}`}>
      <button
        className="command-card-title"
        onClick={() => onOpen(thread)}
        aria-label={`Open ${thread.title}`}
        title={`Open ${thread.title}`}
      >
        {thread.title}
        <ExternalLinkIcon size={14} aria-hidden="true" />
      </button>
      <p className="command-card-meta">
        <span>{thread.projectTitle}</span>
        <span aria-hidden="true">·</span>
        <span>{AGENTS[thread.agent] ?? thread.agent}</span>
      </p>
      <div className="command-card-state">
        <StatusBadge status={thread.status} />
        <time
          dateTime={thread.lastActivityAt}
          title={new Date(thread.lastActivityAt).toLocaleString()}
        >
          {relativeTime(thread.lastActivityAt, now)}
        </time>
      </div>
      <button
        className="command-excerpt"
        aria-label={`Preview last response from ${thread.title}`}
        aria-expanded={selected}
        aria-controls="command-response-preview"
        onClick={(event) => onSelect(thread, event.currentTarget)}
      >
        <span className="command-eyebrow">Last response</span>
        <span className={`command-excerpt-text${thread.response ? "" : " is-empty"}`}>
          {thread.response ?? "No saved response is available yet."}
        </span>
      </button>
    </article>
  );
}

export function CommandView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [projectId, setProjectId] = useState("all");
  const [hours, setHours] = useState(24);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replyId, setReplyId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const selectionButton = useRef<HTMLButtonElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => ensureNativeApi().server.getCommandView(),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    staleTime: 2000,
    retry: 1,
  });
  const overrides = useCommandViewState((state) => state.overrides);
  const reviewedAt = useCommandViewState((state) => state.reviewedAt);
  const setStatus = useCommandViewState((state) => state.setStatus);
  const markReviewed = useCommandViewState((state) => state.markReviewed);
  const rawThreads = query.data?.threads ?? EMPTY_THREADS;
  const threads = useMemo(
    () =>
      rawThreads.map((thread) =>
        displayCommandThread(thread, overrides[thread.id], reviewedAt[thread.id]),
      ),
    [rawThreads, overrides, reviewedAt],
  );
  const visible = useMemo(
    () => filterCommandThreads(threads, { query: search, projectId, hours, now }),
    [threads, search, projectId, hours, now],
  );
  const selected = threads.find((thread) => thread.id === selectedId) ?? null;
  const rawSelected = rawThreads.find((thread) => thread.id === selectedId);
  const manualStatus =
    rawSelected && overrides[rawSelected.id]?.version === commandStatusVersion(rawSelected)
      ? overrides[rawSelected.id]?.status
      : "auto";
  const projects = useMemo(
    () =>
      [...new Map(threads.map((thread) => [thread.projectId, thread.projectTitle])).entries()].sort(
        (a, b) => a[1].localeCompare(b[1]),
      ),
    [threads],
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    let pending: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = ensureNativeApi().terminal.onEvent((event) => {
      if (event.type === "output" || pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      }, 500);
    });
    return () => {
      clearInterval(timer);
      clearTimeout(pending);
      unsubscribe();
    };
  }, [queryClient]);

  useEffect(() => {
    if (!selectedId) return;
    closeButton.current?.focus();
  }, [selectedId]);

  const closePreview = () => {
    setSelectedId(null);
    setReplyId(null);
    selectionButton.current?.focus();
  };
  const openThread = (thread: CommandThread) => {
    markReviewed(thread.id);
    void navigate({ to: "/$threadId", params: { threadId: thread.id }, search: () => ({}) });
  };

  return (
    <SidebarInset
      className="command-view"
      onKeyDown={(event) => {
        if (event.key === "Escape" && selected) {
          event.stopPropagation();
          closePreview();
        }
      }}
    >
      <div className="command-topbar">
        <SidebarHeaderNavigationControls />
        <span>Command</span>
        <span className="command-refresh-state">
          {query.isError
            ? "Connection interrupted"
            : query.isPending
              ? "Loading threads…"
              : "Updates automatically"}
        </span>
      </div>
      <div className="command-heading">
        <div>
          <h1>Command</h1>
          <p>Recent threads across all projects</p>
        </div>
        <div className="command-filters">
          <label className="command-search">
            <SearchIcon size={17} aria-hidden="true" />
            <input
              aria-label="Search threads"
              placeholder="Search threads…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <select
            aria-label="Filter by project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="all">All projects</option>
            {projects.map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
          <select
            aria-label="Activity period"
            value={hours}
            onChange={(event) => setHours(Number(event.target.value))}
          >
            <option value={1}>Last hour</option>
            <option value={4}>Last 4 hours</option>
            <option value={24}>Last 24 hours</option>
            <option value={168}>Last 7 days</option>
            <option value={0}>All recent</option>
          </select>
        </div>
      </div>
      {query.isError && (
        <div role="alert" className="command-error">
          Could not update threads.{" "}
          {query.data ? "Showing the last saved view." : "Check the server connection."}
          <button onClick={() => void query.refetch()}>Retry</button>
        </div>
      )}
      <div className="command-content">
        {query.isPending ? (
          <div className="command-page-empty" role="status">
            <LoaderCircleIcon size={24} />
            <h2>Loading recent threads</h2>
          </div>
        ) : !visible.length ? (
          <div className="command-page-empty">
            <SearchIcon size={28} />
            <h2>{threads.length ? "No matching threads" : "No recent threads yet"}</h2>
            <p>
              {threads.length
                ? "Change the search, project, or time filter."
                : "Start a thread to see its status and last response here."}
            </p>
            {threads.length > 0 && (
              <button
                onClick={() => {
                  setSearch("");
                  setProjectId("all");
                  setHours(0);
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="command-board">
            {COLUMNS.map(({ id, label, icon: Icon, empty }) => {
              const cards = visible.filter((thread) => commandColumn(thread) === id);
              return (
                <section
                  key={id}
                  className={`command-column command-column-${id}`}
                  aria-label={label}
                >
                  <h2>
                    <Icon size={19} aria-hidden="true" />
                    {label}
                    <span>{cards.length}</span>
                  </h2>
                  <div className="command-column-cards">
                    {cards.length ? (
                      cards.map((thread) => (
                        <ThreadCard
                          key={thread.id}
                          thread={thread}
                          selected={selected?.id === thread.id}
                          now={now}
                          onSelect={(item, button) => {
                            selectionButton.current = button;
                            markReviewed(item.id);
                            setSelectedId(item.id);
                            if (item.id !== selectedId)
                              setReplyId(
                                rawThreads.find((thread) => thread.id === item.id)?.status ===
                                  "asleep"
                                  ? null
                                  : item.id,
                              );
                          }}
                          onOpen={openThread}
                        />
                      ))
                    ) : (
                      <p className="command-column-empty">{empty}</p>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}
        {selected && (
          <aside
            id="command-response-preview"
            className="command-preview"
            aria-label={`Response preview: ${selected.title}`}
          >
            <div className="command-preview-top">
              <span className="command-eyebrow">Response preview</span>
              <button className="command-open-thread" onClick={() => openThread(selected)}>
                Open thread
                <ExternalLinkIcon size={13} aria-hidden="true" />
              </button>
              <button ref={closeButton} onClick={closePreview} aria-label="Close response preview">
                <XIcon size={19} />
              </button>
            </div>
            <div className="command-preview-heading">
              <h2>{selected.title}</h2>
              <p>
                {selected.projectTitle} · {AGENTS[selected.agent] ?? selected.agent}
              </p>
              <div className="command-status-controls">
                <StatusBadge status={selected.status} />
                <select
                  aria-label="Set thread status"
                  value={manualStatus}
                  onChange={(event) => {
                    if (rawSelected)
                      setStatus(rawSelected, event.target.value as CommandThreadStatus | "auto");
                  }}
                >
                  <option value="auto">Automatic</option>
                  <option value="idle">Idle</option>
                  <option value="working">Working</option>
                  <option value="attention">Needs attention</option>
                  <option value="review">Ready for review</option>
                  <option value="error">Error</option>
                </select>
              </div>
              {manualStatus !== "auto" && (
                <p className="command-manual-note">Manual status. Resets on new activity.</p>
              )}
            </div>
            <div className="command-preview-body">
              <p className="command-response-time">
                Last response
                {selected.responseAt ? ` · ${relativeTime(selected.responseAt, now)}` : ""}
              </p>
              {selected.response ? (
                <ChatMarkdown text={selected.response} cwd={selected.cwd} />
              ) : (
                <p className="command-muted">No saved response is available yet.</p>
              )}
              {selected.responseTruncated && (
                <p className="command-muted">
                  This response is shortened. Open the thread to read it in full.
                </p>
              )}
            </div>
            <div className="command-preview-reply">
              {replyId === selected.id ? (
                <CommandReply
                  key={selected.id}
                  thread={selected}
                  draft={drafts[selected.id] ?? ""}
                  onDraftChange={(text) =>
                    setDrafts((current) => ({ ...current, [selected.id]: text }))
                  }
                  onSent={() => {
                    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
                  }}
                />
              ) : (
                <button className="command-wake-reply" onClick={() => setReplyId(selected.id)}>
                  Wake and reply
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
      <div className="command-footer">
        <span>
          {visible.length} thread{visible.length === 1 ? "" : "s"}
          {(query.data?.totalThreads ?? 0) > threads.length
            ? ` · Most recent ${threads.length} of ${query.data?.totalThreads}`
            : ""}
        </span>
        <span>Status updates automatically.</span>
      </div>
    </SidebarInset>
  );
}

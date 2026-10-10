import { useQuery } from "@tanstack/react-query";
import type { CommandThread } from "@t3tools/contracts";
import { MessageId } from "@t3tools/contracts";
import { lazy, Suspense, useRef, useState } from "react";
import { ensureNativeApi } from "~/nativeApi";
import { newCommandId } from "~/lib/utils";

const ThreadTerminalCliPane = lazy(() => import("./ThreadTerminalCliPane"));

/** Awake previews attach directly; sleeping previews require Wake and reply first. */
export function CommandReply({
  thread,
  draft,
  onDraftChange,
  onSent,
}: {
  thread: CommandThread;
  draft: string;
  onDraftChange: (text: string) => void;
  onSent: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const submitting = useRef(false);
  const detail = useQuery({
    queryKey: ["command-reply", thread.id],
    queryFn: async () => {
      const snapshot = await ensureNativeApi().orchestration.getSnapshot();
      const result = snapshot.threads.find(
        (item) => item.id === thread.id && !item.deletedAt && !item.archivedAt,
      );
      if (!result) throw new Error("This thread is no longer available.");
      return result;
    },
    staleTime: 0,
    retry: false,
  });

  if (detail.isPending)
    return (
      <p className="command-muted command-reply-message" role="status">
        Loading thread input…
      </p>
    );
  if (detail.isError)
    return (
      <div className="command-reply-message" role="alert">
        <p>{detail.error.message}</p>
        <button onClick={() => void detail.refetch()}>Retry</button>
      </div>
    );
  const session = detail.data;
  if (session.cliKind || session.interactionMode === "terminal-cli") {
    return (
      <div className="command-live-terminal" onKeyDown={(event) => event.stopPropagation()}>
        <Suspense
          fallback={<p className="command-muted command-reply-message">Loading terminal…</p>}
        >
          <ThreadTerminalCliPane
            threadId={thread.id}
            cwd={thread.cwd}
            cliKind={session.cliKind ?? null}
          />
        </Suspense>
      </div>
    );
  }

  const send = async () => {
    if (submitting.current || !draft.trim()) return;
    const text = draft;
    submitting.current = true;
    setSending(true);
    setError(null);
    setSent(false);
    try {
      await ensureNativeApi().orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: thread.id,
        message: {
          messageId: MessageId.makeUnsafe(crypto.randomUUID()),
          role: "user",
          text,
          attachments: [],
        },
        modelSelection: session.modelSelection,
        runtimeMode: session.runtimeMode,
        interactionMode: session.interactionMode,
        createdAt: new Date().toISOString(),
      });
      onDraftChange("");
      setSent(true);
      onSent();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not send the prompt. Your draft is saved here.",
      );
    } finally {
      submitting.current = false;
      setSending(false);
    }
  };

  return (
    <form
      className="command-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label htmlFor="command-prompt">Prompt</label>
      <textarea
        id="command-prompt"
        value={draft}
        disabled={sending}
        placeholder="Send a prompt to this thread…"
        rows={4}
        onChange={(event) => {
          onDraftChange(event.target.value);
          setSent(false);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            event.key === "Enter" &&
            (event.ctrlKey || event.metaKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            void send();
          }
        }}
      />
      {error && <p role="alert">{error}</p>}
      {sent && <p role="status">Prompt sent.</p>}
      <button type="submit" disabled={sending || !draft.trim()}>
        {sending ? "Sending…" : "Send prompt"}
      </button>
    </form>
  );
}

import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import {
  Activity,
  ArrowDown,
  Bell,
  Bot,
  CheckCircle2,
  CircleHelp,
  Command as CommandIcon,
  Image as ImageIcon,
  LoaderCircle,
  Play,
  Send,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import type { PaneAttachment } from "./api";
import type {
  AgentActivity,
  BootstrapPayload,
  MachineStatus,
  PaneState,
  SurfaceTab,
  TerminalNotification,
  TerminalRun,
  Workspace,
} from "./types";
import { imagesFromClipboard } from "./clipboard-images";
import { mobileAgentLaunchCommand, type MobileAgentLauncher } from "./mobile-agent-launch";

interface MobileAgentSurfaceProps {
  state: BootstrapPayload;
  machines: MachineStatus[];
  workspace?: Workspace;
  tab?: SurfaceTab;
  pane?: PaneState;
  onSendInput: (paneId: string, data: string) => Promise<void>;
  onUploadAttachment: (paneId: string, attachment: PaneAttachmentUpload) => Promise<PaneAttachment>;
  onFocusTerminal?: () => void;
  onOpenActions?: () => void;
}

type MobileAgentStatus = "running" | "waiting" | "completed" | "failed" | "updated";
type AgentLauncher = MobileAgentLauncher;

type LocalMobileMessage = {
  kind: "user";
  id: string;
  workspaceId: string;
  paneId: string;
  createdAt: string;
  text: string;
  attachments?: LocalSentAttachment[];
  delivery?: "sending" | "sent";
};

interface PaneAttachmentUpload {
  name: string;
  mimeType: string;
  data: string;
}

interface PendingImageAttachment {
  id: string;
  file: File;
  name: string;
  mimeType: string;
  bytes: number;
  previewUrl: string;
}

interface LocalSentAttachment {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  url: string;
  previewUrl: string;
}

type MobileThreadItem =
  | LocalMobileMessage
  | { kind: "separator"; id: string; createdAt: string; label: string }
  | { kind: "agent"; id: string; createdAt: string; event: AgentActivity }
  | { kind: "run"; id: string; createdAt: string; run: TerminalRun }
  | { kind: "notification"; id: string; createdAt: string; notification: TerminalNotification };

type MobileMessageItem = Exclude<MobileThreadItem, { kind: "separator" }>;
type MobileRecentKind = "Agent" | "Run" | "Notify";

interface MobileRecentItem {
  id: string;
  kind: MobileRecentKind;
  status: MobileAgentStatus;
  title: string;
  createdAt: string;
}

interface AgentSessionSignal {
  canSend: boolean;
  agent?: AgentLauncher | string;
  reason: string;
}

const maxPastedImageBytes = 8 * 1024 * 1024;
const localMessagesStorageKey = "wmux:mobile-agent-messages";

export function MobileAgentSurface({
  state,
  machines,
  workspace,
  tab,
  pane,
  onSendInput,
  onUploadAttachment,
  onFocusTerminal,
  onOpenActions,
}: MobileAgentSurfaceProps) {
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImageAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [sendNotice, setSendNotice] = useState("");
  const [launchingAgent, setLaunchingAgent] = useState<AgentLauncher | null>(null);
  const [trustedAgentLaunch, setTrustedAgentLaunch] = useState<{ paneId: string; agent: AgentLauncher; createdAt: number } | null>(null);
  const [localMessages, setLocalMessages] = useState<LocalMobileMessage[]>(loadLocalMobileMessages);
  const [threadAtBottom, setThreadAtBottom] = useState(true);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const previewUrlsRef = useRef(new Set<string>());
  const stickToBottomRef = useRef(true);
  const preserveBottomDuringResizeRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const composerPaneRef = useRef(pane?.id);

  const machine = workspace ? machines.find((candidate) => candidate.id === workspace.machineId) : undefined;
  const latestPaneAgent = useMemo(() => {
    if (!pane) return undefined;
    return state.agentEvents
      .filter((event) => event.paneId === pane.id)
      .sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))[0];
  }, [pane, state.agentEvents]);
  const latestAgent = latestPaneAgent;
  const localAgentLaunch =
    pane && trustedAgentLaunch?.paneId === pane.id && Date.now() - trustedAgentLaunch.createdAt < 12 * 60 * 60 * 1000
      ? trustedAgentLaunch.agent
      : undefined;
  const agentSession = useMemo(
    () => detectAgentSession(pane, latestPaneAgent, localAgentLaunch),
    [latestPaneAgent, localAgentLaunch, pane],
  );
  const agentRunning = Boolean(latestPaneAgent && isActiveAgentStatus(latestPaneAgent.status));
  const status = latestAgent ? agentStatusClass(latestAgent.status) : pane?.status === "running" ? "running" : "updated";
  const statusLabel = latestAgent ? `${latestAgent.agent} ${latestAgent.status}` : pane?.status ?? "idle";
  const paneIndex = tab && pane ? tab.panes.findIndex((candidate) => candidate.id === pane.id) : -1;
  const paneLabel = paneIndex >= 0 ? `Pane ${paneIndex + 1}` : "Pane";
  const threadItems = useMemo(
    () =>
      workspace
        ? buildMobileThreadItems(workspace.id, pane?.id, state.agentEvents, state.runs, state.notifications, localMessages)
        : [],
    [localMessages, pane?.id, state.agentEvents, state.notifications, state.runs, workspace],
  );
  const threadScrollKey = useMemo(() => threadItems.map(threadItemScrollKey).join("|"), [threadItems]);
  const recentItems = useMemo(
    () => buildRecentActivityItems(state.agentEvents, state.runs, state.notifications, pane?.id).slice(0, 5),
    [pane?.id, state.agentEvents, state.notifications, state.runs],
  );

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const frame = window.requestAnimationFrame(() => {
      if (stickToBottomRef.current) thread.scrollTop = thread.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [threadScrollKey, workspace?.id, pane?.id]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    let frame: number | undefined;
    let releaseFrame: number | undefined;
    const pinAfterResize = () => {
      const bottomGap = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
      if (!stickToBottomRef.current && bottomGap >= 72) return;
      stickToBottomRef.current = true;
      preserveBottomDuringResizeRef.current = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        if (!stickToBottomRef.current) return;
        thread.scrollTop = thread.scrollHeight;
        setThreadAtBottom(true);
        if (releaseFrame !== undefined) window.cancelAnimationFrame(releaseFrame);
        releaseFrame = window.requestAnimationFrame(() => {
          releaseFrame = undefined;
          preserveBottomDuringResizeRef.current = false;
        });
      });
    };
    const observer = new ResizeObserver(pinAfterResize);
    observer.observe(thread);
    window.visualViewport?.addEventListener("resize", pinAfterResize);
    return () => {
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", pinAfterResize);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (releaseFrame !== undefined) window.cancelAnimationFrame(releaseFrame);
      preserveBottomDuringResizeRef.current = false;
    };
  }, [workspace?.id, pane?.id]);

  useEffect(() => {
    stickToBottomRef.current = true;
    setThreadAtBottom(true);
  }, [workspace?.id, pane?.id]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    const minHeight = Number.parseFloat(window.getComputedStyle(composer).minHeight) || 44;
    composer.style.height = "0px";
    composer.style.height = `${draft ? Math.min(132, Math.max(minHeight, composer.scrollHeight)) : minHeight}px`;
  }, [draft]);

  useEffect(
    () => () => {
      for (const previewUrl of previewUrlsRef.current) URL.revokeObjectURL(previewUrl);
      previewUrlsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    saveLocalMobileMessages(localMessages);
  }, [localMessages]);

  useEffect(() => {
    if (composerPaneRef.current === pane?.id) return;
    composerPaneRef.current = pane?.id;
    setDraft("");
    setPendingImages((current) => {
      for (const attachment of current) {
        URL.revokeObjectURL(attachment.previewUrl);
        previewUrlsRef.current.delete(attachment.previewUrl);
      }
      return [];
    });
    setSendError("");
    setSendNotice("");
  }, [pane?.id]);

  const appendPastedImages = (files: File[]) => {
    if (files.length === 0) return;
    const acceptedFiles = files.filter((file) => file.size <= maxPastedImageBytes);
    if (acceptedFiles.length !== files.length) {
      setSendError(`Images must be ${formatBytes(maxPastedImageBytes)} or smaller.`);
      setSendNotice("");
    } else {
      setSendError("");
    }
    if (acceptedFiles.length === 0) return;
    setPendingImages((current) => [
      ...current,
      ...acceptedFiles.map((file, index) => {
        const previewUrl = URL.createObjectURL(file);
        previewUrlsRef.current.add(previewUrl);
        return {
          id: `paste:${Date.now()}:${index}:${Math.random().toString(36).slice(2, 8)}`,
          file,
          name: file.name || `pasted-image-${current.length + index + 1}.${extensionForMimeType(file.type)}`,
          mimeType: file.type || "image/png",
          bytes: file.size,
          previewUrl,
        };
      }),
    ]);
  };

  const removePendingImage = (id: string) => {
    setPendingImages((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
        previewUrlsRef.current.delete(removed.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedImages = imagesFromClipboard(event.clipboardData, isSupportedImageMimeType);
    if (pastedImages.length === 0) return;
    event.preventDefault();
    appendPastedImages(pastedImages);
  };

  const submitDraft = async () => {
    const text = draft.replace(/\s+$/g, "");
    const imagesToSend = pendingImages;
    if (!pane || (!text.trim() && imagesToSend.length === 0) || sending) return;
    if (!agentSession.canSend) {
      setSendError("Start Codex or Claude before sending chat messages to this pane.");
      setSendNotice("");
      return;
    }
    setSending(true);
    setSendError("");
    setSendNotice("");
    stickToBottomRef.current = true;
    setThreadAtBottom(true);
    const submittedAt = new Date().toISOString();
    const localMessageId = `local:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    let optimisticMessageAdded = false;
    try {
      const sentAttachments = await Promise.all(
        imagesToSend.map(async (image) => {
          const uploaded = await onUploadAttachment(pane.id, {
            name: image.name,
            mimeType: image.mimeType,
            data: await fileToBase64(image.file),
          });
          return {
            id: uploaded.id,
            name: uploaded.name,
            mimeType: uploaded.mimeType,
            bytes: uploaded.bytes,
            url: new URL(uploaded.url, window.location.origin).toString(),
            previewUrl: image.previewUrl,
          };
        }),
      );
      setLocalMessages((current) => [
        ...current,
        {
          kind: "user",
          id: localMessageId,
          workspaceId: workspace?.id ?? "",
          paneId: pane.id,
          createdAt: submittedAt,
          text,
          attachments: sentAttachments,
          delivery: "sending",
        },
      ]);
      optimisticMessageAdded = true;
      setDraft("");
      setPendingImages([]);
      await sendMobileComposerInput(onSendInput, pane.id, formatComposerTextInput(text, sentAttachments));
      setLocalMessages((current) =>
        current.map((message) => message.id === localMessageId ? { ...message, delivery: "sent" } : message),
      );
    } catch (error) {
      if (optimisticMessageAdded) {
        setLocalMessages((current) => current.filter((message) => message.id !== localMessageId));
        if (composerPaneRef.current === pane.id) {
          setDraft(text);
          setPendingImages(imagesToSend);
        }
      }
      setSendError(error instanceof Error ? error.message : "Send failed");
    } finally {
      setSending(false);
    }
  };

  const sendInterrupt = async () => {
    if (!pane || !agentRunning || sending) return;
    setSending(true);
    setSendError("");
    setSendNotice("");
    try {
      await onSendInput(pane.id, "\x03");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Interrupt failed");
    } finally {
      setSending(false);
    }
  };

  const startAgent = async (agent: AgentLauncher) => {
    if (!pane || sending || launchingAgent) return;
    setLaunchingAgent(agent);
    setSendError("");
    setSendNotice("");
    try {
      await onSendInput(pane.id, `${mobileAgentLaunchCommand(agent, machine?.kind)}\r`);
      setTrustedAgentLaunch({ paneId: pane.id, agent, createdAt: Date.now() });
      setSendNotice(`Started ${agent} with permission prompts disabled. Wait for its prompt before sending a chat message.`);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : `Could not start ${agent}`);
    } finally {
      setLaunchingAgent(null);
    }
  };

  return (
    <div className="mobile-agent-surface">
      <div className="mobile-agent-thread-shell">
        <div
          ref={threadRef}
          className="mobile-agent-thread"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          onPointerDown={() => {
            userScrollIntentRef.current = true;
          }}
          onTouchStart={() => {
            userScrollIntentRef.current = true;
          }}
          onWheel={() => {
            userScrollIntentRef.current = true;
          }}
          onScroll={(event) => {
            const thread = event.currentTarget;
            const userInitiated = userScrollIntentRef.current;
            userScrollIntentRef.current = false;
            if (preserveBottomDuringResizeRef.current && stickToBottomRef.current && !userInitiated) {
              thread.scrollTop = thread.scrollHeight;
              setThreadAtBottom(true);
              return;
            }
            const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 72;
            stickToBottomRef.current = atBottom;
            setThreadAtBottom(atBottom);
          }}
        >
          {threadItems.length ? (
            threadItems.map((item) =>
              item.kind === "separator" ? (
                <div key={item.id} className="mobile-agent-separator">
                  <span>{item.label}</span>
                </div>
              ) : (
                <MobileThreadMessage key={item.id} item={item} />
              ),
            )
          ) : (
            <MobileAgentEmptyState
              workspace={workspace}
              tab={tab}
              pane={pane}
              machineName={machine?.name ?? workspace?.machineId}
              status={status}
              statusLabel={statusLabel}
              paneLabel={paneLabel}
            />
          )}
          {pane && !agentSession.canSend ? (
            <MobileAgentLaunchPanel
              reason={agentSession.reason}
              sending={sending}
              launchingAgent={launchingAgent}
              error={sendError}
              notice={sendNotice}
              onStart={startAgent}
            />
          ) : null}
        </div>
        {!threadAtBottom ? (
          <button
            type="button"
            className="mobile-agent-jump-latest"
            onClick={() => {
              stickToBottomRef.current = true;
              setThreadAtBottom(true);
              threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
            }}
          >
            <ArrowDown size={14} />
            <span>Latest</span>
          </button>
        ) : null}
      </div>
      <MobileRecentActivity items={recentItems} />
      {agentSession.canSend ? <form
        className="mobile-agent-composer"
        onSubmit={(event) => {
          event.preventDefault();
          composerRef.current?.focus({ preventScroll: true });
          void submitDraft();
        }}
      >
        <span className="mobile-agent-composer-handle" aria-hidden="true" />
        {sendError ? <div className="mobile-agent-error">{sendError}</div> : null}
        {sendNotice ? <div className="mobile-agent-notice">{sendNotice}</div> : null}
        {pendingImages.length ? (
          <div className="mobile-agent-attachments" aria-label="Images to send">
            {pendingImages.map((attachment) => (
              <div key={attachment.id} className="mobile-agent-attachment">
                <img src={attachment.previewUrl} alt={attachment.name} />
                <div>
                  <strong>{attachment.name}</strong>
                  <span>{formatBytes(attachment.bytes)}</span>
                </div>
                <button
                  type="button"
                  title="Remove image"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => removePendingImage(attachment.id)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="mobile-agent-input-row">
          <textarea
            ref={composerRef}
            value={draft}
            aria-label="Agent message"
            placeholder={pane ? `Message ${agentSession.agent ?? "agent"} or paste images` : "No active session"}
            disabled={!pane}
            rows={1}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={handlePaste}
          />
          <button
            type="submit"
            className="mobile-agent-send"
            title={sending ? "Sending" : "Send"}
            aria-label={sending ? "Sending message" : "Send message"}
            disabled={!pane || !agentSession.canSend || (!draft.trim() && pendingImages.length === 0) || sending}
          >
            {sending ? <LoaderCircle className="mobile-agent-send-spinner" size={17} /> : <Send size={16} />}
          </button>
        </div>
        <div className={agentRunning ? "mobile-agent-composer-actions has-stop" : "mobile-agent-composer-actions"}>
          {agentRunning ? (
            <button
              type="button"
              className="mobile-agent-stop"
              title="Interrupt"
              aria-label="Interrupt agent"
              disabled={sending}
              onClick={() => void sendInterrupt()}
            >
              <Square size={14} />
            </button>
          ) : null}
          <button type="button" title="Focus terminal" disabled={!onFocusTerminal} onClick={onFocusTerminal}>
            <TerminalSquare size={15} />
            <span>Focus terminal</span>
          </button>
          <button type="button" title="Actions" disabled={!onOpenActions} onClick={onOpenActions}>
            <CommandIcon size={15} />
            <span>Actions</span>
          </button>
        </div>
      </form> : (
        <div className="mobile-agent-inactive-actions">
          <button type="button" title="Focus terminal" disabled={!onFocusTerminal} onClick={onFocusTerminal}>
            <TerminalSquare size={15} />
            <span>Focus terminal</span>
          </button>
          <button type="button" title="Actions" disabled={!onOpenActions} onClick={onOpenActions}>
            <CommandIcon size={15} />
            <span>Actions</span>
          </button>
        </div>
      )}
    </div>
  );
}

function MobileAgentLaunchPanel({
  reason,
  sending,
  launchingAgent,
  error,
  notice,
  onStart,
}: {
  reason: string;
  sending: boolean;
  launchingAgent: AgentLauncher | null;
  error: string;
  notice: string;
  onStart: (agent: AgentLauncher) => Promise<void>;
}) {
  return (
    <div className="mobile-agent-launch-panel">
      {error ? <div className="mobile-agent-error">{error}</div> : null}
      {notice ? <div className="mobile-agent-notice">{notice}</div> : null}
      <div className="mobile-agent-launch-copy">
        <Bot size={18} />
        <span>
          <strong>No agent detected</strong>
          <small>{reason}</small>
          <small className="mobile-agent-launch-access">Agents start with full access on this private machine.</small>
        </span>
      </div>
      <div className="mobile-agent-launch-actions">
        {(["codex", "claude"] as const).map((agent) => (
          <button
            key={agent}
            type="button"
            disabled={sending || Boolean(launchingAgent)}
            onClick={() => void onStart(agent)}
          >
            <Play size={14} />
            <span>{launchingAgent === agent ? `Starting ${agent === "codex" ? "Codex" : "Claude"}` : `Start ${agent === "codex" ? "Codex" : "Claude"}`}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MobileAgentEmptyState({
  workspace,
  tab,
  pane,
  machineName,
  status,
  statusLabel,
  paneLabel,
}: {
  workspace?: Workspace;
  tab?: SurfaceTab;
  pane?: PaneState;
  machineName?: string;
  status: MobileAgentStatus;
  statusLabel: string;
  paneLabel: string;
}) {
  return (
    <div className="mobile-agent-empty">
      <div className="mobile-agent-session-card">
        <TerminalSquare size={26} />
        <div>
          <strong>{workspace?.name ?? "No workspace"}</strong>
          <span>{[tab?.title, machineName].filter(Boolean).join(" / ")}</span>
          <span>
            <span className={`mobile-agent-inline-status ${status}`} />
            <span className={`mobile-agent-status ${status}`}>{statusLabel}</span>
            {pane ? <span className="mobile-agent-dot">•</span> : null}
            {pane ? <span>{paneLabel}</span> : null}
          </span>
        </div>
      </div>
    </div>
  );
}

function MobileRecentActivity({ items }: { items: MobileRecentItem[] }) {
  if (items.length === 0) return null;
  return (
    <details className="mobile-agent-recent">
      <summary className="mobile-agent-recent-header">
        <span>Recent activity</span>
        <small>{items.length}</small>
      </summary>
      <div className="mobile-agent-recent-list">
        {items.map((item) => (
          <div key={item.id} className={`mobile-agent-recent-card ${item.status}`}>
            <RecentActivityIcon item={item} />
            <span>{item.kind}</span>
            <strong>{item.title}</strong>
            <small>{formatRelativeTime(item.createdAt)}</small>
          </div>
        ))}
      </div>
    </details>
  );
}

function RecentActivityIcon({ item }: { item: MobileRecentItem }) {
  if (item.kind === "Notify") return <Bell size={15} />;
  if (item.status === "waiting") return <CircleHelp size={15} />;
  if (item.kind === "Run" && item.status !== "running") return <CheckCircle2 size={15} />;
  return <Activity size={15} />;
}

function MobileMessageAttachments({ attachments }: { attachments: LocalSentAttachment[] }) {
  return (
    <div className="mobile-agent-message-attachments">
      {attachments.map((attachment) => (
        <a key={attachment.id} className="mobile-agent-message-attachment" href={attachment.url} target="_blank" rel="noreferrer">
          <img src={attachment.previewUrl || attachment.url} alt={attachment.name} />
          <span>
            <ImageIcon size={13} />
            <strong>{attachment.name}</strong>
            <small>{formatBytes(attachment.bytes)}</small>
          </span>
        </a>
      ))}
    </div>
  );
}

function MobileThreadMessage({ item }: { item: MobileMessageItem }) {
  if (item.kind === "user") {
    return (
      <article className="mobile-agent-message user">
        <div className="mobile-agent-message-meta">
          <span>you</span>
          {item.delivery === "sending" ? <span className="mobile-agent-delivery">sending…</span> : null}
          <span>{formatRelativeTime(item.createdAt)}</span>
        </div>
        {item.text ? <MobileMessageText text={item.text} collapsedLimit={1400} /> : null}
        {item.attachments?.length ? <MobileMessageAttachments attachments={item.attachments} /> : null}
      </article>
    );
  }

  if (item.kind === "agent") {
    const status = agentStatusClass(item.event.status);
    const title = item.event.title || item.event.agent;
    const message = agentResponseMessage(item.event);
    const summary = compactText(item.event.summary, 1200);
    const visibleSummary =
      isActiveAgentStatus(item.event.status) || summary.toLowerCase() === `${item.event.agent} ${item.event.status}`.toLowerCase()
        ? ""
        : summary;
    return (
      <article className={`mobile-agent-message agent ${status}`}>
        <div className="mobile-agent-message-meta">
          <span>{item.event.agent}</span>
          <span className={`mobile-agent-status ${status}`}>{item.event.status}</span>
          <span>{formatRelativeTime(item.createdAt)}</span>
        </div>
        <strong className="mobile-agent-message-title">{title}</strong>
        {message ? <MobileMessageText text={message} collapsedLimit={1600} /> : visibleSummary ? <p>{visibleSummary}</p> : null}
      </article>
    );
  }

  if (item.kind === "run") {
    const complete = item.run.status !== "started";
    return (
      <article className={`mobile-agent-message run ${item.run.status}`}>
        <div className="mobile-agent-message-meta">
          <span>run</span>
          <span>{complete ? `exit ${item.run.exitCode ?? "?"}` : "running"}</span>
          <span>{formatRelativeTime(item.createdAt)}</span>
        </div>
        <code>{limitText(item.run.command, 900)}</code>
      </article>
    );
  }

  const body = compactText([item.notification.subtitle, item.notification.body].filter(Boolean).join(" / "), 1000);
  return (
    <article className="mobile-agent-message notification">
      <div className="mobile-agent-message-meta">
        <Bell size={13} />
        <span>{formatRelativeTime(item.createdAt)}</span>
      </div>
      <strong className="mobile-agent-message-title">{item.notification.title}</strong>
      {body ? <p>{body}</p> : null}
    </article>
  );
}

function MobileMessageText({ text, collapsedLimit }: { text: string; collapsedLimit: number }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = text.length > collapsedLimit;
  const visibleText = collapsible && !expanded ? limitText(text, collapsedLimit) : text;
  return (
    <div className="mobile-agent-message-body">
      <p>{linkifyMessageText(visibleText)}</p>
      {collapsible ? (
        <button type="button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "Show less" : "Show full response"}
        </button>
      ) : null}
    </div>
  );
}

const linkifyMessageText = (text: string) =>
  text.split(/(https?:\/\/[^\s<>"']+)/g).map((part, index) => {
    if (!/^https?:\/\//.test(part)) return part;
    const trailing = part.match(/[),.;!?]+$/)?.[0] ?? "";
    const url = trailing ? part.slice(0, -trailing.length) : part;
    return (
      <span key={`${url}:${index}`}>
        <a href={url} target="_blank" rel="noreferrer">{url}</a>
        {trailing}
      </span>
    );
  });

export const buildMobileThreadItems = (
  workspaceId: string,
  paneId: string | undefined,
  agentEvents: AgentActivity[],
  runs: TerminalRun[],
  notifications: TerminalNotification[],
  localMessages: LocalMobileMessage[],
): MobileThreadItem[] => {
  if (!paneId) return [];
  const scopedAgentEvents = collapseAgentLifecycleEvents(
    agentEvents.filter((event) => event.workspaceId === workspaceId && event.paneId === paneId),
  );
  const rawItems: MobileMessageItem[] = [
    ...localMessages.filter((message) => message.workspaceId === workspaceId && message.paneId === paneId),
    ...scopedAgentEvents
      .map((event) => ({ kind: "agent" as const, id: `agent:${event.id}`, createdAt: event.createdAt, event })),
    ...runs
      .filter((run) => run.workspaceId === workspaceId && run.paneId === paneId)
      .map((run) => ({ kind: "run" as const, id: `run:${run.id}`, createdAt: run.completedAt ?? run.startedAt, run })),
    ...notifications
      .filter((notification) => notification.workspaceId === workspaceId && notification.paneId === paneId)
      .map((notification) => ({
        kind: "notification" as const,
        id: `notification:${notification.id}`,
        createdAt: notification.createdAt,
        notification,
      })),
  ].filter(
    (item) =>
      item.kind !== "notification" ||
      !isRedundantAgentNotification(item.notification, scopedAgentEvents),
  );
  const visibleItems = rawItems
    .sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt))
    .slice(-70);
  const groupedItems: MobileThreadItem[] = [];
  let lastGroup = "";
  for (const item of visibleItems) {
    const group = formatDateGroup(item.createdAt);
    if (group !== lastGroup) {
      groupedItems.push({
        kind: "separator",
        id: `separator:${group}:${item.createdAt}`,
        createdAt: item.createdAt,
        label: group,
      });
      lastGroup = group;
    }
    groupedItems.push(item);
  }
  return groupedItems;
};

const collapseAgentLifecycleEvents = (events: AgentActivity[]): AgentActivity[] => {
  const ordered = [...events].sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt));
  return ordered.filter((event, index) => {
    if (!isActiveAgentStatus(event.status)) return true;
    return !ordered.slice(index + 1).some(
      (candidate) =>
        candidate.paneId === event.paneId &&
        candidate.agent === event.agent &&
        (isActiveAgentStatus(candidate.status) || isSettledAgentStatus(candidate.status)),
    );
  });
};

const isRedundantAgentNotification = (
  notification: TerminalNotification,
  agentEvents: AgentActivity[],
): boolean => {
  const notificationText = `${notification.title} ${notification.subtitle} ${notification.body}`.toLowerCase();
  return agentEvents.some((event) => {
    if (event.workspaceId !== notification.workspaceId || event.paneId !== notification.paneId) return false;
    const elapsedMs = Math.abs(Date.parse(notification.createdAt) - Date.parse(event.createdAt));
    if (!Number.isFinite(elapsedMs) || elapsedMs > 15_000) return false;
    return (
      notification.title.toLowerCase() === event.agent.toLowerCase() &&
      notificationText.includes(event.status.toLowerCase())
    );
  });
};

const buildRecentActivityItems = (
  agentEvents: AgentActivity[],
  runs: TerminalRun[],
  notifications: TerminalNotification[],
  paneId?: string,
): MobileRecentItem[] => {
  if (!paneId) return [];
  const items: MobileRecentItem[] = [
    ...agentEvents.filter((event) => event.paneId === paneId).map((event) => ({
      id: `agent:${event.id}`,
      kind: "Agent" as const,
      status: agentStatusClass(event.status),
      title: compactText(event.title || event.summary || `${event.agent} ${event.status}`, 56),
      createdAt: event.createdAt,
    })),
    ...runs.filter((run) => run.paneId === paneId).map((run) => ({
      id: `run:${run.id}`,
      kind: "Run" as const,
      status: run.status === "started" ? "running" as const : run.status === "failed" ? "failed" as const : "completed" as const,
      title: compactText(run.command, 56),
      createdAt: run.completedAt ?? run.startedAt,
    })),
    ...notifications
      .filter((notification) => notification.paneId === paneId && !isRedundantAgentNotification(notification, agentEvents))
      .map((notification) => ({
        id: `notification:${notification.id}`,
        kind: "Notify" as const,
        status: "updated" as const,
        title: compactText(notification.body || notification.subtitle || notification.title, 56),
        createdAt: notification.createdAt,
      })),
  ];
  return items.sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt));
};

const formatDateGroup = (iso: string): string => {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const threadItemScrollKey = (item: MobileThreadItem): string => {
  if (item.kind === "separator") return `${item.id}:${item.label}`;
  if (item.kind === "user") return `${item.id}:${item.delivery ?? "sent"}:${item.text}`;
  if (item.kind === "agent") return `${item.id}:${item.event.status}:${item.event.title}:${item.event.summary}:${item.event.message ?? ""}`;
  if (item.kind === "run") return `${item.id}:${item.run.status}:${item.run.exitCode ?? ""}:${item.run.command}`;
  return `${item.id}:${item.notification.title}:${item.notification.subtitle}:${item.notification.body}`;
};

const detectAgentSession = (
  pane: PaneState | undefined,
  latestPaneAgent: AgentActivity | undefined,
  localAgentLaunch: AgentLauncher | undefined,
): AgentSessionSignal => {
  if (!pane) return { canSend: false, reason: "No active terminal pane is selected." };
  if (localAgentLaunch) {
    return {
      canSend: true,
      agent: localAgentLaunch,
      reason: `${localAgentLaunch} was started from this chat view.`,
    };
  }
  const titleAgent = agentNameFromText(pane.title);
  if (titleAgent) {
    return {
      canSend: true,
      agent: titleAgent,
      reason: `Pane title looks like ${titleAgent}.`,
    };
  }
  if (latestPaneAgent) {
    const ageMs = Date.now() - Date.parse(latestPaneAgent.createdAt);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 12 * 60 * 60 * 1000) {
      return {
        canSend: true,
        agent: latestPaneAgent.agent,
        reason: `${latestPaneAgent.agent} reported ${latestPaneAgent.status} ${formatRelativeTime(latestPaneAgent.createdAt)}.`,
      };
    }
    return {
      canSend: false,
      agent: latestPaneAgent.agent,
      reason: `Last ${latestPaneAgent.agent} signal is stale; start an agent before sending chat text.`,
    };
  }
  return {
    canSend: false,
    reason: "Start Codex or Claude to avoid sending chat text to a normal shell prompt.",
  };
};

const agentNameFromText = (value: string | undefined): AgentLauncher | undefined => {
  const normalized = value?.toLowerCase() ?? "";
  if (/\bcodex\b/.test(normalized)) return "codex";
  if (/\bclaude\b/.test(normalized)) return "claude";
  return undefined;
};

const formatComposerTextInput = (text: string, attachments: LocalSentAttachment[] = []): string => {
  const messageParts: string[] = [];
  const normalizedText = text.replace(/\r\n?/g, "\n");
  if (normalizedText.trim()) messageParts.push(normalizedText);
  if (attachments.length) {
    if (messageParts.length) messageParts.push("");
    messageParts.push(`Attached image${attachments.length === 1 ? "" : "s"}:`);
    for (const attachment of attachments) {
      messageParts.push(`- ${attachment.name} (${attachment.mimeType}, ${formatBytes(attachment.bytes)}): ${attachment.url}`);
    }
  }
  const normalized = messageParts.join("\n");
  return normalized.includes("\n") ? `\x1b[200~${normalized}\x1b[201~` : normalized;
};

export const sendMobileComposerInput = async (
  sendInput: (paneId: string, data: string) => Promise<void>,
  paneId: string,
  message: string,
) => {
  await sendInput(paneId, message);
  await sendInput(paneId, "\r");
};

const isSupportedImageMimeType = (mimeType: string): boolean =>
  mimeType.startsWith("image/") && mimeType.toLowerCase() !== "image/svg+xml";

const extensionForMimeType = (mimeType: string): string => {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/avif") return "avif";
  if (mimeType === "image/heic") return "heic";
  if (mimeType === "image/heif") return "heif";
  return "png";
};

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not read image"));
        return;
      }
      resolve(reader.result.replace(/^data:[^;]+;base64,/, ""));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read image")));
    reader.readAsDataURL(file);
  });

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
};

const agentStatusClass = (status: string): MobileAgentStatus => {
  const normalized = status.toLowerCase();
  if (["failed", "error", "cancelled", "stopped"].includes(normalized)) return "failed";
  if (["completed", "done", "success"].includes(normalized)) return "completed";
  if (normalized === "waiting") return "waiting";
  if (["running", "started", "working"].includes(normalized)) return "running";
  return "updated";
};

const isActiveAgentStatus = (status: string): boolean =>
  ["running", "started", "working", "waiting"].includes(status.toLowerCase());

const isSettledAgentStatus = (status: string): boolean =>
  ["completed", "done", "success", "failed", "error", "cancelled", "stopped", "interrupted"].includes(
    status.toLowerCase(),
  );

export const agentResponseMessage = (event: AgentActivity): string =>
  ["completed", "done", "success"].includes(event.status.toLowerCase()) ? event.message?.trim() ?? "" : "";

const formatRelativeTime = (iso: string): string => {
  const elapsedMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(elapsedMs)) return "";
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const compactText = (value: string | undefined, limit: number): string => limitText(stripMarkdown(value ?? ""), limit);

const limitText = (value: string, limit: number): string => {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
};

const stripMarkdown = (value: string): string =>
  value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[\s>*+-]+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

const loadLocalMobileMessages = (): LocalMobileMessage[] => {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(localMessagesStorageKey) ?? "[]") as LocalMobileMessage[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (message) =>
          message?.kind === "user" &&
          typeof message.id === "string" &&
          typeof message.workspaceId === "string" &&
          typeof message.paneId === "string" &&
          typeof message.createdAt === "string" &&
          typeof message.text === "string",
      )
      .slice(-120)
      .map((message) => ({ ...message, delivery: "sent" }));
  } catch {
    return [];
  }
};

const saveLocalMobileMessages = (messages: LocalMobileMessage[]) => {
  try {
    const serializable = messages.slice(-120).map((message) => ({
      ...message,
      delivery: "sent" as const,
      attachments: message.attachments?.map((attachment) => ({
        ...attachment,
        previewUrl: attachment.url,
      })),
    }));
    window.sessionStorage.setItem(localMessagesStorageKey, JSON.stringify(serializable));
  } catch {
    // Chat remains usable when session storage is unavailable or full.
  }
};

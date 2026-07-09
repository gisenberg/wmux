import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { Activity, Bell, Bot, CheckCircle2, Command as CommandIcon, Image as ImageIcon, MessageSquare, Play, Send, Square, TerminalSquare, X, Zap } from "lucide-react";
import type { PaneAttachment } from "./api";
import { withTokenParam } from "./token";
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

type MobileAgentStatus = "running" | "completed" | "failed" | "updated";
type AgentLauncher = MobileAgentLauncher;

type LocalMobileMessage = {
  kind: "user";
  id: string;
  workspaceId: string;
  paneId: string;
  createdAt: string;
  text: string;
  attachments?: LocalSentAttachment[];
};

type LocalStreamMessage = {
  kind: "stream";
  id: string;
  workspaceId: string;
  paneId: string;
  agent: string;
  createdAt: string;
  updatedAt: string;
  text: string;
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
  | LocalStreamMessage
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
  const [localMessages, setLocalMessages] = useState<LocalMobileMessage[]>([]);
  const [streamMessages, setStreamMessages] = useState<LocalStreamMessage[]>([]);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const previewUrlsRef = useRef(new Set<string>());
  const lastUserSendAtRef = useRef(0);
  const lastUserPromptRef = useRef("");

  const machine = workspace ? machines.find((candidate) => candidate.id === workspace.machineId) : undefined;
  const latestWorkspaceAgent = useMemo(() => {
    if (!workspace) return undefined;
    return state.agentEvents
      .filter((event) => event.workspaceId === workspace.id)
      .sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))[0];
  }, [state.agentEvents, workspace]);
  const latestPaneAgent = useMemo(() => {
    if (!pane) return undefined;
    return state.agentEvents
      .filter((event) => event.paneId === pane.id)
      .sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))[0];
  }, [pane, state.agentEvents]);
  const latestAgent = latestPaneAgent ?? latestWorkspaceAgent;
  const localAgentLaunch =
    pane && trustedAgentLaunch?.paneId === pane.id && Date.now() - trustedAgentLaunch.createdAt < 12 * 60 * 60 * 1000
      ? trustedAgentLaunch.agent
      : undefined;
  const agentSession = useMemo(
    () => detectAgentSession(pane, latestPaneAgent, localAgentLaunch),
    [latestPaneAgent, localAgentLaunch, pane],
  );
  const status = latestAgent ? agentStatusClass(latestAgent.status) : pane?.status === "running" ? "running" : "updated";
  const statusLabel = latestAgent ? `${latestAgent.agent} ${latestAgent.status}` : pane?.status ?? "idle";
  const paneIndex = tab && pane ? tab.panes.findIndex((candidate) => candidate.id === pane.id) : -1;
  const paneLabel = paneIndex >= 0 ? `Pane ${paneIndex + 1}` : "Pane";
  const threadItems = useMemo(
    () =>
      workspace
        ? buildMobileThreadItems(workspace.id, state.agentEvents, state.runs, state.notifications, localMessages, streamMessages)
        : [],
    [localMessages, state.agentEvents, state.notifications, state.runs, streamMessages, workspace],
  );
  const threadScrollKey = useMemo(() => threadItems.map(threadItemScrollKey).join("|"), [threadItems]);
  const recentItems = useMemo(
    () => buildRecentActivityItems(state.agentEvents, state.runs, state.notifications).slice(0, 5),
    [state.agentEvents, state.notifications, state.runs],
  );

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const frame = window.requestAnimationFrame(() => {
      thread.scrollTop = thread.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [threadScrollKey, workspace?.id]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "0px";
    composer.style.height = `${Math.min(132, Math.max(44, composer.scrollHeight))}px`;
  }, [draft]);

  useEffect(
    () => () => {
      for (const previewUrl of previewUrlsRef.current) URL.revokeObjectURL(previewUrl);
      previewUrlsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const paneId = pane?.id;
    const workspaceId = workspace?.id;
    if (!paneId || !workspaceId || !agentSession.canSend) return;
    const agent = String(agentSession.agent ?? "agent");
    const socket = new WebSocket(paneOutputSocketUrl(paneId));
    let pendingOutput = "";
    let flushTimer: number | undefined;

    const flush = () => {
      flushTimer = undefined;
      if (!lastUserSendAtRef.current) {
        pendingOutput = "";
        return;
      }
      const text = sanitizeTerminalOutput(pendingOutput, lastUserPromptRef.current);
      pendingOutput = "";
      if (!text.trim()) return;
      setStreamMessages((current) =>
        appendStreamMessage(current, {
          workspaceId,
          paneId,
          agent,
          text,
          boundaryMs: lastUserSendAtRef.current,
        }),
      );
    };

    const scheduleFlush = (data: string) => {
      pendingOutput += data;
      if (flushTimer !== undefined) return;
      flushTimer = window.setTimeout(flush, 120);
    };

    socket.addEventListener("message", (event) => {
      const message = parsePaneSocketMessage(event.data);
      if (!message || message.paneId !== paneId) return;
      if (message.type === "output" && typeof message.data === "string") scheduleFlush(message.data);
    });

    return () => {
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      socket.close(1000, "mobile chat closed");
    };
  }, [agentSession.agent, agentSession.canSend, pane?.id, workspace?.id]);

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
    const pastedImages = imagesFromClipboard(event.clipboardData);
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
    try {
      lastUserSendAtRef.current = Date.now();
      lastUserPromptRef.current = text.trim();
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
      await onSendInput(pane.id, formatComposerTextInput(text, sentAttachments));
      await onSendInput(pane.id, "\r");
      setLocalMessages((current) => [
        ...current,
        {
          kind: "user",
          id: `local:${Date.now()}:${current.length}`,
          workspaceId: workspace?.id ?? "",
          paneId: pane.id,
          createdAt: new Date().toISOString(),
          text,
          attachments: sentAttachments,
        },
      ]);
      setDraft("");
      setPendingImages([]);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Send failed");
    } finally {
      setSending(false);
    }
  };

  const sendInterrupt = async () => {
    if (!pane || sending) return;
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
      <div ref={threadRef} className="mobile-agent-thread">
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
      </div>
      <MobileRecentActivity items={recentItems} />
      <form
        className="mobile-agent-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submitDraft();
        }}
      >
        <span className="mobile-agent-composer-handle" aria-hidden="true" />
        {sendError ? <div className="mobile-agent-error">{sendError}</div> : null}
        {sendNotice ? <div className="mobile-agent-notice">{sendNotice}</div> : null}
        {pane && !agentSession.canSend ? (
          <div className="mobile-agent-launch-panel">
            <div className="mobile-agent-launch-copy">
              <Bot size={18} />
              <span>
                <strong>No agent detected</strong>
                <small>{agentSession.reason}</small>
                <small className="mobile-agent-launch-access">Agents start with full access on this private machine.</small>
              </span>
            </div>
            <div className="mobile-agent-launch-actions">
              <button
                type="button"
                disabled={sending || Boolean(launchingAgent)}
                onClick={() => void startAgent("codex")}
              >
                <Play size={14} />
                <span>{launchingAgent === "codex" ? "Starting Codex" : "Start Codex"}</span>
              </button>
              <button
                type="button"
                disabled={sending || Boolean(launchingAgent)}
                onClick={() => void startAgent("claude")}
              >
                <Play size={14} />
                <span>{launchingAgent === "claude" ? "Starting Claude" : "Start Claude"}</span>
              </button>
            </div>
          </div>
        ) : null}
        {pendingImages.length ? (
          <div className="mobile-agent-attachments" aria-label="Images to send">
            {pendingImages.map((attachment) => (
              <div key={attachment.id} className="mobile-agent-attachment">
                <img src={attachment.previewUrl} alt={attachment.name} />
                <div>
                  <strong>{attachment.name}</strong>
                  <span>{formatBytes(attachment.bytes)}</span>
                </div>
                <button type="button" title="Remove image" onClick={() => removePendingImage(attachment.id)}>
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
            placeholder={pane ? (agentSession.canSend ? `Message ${agentSession.agent ?? "agent"} or paste images` : "Start an agent before sending") : "No active session"}
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
            title="Send"
            disabled={!pane || !agentSession.canSend || (!draft.trim() && pendingImages.length === 0) || sending}
          >
            <Send size={16} />
          </button>
        </div>
        <div className="mobile-agent-composer-actions">
          <button
            type="button"
            className="mobile-agent-stop"
            title="Interrupt"
            disabled={!pane || sending}
            onClick={() => void sendInterrupt()}
          >
            <Square size={14} />
          </button>
          <button type="button" title="Focus terminal" disabled={!onFocusTerminal} onClick={onFocusTerminal}>
            <TerminalSquare size={15} />
            <span>Focus terminal</span>
          </button>
          <button type="button" title="Actions" disabled={!onOpenActions} onClick={onOpenActions}>
            <CommandIcon size={15} />
            <span>Actions</span>
          </button>
        </div>
      </form>
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
      <div className="mobile-agent-empty-icon">
        <MessageSquare size={34} />
      </div>
      <strong>No agent activity yet</strong>
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
      <div className="mobile-agent-ready">
        <Zap size={17} />
        <span>Ready for input</span>
      </div>
    </div>
  );
}

function MobileRecentActivity({ items }: { items: MobileRecentItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="mobile-agent-recent" aria-label="Recent activity">
      <div className="mobile-agent-recent-header">
        <span>Recent activity</span>
      </div>
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
    </section>
  );
}

function RecentActivityIcon({ item }: { item: MobileRecentItem }) {
  if (item.kind === "Notify") return <Bell size={15} />;
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
          <span>{formatRelativeTime(item.createdAt)}</span>
        </div>
        {item.text ? <p>{limitText(item.text, 1400)}</p> : null}
        {item.attachments?.length ? <MobileMessageAttachments attachments={item.attachments} /> : null}
      </article>
    );
  }

  if (item.kind === "stream") {
    return (
      <article className="mobile-agent-message stream">
        <div className="mobile-agent-message-meta">
          <span>{item.agent}</span>
          <span>streaming</span>
          <span>{formatRelativeTime(item.updatedAt)}</span>
        </div>
        <p>{limitText(item.text.trim(), 6000)}</p>
      </article>
    );
  }

  if (item.kind === "agent") {
    const status = agentStatusClass(item.event.status);
    const title = item.event.title || item.event.agent;
    const summary = compactText(item.event.summary, 1200);
    return (
      <article className={`mobile-agent-message agent ${status}`}>
        <div className="mobile-agent-message-meta">
          <span>{item.event.agent}</span>
          <span className={`mobile-agent-status ${status}`}>{item.event.status}</span>
          <span>{formatRelativeTime(item.createdAt)}</span>
        </div>
        <strong className="mobile-agent-message-title">{title}</strong>
        {summary ? <p>{summary}</p> : null}
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

const buildMobileThreadItems = (
  workspaceId: string,
  agentEvents: AgentActivity[],
  runs: TerminalRun[],
  notifications: TerminalNotification[],
  localMessages: LocalMobileMessage[],
  streamMessages: LocalStreamMessage[],
): MobileThreadItem[] => {
  const rawItems: MobileMessageItem[] = [
    ...localMessages.filter((message) => message.workspaceId === workspaceId),
    ...streamMessages.filter((message) => message.workspaceId === workspaceId && message.text.trim()),
    ...agentEvents
      .filter((event) => event.workspaceId === workspaceId)
      .map((event) => ({ kind: "agent" as const, id: `agent:${event.id}`, createdAt: event.createdAt, event })),
    ...runs
      .filter((run) => run.workspaceId === workspaceId)
      .map((run) => ({ kind: "run" as const, id: `run:${run.id}`, createdAt: run.completedAt ?? run.startedAt, run })),
    ...notifications
      .filter((notification) => notification.workspaceId === workspaceId)
      .map((notification) => ({
        kind: "notification" as const,
        id: `notification:${notification.id}`,
        createdAt: notification.createdAt,
        notification,
      })),
  ].filter(
    (item) =>
      item.kind !== "notification" ||
      !isRedundantAgentNotification(item.notification, agentEvents),
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
): MobileRecentItem[] => {
  const items: MobileRecentItem[] = [
    ...agentEvents.map((event) => ({
      id: `agent:${event.id}`,
      kind: "Agent" as const,
      status: agentStatusClass(event.status),
      title: compactText(event.title || event.summary || `${event.agent} ${event.status}`, 56),
      createdAt: event.createdAt,
    })),
    ...runs.map((run) => ({
      id: `run:${run.id}`,
      kind: "Run" as const,
      status: run.status === "started" ? "running" as const : run.status === "failed" ? "failed" as const : "completed" as const,
      title: compactText(run.command, 56),
      createdAt: run.completedAt ?? run.startedAt,
    })),
    ...notifications
      .filter((notification) => !isRedundantAgentNotification(notification, agentEvents))
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
  if (item.kind === "user") return `${item.id}:${item.text}`;
  if (item.kind === "stream") return `${item.id}:${item.updatedAt}:${item.text}`;
  if (item.kind === "agent") return `${item.id}:${item.event.status}:${item.event.title}:${item.event.summary}`;
  if (item.kind === "run") return `${item.id}:${item.run.status}:${item.run.exitCode ?? ""}:${item.run.command}`;
  return `${item.id}:${item.notification.title}:${item.notification.subtitle}:${item.notification.body}`;
};

const paneOutputSocketUrl = (paneId: string): string => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return withTokenParam(`${protocol}//${window.location.host}/ws/panes/${encodeURIComponent(paneId)}/output`);
};

const parsePaneSocketMessage = (raw: unknown): { type?: string; paneId?: string; data?: string } | null => {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; paneId?: unknown; data?: unknown };
    return {
      type: typeof parsed.type === "string" ? parsed.type : undefined,
      paneId: typeof parsed.paneId === "string" ? parsed.paneId : undefined,
      data: typeof parsed.data === "string" ? parsed.data : undefined,
    };
  } catch {
    return null;
  }
};

const appendStreamMessage = (
  current: LocalStreamMessage[],
  input: { workspaceId: string; paneId: string; agent: string; text: string; boundaryMs: number },
): LocalStreamMessage[] => {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const last = current.at(-1);
  const canAppend =
    last?.paneId === input.paneId &&
    Date.parse(last.createdAt) >= input.boundaryMs &&
    nowMs - Date.parse(last.updatedAt) < 2500;
  if (last && canAppend) {
    return [
      ...current.slice(0, -1),
      {
        ...last,
        updatedAt: now,
        text: trimStreamText(`${last.text}${input.text}`),
      },
    ];
  }
  return [
    ...current,
    {
      kind: "stream" as const,
      id: `stream:${nowMs}:${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: input.workspaceId,
      paneId: input.paneId,
      agent: input.agent,
      createdAt: now,
      updatedAt: now,
      text: trimStreamText(input.text),
    },
  ].slice(-40);
};

const sanitizeTerminalOutput = (data: string, latestPrompt = ""): string =>
  filterAgentStreamText(
    normalizeStreamWhitespace(stripBackspaces(stripTerminalControls(data))),
    latestPrompt,
  );

const stripTerminalControls = (data: string): string =>
  data
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

const stripBackspaces = (value: string): string => {
  const chars: string[] = [];
  for (const char of value) {
    if (char === "\b") {
      chars.pop();
    } else {
      chars.push(char);
    }
  }
  return chars.join("");
};

const normalizeStreamWhitespace = (value: string): string =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n");

const filterAgentStreamText = (value: string, latestPrompt: string): string => {
  const promptLines = promptComparableLines(latestPrompt);
  const filteredLines: string[] = [];
  for (const rawLine of value.split("\n")) {
    const line = cleanStreamLine(rawLine);
    const trimmed = line.trim();
    if (!trimmed) {
      if (filteredLines.length && filteredLines.at(-1) !== "") filteredLines.push("");
      continue;
    }
    if (isPromptEchoLine(trimmed, promptLines) || isAgentTerminalChromeLine(trimmed)) continue;
    filteredLines.push(line);
  }
  return normalizeStreamWhitespace(filteredLines.join("\n")).trimStart();
};

const cleanStreamLine = (line: string): string =>
  line
    .replace(/^[\s│┃▌▐║]+/, "")
    .replace(/[\s│┃▌▐║]+$/, "")
    .replace(/[ \t]{2,}/g, " ");

const promptComparableLines = (prompt: string): Set<string> =>
  new Set(
    prompt
      .split(/\n+/)
      .map(comparableStreamText)
      .filter((line) => line.length >= 8),
  );

const isPromptEchoLine = (line: string, promptLines: Set<string>): boolean => {
  const comparable = comparableStreamText(line);
  if (comparable.length < 8) return false;
  if (promptLines.has(comparable)) return true;
  for (const promptLine of promptLines) {
    if (promptLine.length >= 18 && promptLine.includes(comparable)) return true;
    if (comparable.length >= 18 && comparable.includes(promptLine)) return true;
  }
  return false;
};

const comparableStreamText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const isAgentTerminalChromeLine = (line: string): boolean => {
  const compact = line.trim();
  const lower = compact.toLowerCase();
  if (!compact) return true;
  if (/^[+\-=_~*# .·•●○◦|/\\[\]:;]+$/.test(compact)) return true;
  if (/^[╭╮╰╯┌┐└┘├┤┬┴┼─━═│┃║╔╗╚╝╠╣╦╩╬\s]+$/.test(compact)) return true;
  if (/^[⠁⠂⠄⡀⢀⣀⣄⣆⣇⣧⣷⣿⡿⠿⢿⠟⠻⠽⠾⠶⠦⠤⠠⠐⠈.\s-]+$/.test(compact)) return true;
  if (/^(working|thinking|reading|searching|checking|editing|running|loading|streaming)\b[ .·•●○◦-]*$/i.test(compact)) return true;
  if (/^(esc|enter|tab|ctrl|control|cmd|command|shift|option|alt)\b.*\b(interrupt|cancel|send|submit|navigate|close|exit|stop|continue)\b/i.test(compact)) return true;
  if (/\b(esc|ctrl|control|cmd|command)\s*[+ -]?\s*[a-z0-9]\b.*\b(interrupt|cancel|quit|stop|send)\b/i.test(compact)) return true;
  if (/^(model|provider|approval|sandbox|cwd|workdir|directory|session|tokens?|context|reasoning|effort|network|mode|account)\s*[:=]/i.test(compact)) return true;
  if (/^[-*•]\s*(model|provider|approval|sandbox|cwd|workdir|directory|session|tokens?|context|reasoning|effort|network|mode|account)\b/i.test(compact)) return true;
  if (/^(codex|claude)\s*(>|$)/i.test(compact)) return true;
  if (/^(ps\s+)?[a-z]:\\.*[>»]$/i.test(compact)) return true;
  if (/^[$#>]\s*$/.test(compact)) return true;
  if (/^\[[^\]]{1,24}\]\s*$/.test(compact)) return true;
  if (lower.includes("tokens used") || lower.includes("context left")) return true;
  if (lower.includes("press enter to") || lower.includes("shift+tab to") || lower.includes("ctrl+c")) return true;
  return false;
};

const trimStreamText = (value: string): string => {
  const limit = 12_000;
  return value.length > limit ? value.slice(-limit) : value;
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

const imagesFromClipboard = (clipboardData: DataTransfer): File[] => {
  const files: File[] = [];
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && isSupportedImageMimeType(file.type || item.type)) files.push(file);
  }
  if (files.length) return files;
  return Array.from(clipboardData.files ?? []).filter((file) => isSupportedImageMimeType(file.type));
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
  if (["running", "started", "working"].includes(normalized)) return "running";
  return "updated";
};

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

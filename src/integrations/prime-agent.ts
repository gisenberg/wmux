import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { closeSync, openSync, readSync, watch } from "node:fs"
import { readFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

const eventScript = "__WMUX_EVENT_SCRIPT__"
const titleScript = "__WMUX_TITLE_SCRIPT__"
const sessionDepth = (ctx: any): number | undefined => {
  try {
    const rawDepth = ctx?.sessionManager?.getHeader?.()?.rlmDepth
    if (rawDepth === undefined || rawDepth === null) return 0
    const depth = Number(rawDepth)
    return Number.isSafeInteger(depth) && depth >= 0 ? depth : undefined
  } catch {
    return undefined
  }
}
const sessionKey = (ctx: any): string | undefined => {
  try {
    const value = ctx?.sessionManager?.getSessionId?.()
      ?? ctx?.sessionManager?.getHeader?.()?.id
    return typeof value === "string" && value.length > 0 && value.length <= 256
      ? value
      : undefined
  } catch {
    return undefined
  }
}

type WmuxIdentity = Readonly<{ workspaceId: string; tabId: string; paneId: string }>
type ClientBinding = Readonly<{
  generation: number
  identity: WmuxIdentity
  sessionId: string
  familyId: string
}>
type TurnBinding = Readonly<ClientBinding & { runId: string; prompt: string }>
type ClientActivation =
  | { accepted: true; binding: ClientBinding; changed: boolean; context: ValidatedContext }
  | { accepted: false; reason: "invalid" | "stale" | "conflict" | "unbound" | "absent" }
type SharedClientBinding = {
  highWaterGeneration: number
  identity: WmuxIdentity
  retired?: boolean
}
type ClientBindingRegistry = {
  entries: Map<string, SharedClientBinding>
  retired: Uint8Array
}
type ValidatedContext = {
  sessionId: string
  familyId: string
  depth: number
}
type CallbackContextSnapshot = {
  header: Record<string, unknown>
  managerId: unknown
  sessionFile?: unknown
  clientContext?: unknown
  modern: boolean
}
type PendingTerminal = { input: Record<string, unknown>; binding: TurnBinding }
type PendingRetryFailure = {
  depth: number
  binding: TurnBinding
  terminal: PendingTerminal
  timer?: ReturnType<typeof setTimeout>
}
type LateRetryFailure = {
  depth: number
  binding: TurnBinding
  terminalSent: boolean
  timer?: ReturnType<typeof setTimeout>
}
type SharedPaneActivity = {
  root?: { sessionKey: string; binding: TurnBinding }
  descendants: Map<string, TurnBinding>
  pendingRootTerminal?: PendingTerminal
  syntheticDescendantTurn?: TurnBinding
  pendingQuestions: Map<string, string>
  retryFailures: Map<string, PendingRetryFailure>
  lateRetryFailures: Map<string, LateRetryFailure>
  heartbeatSessions: Map<string, { generation: string; active: boolean }>
  publishedHeartbeatActive?: boolean
  sendQueue: Promise<void>
}
const identityPattern = {
  workspaceId: /^ws_[0-9a-f]{8,64}$/,
  tabId: /^tab_[0-9a-f]{8,64}$/,
  paneId: /^pane_[0-9a-f]{8,64}$/,
} as const
const freezeIdentity = (identity: WmuxIdentity): WmuxIdentity => Object.freeze({
  workspaceId: identity.workspaceId,
  tabId: identity.tabId,
  paneId: identity.paneId,
})
const validatedIdentity = (value: unknown): WmuxIdentity | undefined => {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Record<string, unknown>
  const identity = {
    workspaceId: candidate.workspaceId,
    tabId: candidate.tabId,
    paneId: candidate.paneId,
  }
  if (!Object.entries(identity).every(([key, field]) =>
    typeof field === "string" && identityPattern[key as keyof WmuxIdentity].test(field)
  )) return undefined
  return freezeIdentity(identity as WmuxIdentity)
}
const identityTupleFromEnvironment = (prefix: "HERDR" | "WMUX", environment = process.env) => {
  const raw = {
    workspaceId: environment[prefix + "_WORKSPACE_ID"],
    tabId: environment[prefix + "_TAB_ID"],
    paneId: environment[prefix + "_PANE_ID"],
  }
  const present = Object.values(raw).some((value) => value !== undefined)
  return { present, identity: validatedIdentity(raw) } as const
}
const identityFromEnvironment = (): WmuxIdentity | undefined => {
  const herdr = identityTupleFromEnvironment("HERDR")
  // Older Prime versions scope this allowlisted client environment around the
  // extension load. This capture is only their compatibility fallback.
  if (process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER === "1" || herdr.present) return herdr.identity
  return identityTupleFromEnvironment("WMUX").identity
}
const boundIdentity = identityFromEnvironment()
const sessionIdValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined
const boundedSessionHeader = (file: string): Record<string, unknown> | undefined => {
  let descriptor: number | undefined
  try {
    descriptor = openSync(file, "r")
    const buffer = Buffer.alloc(65_536)
    const length = readSync(descriptor, buffer, 0, buffer.length, 0)
    const newline = buffer.subarray(0, length).indexOf(10)
    if (newline < 0) return undefined
    const parsed = JSON.parse(buffer.subarray(0, newline).toString("utf8"))
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor) } catch {}
  }
}
const callbackContextSnapshot = (ctx: any): CallbackContextSnapshot | undefined => {
  try {
    const manager = ctx?.sessionManager
    const rawHeader = manager?.getHeader?.()
    if (!rawHeader || typeof rawHeader !== "object") return undefined
    const modern = typeof ctx?.getSessionClientContext === "function"
    return Object.freeze({
      header: Object.freeze({ ...(rawHeader as Record<string, unknown>) }),
      managerId: manager.getSessionId?.(),
      sessionFile: modern ? manager.getSessionFile?.() : undefined,
      clientContext: modern ? ctx.getSessionClientContext() : undefined,
      modern,
    })
  } catch {
    return undefined
  }
}
const validatedContext = (snapshot: CallbackContextSnapshot): ValidatedContext | undefined => {
  try {
    const { header, managerId: rawManagerId, sessionFile, modern } = snapshot
    if (modern && header.type !== "session") return undefined
    const managerId = sessionIdValue(rawManagerId)
    const headerId = sessionIdValue(header.id)
    const sessionId = managerId ?? headerId
    if (!sessionId || (managerId && headerId && managerId !== headerId)) return undefined
    const rawDepth = header.rlmDepth
    const depth = rawDepth === undefined || rawDepth === null ? 0 : rawDepth
    if (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0) return undefined
    if (!modern) return { sessionId, familyId: "legacy:" + boundIdentity?.paneId, depth }
    if (depth === 0) return { sessionId, familyId: sessionId, depth }
    if (typeof sessionFile !== "string" || !sessionFile || typeof header.parentSession !== "string" || !header.parentSession) {
      return undefined
    }
    let currentFile = sessionFile
    let parentReference = header.parentSession
    const visited = new Set<string>()
    for (let expectedDepth = depth - 1; expectedDepth >= 0; expectedDepth -= 1) {
      const parentFile = isAbsolute(parentReference)
        ? resolve(parentReference)
        : resolve(dirname(currentFile), parentReference)
      if (visited.has(parentFile)) return undefined
      visited.add(parentFile)
      const parentHeader = boundedSessionHeader(parentFile)
      if (!parentHeader || parentHeader.type !== "session") return undefined
      const parentId = sessionIdValue(parentHeader.id)
      if (!parentId) return undefined
      const parentDepth = parentHeader.rlmDepth === undefined || parentHeader.rlmDepth === null
        ? 0
        : parentHeader.rlmDepth
      if (!Number.isSafeInteger(parentDepth) || parentDepth !== expectedDepth) return undefined
      if (expectedDepth === 0) return { sessionId, familyId: parentId, depth }
      if (typeof parentHeader.parentSession !== "string" || !parentHeader.parentSession) return undefined
      currentFile = parentFile
      parentReference = parentHeader.parentSession
    }
    return undefined
  } catch {
    return undefined
  }
}
const makeClientBinding = (
  generation: number,
  identity: WmuxIdentity,
  context: ValidatedContext,
): ClientBinding => Object.freeze({
  generation,
  identity: freezeIdentity(identity),
  sessionId: context.sessionId,
  familyId: context.familyId,
})
const makeTurnBinding = (binding: ClientBinding, runId: string, prompt: string): TurnBinding => Object.freeze({
  generation: binding.generation,
  identity: freezeIdentity(binding.identity),
  sessionId: binding.sessionId,
  familyId: binding.familyId,
  runId,
  prompt,
})
const clientBindingRegistrySymbol = Symbol.for("wmux.prime-agent.client-bindings.v2")
const CLIENT_BINDING_REGISTRY_LIMIT = 1_024
const CLIENT_BINDING_RETIRED_BYTES = 8_192
const sharedClientBindingRegistry = (
  (globalThis as any)[clientBindingRegistrySymbol]
  ?? ((globalThis as any)[clientBindingRegistrySymbol] = {
    entries: new Map<string, SharedClientBinding>(),
    retired: new Uint8Array(CLIENT_BINDING_RETIRED_BYTES),
  })
) as ClientBindingRegistry
const sharedClientBindings = sharedClientBindingRegistry.entries
const retiredFamilyIndexes = (familyId: string) => {
  let first = 2_166_136_261
  let second = 5381
  for (let index = 0; index < familyId.length; index += 1) {
    const code = familyId.charCodeAt(index)
    first = Math.imul(first ^ code, 16_777_619) >>> 0
    second = (Math.imul(second, 33) ^ code) >>> 0
  }
  const bits = CLIENT_BINDING_RETIRED_BYTES * 8
  return [first % bits, second % bits, (first + second) % bits, (first + Math.imul(second, 3)) % bits]
}
const rememberRetiredFamily = (familyId: string) => {
  for (const bit of retiredFamilyIndexes(familyId)) {
    sharedClientBindingRegistry.retired[bit >>> 3] |= 1 << (bit & 7)
  }
}
const possiblyRetiredFamily = (familyId: string) => retiredFamilyIndexes(familyId).every((bit) =>
  (sharedClientBindingRegistry.retired[bit >>> 3] & (1 << (bit & 7))) !== 0
)
const touchSharedClientBinding = (familyId: string, value: SharedClientBinding) => {
  sharedClientBindings.delete(familyId)
  sharedClientBindings.set(familyId, value)
  while (sharedClientBindings.size > CLIENT_BINDING_REGISTRY_LIMIT) {
    const oldest = sharedClientBindings.keys().next().value as string | undefined
    if (!oldest) break
    sharedClientBindings.delete(oldest)
    rememberRetiredFamily(oldest)
  }
}
const sessionClientBinding = (snapshot: CallbackContextSnapshot, context: ValidatedContext): ClientBinding | undefined | null => {
  if (!snapshot.modern) return undefined
  try {
    const rawValue = snapshot.clientContext
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return null
    const value = rawValue as Record<string, unknown>
    if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation <= 0) return null
    const env = value.env
    if (!env || typeof env !== "object" || Array.isArray(env)) return null
    if (!Object.values(env).every((entry) => typeof entry === "string")) return null
    // Only the complete forwarded HERDR tuple is authority in a resumed daemon
    // session. HERDR_ENV, sockets, and ambient WMUX values are deliberately ignored.
    const herdr = identityTupleFromEnvironment("HERDR", env as Record<string, string>)
    return herdr.identity ? makeClientBinding(value.generation, herdr.identity, context) : null
  } catch {
    return null
  }
}

const sameIdentity = (left: WmuxIdentity | undefined, right: WmuxIdentity | undefined) => Boolean(left && right
  && left.workspaceId === right.workspaceId
  && left.tabId === right.tabId
  && left.paneId === right.paneId)
const sameClientAuthority = (left: ClientBinding | undefined, right: ClientBinding | undefined) => Boolean(left && right
  && left.generation === right.generation
  && left.familyId === right.familyId
  && sameIdentity(left.identity, right.identity))
const sameClientBinding = (left: ClientBinding | undefined, right: ClientBinding | undefined) => Boolean(
  sameClientAuthority(left, right) && left?.sessionId === right?.sessionId
)

// Prime classifies provider retries only after extension agent_end. Cover its
// default 2/4/8s backoff; an agent_start after this grace gets a fresh run.
const retryFailureGraceMs = (() => {
  const parsed = Number.parseInt(process.env.WMUX_PRIME_RETRY_GRACE_MS ?? "", 10)
  return Number.isFinite(parsed) && parsed >= 50 && parsed <= 120_000 ? parsed : 15_000
})()
const lateRetryRecoveryMs = (() => {
  const parsed = Number.parseInt(process.env.WMUX_PRIME_LATE_RETRY_WINDOW_MS ?? "", 10)
  return Number.isFinite(parsed) && parsed >= 50 && parsed <= 600_000 ? parsed : 120_000
})()
const idleReconcileGraceMs = (() => {
  const parsed = Number.parseInt(process.env.WMUX_PRIME_IDLE_RECONCILE_MS ?? "", 10)
  return Number.isFinite(parsed) && parsed >= 50 && parsed <= 120_000 ? parsed : 2_000
})()
const titleReconcileIntervalMs = (() => {
  const parsed = Number.parseInt(process.env.WMUX_PRIME_TITLE_SYNC_INTERVAL_MS ?? "", 10)
  return Number.isFinite(parsed) && parsed >= 50 && parsed <= 60_000 ? parsed : 1_000
})()
const toolEnvironment = (binding: TurnBinding | undefined) => binding ? {
  WMUX_WORKSPACE_ID: binding.identity.workspaceId,
  WMUX_TAB_ID: binding.identity.tabId,
  WMUX_PANE_ID: binding.identity.paneId,
  HERDR_WORKSPACE_ID: binding.identity.workspaceId,
  HERDR_TAB_ID: binding.identity.tabId,
  HERDR_PANE_ID: binding.identity.paneId,
} : undefined
const skipPythonHeaderLines = (code: string, start: number): number => {
  const trivia = code.slice(start).match(/^(?:[ \t]*(?:#.*)?\r?\n)*/)?.[0] ?? ""
  return start + trivia.length
}
const skipPythonParenthesizedTrivia = (code: string, start: number): number => {
  let cursor = start
  while (cursor < code.length) {
    if (/\s/.test(code[cursor])) {
      cursor += 1
      continue
    }
    if (code[cursor] !== "#") break
    const newline = code.indexOf("\n", cursor)
    cursor = newline < 0 ? code.length : newline + 1
  }
  return cursor
}
const scanPythonString = (code: string, start: number): number | undefined => {
  const opening = code.slice(start).match(/^(?:[rRuUbBfF]{0,2})(\"\"\"|'''|\"|')/)
  if (!opening) return undefined
  const quote = opening[1]
  const triple = quote.length === 3
  let cursor = start + opening[0].length
  while (cursor < code.length) {
    if (code.startsWith(quote, cursor)) return cursor + quote.length
    if (code[cursor] === "\\") {
      cursor += Math.min(2, code.length - cursor)
      continue
    }
    if (!triple && (code[cursor] === "\n" || code[cursor] === "\r")) return undefined
    cursor += 1
  }
  return undefined
}
const scanPythonDocstring = (code: string, start: number): number | undefined => {
  let cursor = start
  let parentheses = 0
  while (code[cursor] === "(") {
    parentheses += 1
    cursor = skipPythonParenthesizedTrivia(code, cursor + 1)
  }
  let sawString = false
  while (true) {
    const end = scanPythonString(code, cursor)
    if (end === undefined) break
    sawString = true
    cursor = end
    if (parentheses > 0) cursor = skipPythonParenthesizedTrivia(code, cursor)
    else {
      const lineJoin = code.slice(cursor).match(/^[ \t]*\\\r?\n[ \t]*/)?.[0]
      cursor += lineJoin?.length ?? (code.slice(cursor).match(/^[ \t]*/)?.[0].length ?? 0)
    }
    if (scanPythonString(code, cursor) !== undefined) continue
    while (parentheses > 0 && code[cursor] === ")") {
      parentheses -= 1
      cursor += 1
      if (parentheses > 0) cursor = skipPythonParenthesizedTrivia(code, cursor)
    }
    break
  }
  if (!sawString || parentheses !== 0) return undefined
  const lineEnd = code.slice(cursor).match(/^[ \t]*(?:#.*)?(?:\r?\n|$)/)?.[0]
  if (lineEnd === undefined) return undefined
  return cursor + lineEnd.length
}
const futureImportInsertionIndex = (code: string): number => {
  let cursor = skipPythonHeaderLines(code, 0)
  const docstringEnd = scanPythonDocstring(code, cursor)
  if (docstringEnd !== undefined) cursor = skipPythonHeaderLines(code, docstringEnd)
  let insertion = cursor
  while (/^from[ \t]+__future__[ \t]+import\b/.test(code.slice(cursor))) {
    let depth = 0
    while (cursor < code.length) {
      const newline = code.indexOf("\n", cursor)
      const end = newline < 0 ? code.length : newline + 1
      const syntax = code.slice(cursor, newline < 0 ? code.length : newline).split("#", 1)[0]
      depth += (syntax.match(/\(/g) ?? []).length - (syntax.match(/\)/g) ?? []).length
      cursor = end
      if (depth <= 0 && !/\\[ \t\r]*$/.test(syntax)) break
    }
    cursor = skipPythonHeaderLines(code, cursor)
    insertion = cursor
  }
  return insertion
}
const toolIdentityKeys = [
  "WMUX_WORKSPACE_ID", "WMUX_TAB_ID", "WMUX_PANE_ID",
  "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID",
] as const
const bindIpythonEnvironment = (code: string, binding: TurnBinding | undefined, clear = false): string => {
  const environmentForTurn = toolEnvironment(binding)
  if (!environmentForTurn && !clear) return code
  const shellCell = code.match(/^(\s*%%(?:bash|sh)[^\n]*\n)/)
  if (shellCell) {
    const environment = environmentForTurn
      ? Object.entries(environmentForTurn).map(([key, value]) => "export " + key + "='" + value + "'").join("\n")
      : "unset " + toolIdentityKeys.join(" ")
    return shellCell[1] + environment + "\n" + code.slice(shellCell[1].length)
  }
  // These standard IPython cell magics still execute a Python body. Keep the
  // magic first, then repair the persistent kernel environment inside it.
  const pythonCell = code.match(/^(\s*%%(?:capture|prun|time|timeit)\b[^\n]*\n)/)
  if (/^\s*%%/.test(code) && !pythonCell) return code
  const prelude = environmentForTurn
    ? "import os as __wmux_os\n__wmux_os.environ.update(" + JSON.stringify(environmentForTurn) + ")\n"
    : "import os as __wmux_os\nfor __wmux_key in " + JSON.stringify(toolIdentityKeys) + ": __wmux_os.environ.pop(__wmux_key, None)\n"
  const header = pythonCell?.[1] ?? ""
  const body = code.slice(header.length)
  const insertion = futureImportInsertionIndex(body)
  const separator = insertion > 0 && body[insertion - 1] !== "\n" ? "\n" : ""
  return header + body.slice(0, insertion) + separator + prelude + body.slice(insertion)
}

const sendNow = (input: Record<string, unknown>, binding: TurnBinding) => new Promise<void>((resolve) => {
  const child = spawn(eventScript, [
    "--agent", "prime-agent", "--prime-agent-hook",
    "--workspace", binding.identity.workspaceId,
    "--tab", binding.identity.tabId,
    "--pane", binding.identity.paneId,
    "--run-id", binding.runId,
  ], {
    stdio: ["pipe", "ignore", "ignore"],
  })
  child.once("error", () => resolve())
  child.once("close", () => resolve())
  child.stdin.once("error", () => resolve())
  child.stdin.end(JSON.stringify(input))
})
const sendHeartbeatStateNow = (identity: WmuxIdentity, active: boolean) => new Promise<void>((resolve) => {
  const child = spawn(eventScript, [
    "--agent", "prime-agent", "--prime-agent-hook",
    "--workspace", identity.workspaceId,
    "--tab", identity.tabId,
    "--pane", identity.paneId,
  ], {
    stdio: ["pipe", "ignore", "ignore"],
  })
  child.once("error", () => resolve())
  child.once("close", () => resolve())
  child.stdin.once("error", () => resolve())
  child.stdin.end(JSON.stringify({
    hook_event_name: active ? "HeartbeatScheduled" : "HeartbeatCleared",
  }))
})
const publishAutoTitleNow = (title: string, binding: TurnBinding) => new Promise<boolean>((resolve) => {
  const child = spawn(titleScript, [
    "--workspace", binding.identity.workspaceId,
    "--tab", binding.identity.tabId,
    "--pane", binding.identity.paneId,
    "--tab-always",
    "--title", title,
  ], {
    stdio: ["ignore", "ignore", "ignore"],
  })
  let settled = false
  const finish = (published: boolean) => {
    if (settled) return
    settled = true
    resolve(published)
  }
  child.once("error", () => finish(false))
  child.once("close", (code) => finish(code === 0))
})

const sharedActivitySymbol = Symbol.for("wmux.prime-agent.pane-activity.v1")
const sharedActivities = (
  (globalThis as any)[sharedActivitySymbol]
  ?? ((globalThis as any)[sharedActivitySymbol] = new Map<string, SharedPaneActivity>())
) as Map<string, SharedPaneActivity>
const activityKey = (binding: ClientBinding) =>
  JSON.stringify([binding.familyId, binding.generation, binding.identity.paneId])
const bindingRegistry = (binding: ClientBinding) =>
  binding.generation > 0 ? sharedClientBindings.get(binding.familyId) : undefined
// Registry entries retain one high-water generation. Evicted families enter a
// fixed-size Bloom tombstone and stay fail-closed until process restart, even if
// they were still live. False positives after extreme churn also fail closed;
// there are no false negatives which could resurrect a stale generation.
const activityRetired = (binding: ClientBinding) => {
  if (binding.generation === 0) return false
  const current = bindingRegistry(binding)
  if (!current) return possiblyRetiredFamily(binding.familyId)
  return current.retired === true || current.highWaterGeneration !== binding.generation || !sameIdentity(current.identity, binding.identity)
}
const activityFor = (binding: ClientBinding): SharedPaneActivity => {
  const key = activityKey(binding)
  const existing = sharedActivities.get(key)
  if (existing) {
    existing.pendingQuestions ??= new Map()
    existing.retryFailures ??= new Map()
    existing.lateRetryFailures ??= new Map()
    existing.heartbeatSessions ??= new Map()
    return existing
  }
  const created: SharedPaneActivity = {
    descendants: new Map(),
    pendingQuestions: new Map(),
    retryFailures: new Map(),
    lateRetryFailures: new Map(),
    heartbeatSessions: new Map(),
    sendQueue: Promise.resolve(),
  }
  sharedActivities.set(key, created)
  return created
}
const send = (input: Record<string, unknown>, binding: TurnBinding) => {
  if (activityRetired(binding)) return Promise.resolve()
  const activity = activityFor(binding)
  const heartbeatActive = [...activity.heartbeatSessions.values()].some((member) => member.active)
  activity.sendQueue = activity.sendQueue
    .then(() => activityRetired(binding) ? undefined : sendNow({ ...input, wmux_heartbeat_active: heartbeatActive }, binding))
    .catch(() => {})
  return activity.sendQueue
}
const publishHeartbeatAggregate = (
  binding: ClientBinding,
  activity: SharedPaneActivity,
  force = false,
) => {
  const active = [...activity.heartbeatSessions.values()].some((member) => member.active)
  if (activity.publishedHeartbeatActive === undefined) {
    activity.publishedHeartbeatActive = active
    if (!force && !active) return activity.sendQueue
  } else {
    if (activity.publishedHeartbeatActive === active) return activity.sendQueue
    activity.publishedHeartbeatActive = active
  }
  activity.sendQueue = activity.sendQueue
    .then(() => activityRetired(binding) ? undefined : sendHeartbeatStateNow(binding.identity, active))
    .catch(() => {})
  return activity.sendQueue
}
const publishAutoTitle = (title: string, binding: TurnBinding) => {
  const activity = activityFor(binding)
  const result = activity.sendQueue
    .then(() => activityRetired(binding) ? false : publishAutoTitleNow(title, binding))
    .catch(() => false)
  activity.sendQueue = result.then(() => {})
  return result
}
const cleanupActivity = async (binding: ClientBinding, activity: SharedPaneActivity) => {
  while (true) {
    const queued = activity.sendQueue
    await queued
    if (activity.sendQueue !== queued) continue
    if (
      sharedActivities.get(activityKey(binding)) === activity
      && !activity.root
      && activity.descendants.size === 0
      && !activity.pendingRootTerminal
      && !activity.syntheticDescendantTurn
      && activity.pendingQuestions.size === 0
      && activity.retryFailures.size === 0
      && activity.lateRetryFailures.size === 0
      && activity.heartbeatSessions.size === 0
    ) sharedActivities.delete(activityKey(binding))
    return
  }
}
const paneLifecycleBinding = (activity: SharedPaneActivity, key: string): TurnBinding | undefined =>
  activity.root?.binding
  ?? activity.pendingRootTerminal?.binding
  ?? activity.syntheticDescendantTurn
  ?? activity.descendants.get(key)
const questionKey = (session: string, toolCallId: string) => JSON.stringify([session, toolCallId])
const clearQuestionsForSession = (activity: SharedPaneActivity, key: string) => {
  let cleared = false
  for (const [pendingKey, owner] of activity.pendingQuestions) {
    if (owner !== key) continue
    activity.pendingQuestions.delete(pendingKey)
    cleared = true
  }
  return cleared && activity.pendingQuestions.size === 0
}
const markQuestionPending = async (event: any, client: ClientBinding) => {
  if (process.env.WMUX_DELEGATED_RUN === "1") return
  if (activityRetired(client)) return
  const key = client.sessionId
  const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : ""
  if (!toolCallId || toolCallId.length > 512) return
  const activity = sharedActivities.get(activityKey(client))
  const binding = activity && paneLifecycleBinding(activity, key)
  if (!activity || !binding) return
  const pendingKey = questionKey(key, toolCallId)
  if (activity.pendingQuestions.has(pendingKey)) return
  const publishWaiting = activity.pendingQuestions.size === 0
  activity.pendingQuestions.set(pendingKey, key)
  if (publishWaiting) await send({ hook_event_name: "Question" }, binding)
}
const markQuestionResolved = async (event: any, client: ClientBinding) => {
  if (process.env.WMUX_DELEGATED_RUN === "1") return
  if (activityRetired(client)) return
  const key = client.sessionId
  const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : ""
  if (!toolCallId || toolCallId.length > 512) return
  const activity = sharedActivities.get(activityKey(client))
  if (!activity || !activity.pendingQuestions.delete(questionKey(key, toolCallId))) return
  if (activity.pendingQuestions.size > 0) return
  const binding = paneLifecycleBinding(activity, key)
  if (binding) await send({ hook_event_name: "Resume" }, binding)
  await cleanupActivity(client, activity)
}
const finishDescendant = async (
  binding: ClientBinding,
  key: string,
  syntheticTerminal: Record<string, unknown> = { hook_event_name: "Stop" },
) => {
  if (activityRetired(binding)) return
  const activity = sharedActivities.get(activityKey(binding))
  if (!activity) return
  if (!activity.descendants.delete(key)) {
    await cleanupActivity(binding, activity)
    return
  }
  if (activity.descendants.size > 0) return
  const pending = activity.pendingRootTerminal
  if (pending) {
    const lateRoot = [...activity.lateRetryFailures.values()].find(
      (candidate) => candidate.binding === pending.binding,
    )
    if (lateRoot) lateRoot.terminalSent = true
    activity.pendingRootTerminal = undefined
    activity.syntheticDescendantTurn = undefined
    await send(pending.input, pending.binding)
    await cleanupActivity(binding, activity)
    return
  }
  const synthetic = activity.syntheticDescendantTurn
  if (!synthetic || activity.root) {
    await cleanupActivity(binding, activity)
    return
  }
  activity.syntheticDescendantTurn = undefined
  await send(syntheticTerminal, synthetic)
  await cleanupActivity(binding, activity)
}

const clearLateRetryFailure = (activity: SharedPaneActivity, key: string) => {
  const late = activity.lateRetryFailures.get(key)
  if (late?.timer) clearTimeout(late.timer)
  activity.lateRetryFailures.delete(key)
}
const armLateRetryFailureExpiry = (
  client: ClientBinding,
  activity: SharedPaneActivity,
  key: string,
  late: LateRetryFailure,
) => {
  if (activity.lateRetryFailures.get(key) !== late || late.timer) return
  late.timer = setTimeout(() => {
    if (activity.lateRetryFailures.get(key) !== late) return
    activity.lateRetryFailures.delete(key)
    void cleanupActivity(client, activity).catch(() => {})
  }, lateRetryRecoveryMs)
  late.timer.unref?.()
}
const rememberLateRetryFailure = (
  client: ClientBinding,
  activity: SharedPaneActivity,
  key: string,
  depth: number,
  binding: TurnBinding,
  terminalSent: boolean,
  armExpiry = true,
): LateRetryFailure => {
  clearLateRetryFailure(activity, key)
  const late: LateRetryFailure = { depth, binding, terminalSent }
  activity.lateRetryFailures.set(key, late)
  if (armExpiry) armLateRetryFailureExpiry(client, activity, key, late)
  return late
}
const cancelRetryFailure = (activity: SharedPaneActivity, key: string) => {
  const pending = activity.retryFailures.get(key)
  if (pending?.timer) clearTimeout(pending.timer)
  activity.retryFailures.delete(key)
  clearLateRetryFailure(activity, key)
}
const finalizeRetryFailure = async (
  client: ClientBinding,
  key: string,
  pending: PendingRetryFailure,
) => {
  if (activityRetired(client)) return
  const activity = sharedActivities.get(activityKey(client))
  if (!activity || activity.retryFailures.get(key) !== pending) return
  activity.retryFailures.delete(key)
  if (pending.depth > 0) {
    if (activity.descendants.get(key) !== pending.binding) {
      await cleanupActivity(client, activity)
      return
    }
    const terminalSent = activity.descendants.size === 1
      && activity.syntheticDescendantTurn === pending.binding
      && !activity.root
      && !activity.pendingRootTerminal
    const late = rememberLateRetryFailure(
      client, activity, key, pending.depth, pending.binding, terminalSent, !terminalSent,
    )
    await finishDescendant(client, key, pending.terminal.input)
    if (terminalSent) armLateRetryFailureExpiry(client, activity, key, late)
    return
  }
  if (activity.root?.sessionKey !== key || activity.root.binding !== pending.binding) {
    await cleanupActivity(client, activity)
    return
  }
  activity.root = undefined
  if (activity.descendants.size > 0) {
    rememberLateRetryFailure(client, activity, key, pending.depth, pending.binding, false)
    activity.pendingRootTerminal = pending.terminal
    return
  }
  const late = rememberLateRetryFailure(client, activity, key, pending.depth, pending.binding, true, false)
  await send(pending.terminal.input, pending.terminal.binding)
  armLateRetryFailureExpiry(client, activity, key, late)
  await cleanupActivity(client, activity)
}
const holdRetryFailure = (
  client: ClientBinding,
  activity: SharedPaneActivity,
  key: string,
  depth: number,
  binding: TurnBinding,
  terminal: PendingTerminal,
) => {
  cancelRetryFailure(activity, key)
  const pending: PendingRetryFailure = { depth, binding, terminal }
  activity.retryFailures.set(key, pending)
  pending.timer = setTimeout(() => {
    void finalizeRetryFailure(client, key, pending).catch(() => {})
  }, retryFailureGraceMs)
  pending.timer.unref?.()
}
const resumeRetryFailure = async (
  client: ClientBinding,
  activity: SharedPaneActivity,
  key: string,
  depth: number,
): Promise<boolean> => {
  if (activityRetired(client)) return false
  const pending = activity.retryFailures.get(key)
  if (pending) {
    const activeBinding = depth > 0
      ? activity.descendants.get(key)
      : activity.root?.sessionKey === key ? activity.root.binding : undefined
    if (pending.depth !== depth || pending.binding !== activeBinding) {
      cancelRetryFailure(activity, key)
      return false
    }
    if (pending.timer) clearTimeout(pending.timer)
    activity.retryFailures.delete(key)
    clearLateRetryFailure(activity, key)
    return true
  }
  // Custom retry delays can outlive the grace. Resume an unsent deferred
  // terminal on its original binding; once sent, immutable runs require a new id.
  const late = activity.lateRetryFailures.get(key)
  if (!late || late.depth !== depth) return false
  if ((depth > 0 && activity.descendants.has(key)) || (depth === 0 && activity.root?.sessionKey === key)) {
    clearLateRetryFailure(activity, key)
    return false
  }
  if (depth === 0 && !late.terminalSent && activity.pendingRootTerminal?.binding === late.binding) {
    clearLateRetryFailure(activity, key)
    activity.pendingRootTerminal = undefined
    activity.root = { sessionKey: key, binding: late.binding }
    return true
  }
  clearLateRetryFailure(activity, key)
  const turn: TurnBinding = late.terminalSent ? makeTurnBinding(client, randomUUID(), "") : late.binding
  if (depth > 0) {
    activity.descendants.set(key, turn)
    if (activity.root || activity.pendingRootTerminal || activity.syntheticDescendantTurn) return true
    activity.syntheticDescendantTurn = turn
  } else {
    activity.root = { sessionKey: key, binding: turn }
    activity.pendingRootTerminal = undefined
    activity.syntheticDescendantTurn = undefined
  }
  await send({ hook_event_name: "UserPromptSubmit" }, turn)
  return true
}

const completeAgentBinding = async (
  client: ClientBinding,
  key: string,
  depth: number,
  binding: TurnBinding,
  terminal: PendingTerminal,
) => {
  if (activityRetired(client)) return
  const activity = sharedActivities.get(activityKey(client))
  if (!activity) return
  const active = depth > 0
    ? activity.descendants.get(key)
    : activity.root?.sessionKey === key ? activity.root.binding : undefined
  if (active !== binding) return
  cancelRetryFailure(activity, key)
  if (depth > 0) {
    await finishDescendant(client, key, terminal.input)
    return
  }
  activity.root = undefined
  if (activity.descendants.size > 0) {
    activity.pendingRootTerminal = terminal
    return
  }
  await send(terminal.input, terminal.binding)
  await cleanupActivity(client, activity)
}

const scheduledHeartbeatFile = (ctx: any, key: string): string | undefined => {
  if (basename(key) !== key || key === "." || key === "..") return undefined
  try {
    const value = ctx?.sessionManager?.getSessionDir?.()
    return typeof value === "string" && value
      ? join(dirname(value), "session-artifacts", key, "scheduled-jobs.json")
      : undefined
  } catch {
    return undefined
  }
}

const readScheduledHeartbeatActive = async (
  ctx: any,
  key: string,
): Promise<boolean | undefined> => {
  const file = scheduledHeartbeatFile(ctx, key)
  if (!file) return undefined
  try {
    const raw = await readFile(file, "utf8")
    if (raw.length > 1_000_000) return undefined
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) return undefined
    return parsed.jobs.some((job: any) =>
      job
      && typeof job === "object"
      && job.sessionId === key
      && (job.source === "heartbeat" || job.source === "rlm_heartbeat")
      && job.status === "active"
    )
  } catch (error: any) {
    return error?.code === "ENOENT" ? false : undefined
  }
}

const messageText = (value: unknown): string => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join("\n")
  if (!value || typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  if (record.type === "text" && typeof record.text === "string") return record.text
  const content = messageText(record.content)
  if (content) return content
  return typeof record.errorMessage === "string" ? record.errorMessage : ""
}

type PrimeTitleState = {
  version: 1
  title: string
  ownership: "auto" | "external"
  lastRefreshTurn: number
  observedRootTurns: number
}
const TITLE_STATE_CUSTOM_TYPE = "wmux.prime-title-state.v1"
const TITLE_REFRESH_INTERVAL = 6
const sharedTitleStateSymbol = Symbol.for("wmux.prime-agent.title-state.v1")
const sharedTitleStates = (
  (globalThis as any)[sharedTitleStateSymbol]
  ?? ((globalThis as any)[sharedTitleStateSymbol] = new Map<string, PrimeTitleState>())
) as Map<string, PrimeTitleState>
const titleStateKey = (identity: WmuxIdentity, key: string) => identity.paneId + ":" + key
const cleanDisplayTitle = (value: unknown, limit = 50): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit).trim() : ""
const titleFromText = (value: unknown): string => {
  let text = cleanDisplayTitle(value, 300)
    .replace(/^(?:please|can you|could you|let['’]?s|we need to|i want to)\s+/i, "")
    .replace(/^[#>*~_\-]+\s*/, "")
    .replace(/[.?!:;,\-–—\s]+$/, "")
  if (!text) return ""
  text = text.split(/(?<=[.!?])\s+|\n+/, 1)[0] ?? text
  return cleanDisplayTitle(text.split(/\s+/).slice(0, 8).join(" "), 50)
}
const sessionEntries = (ctx: any): any[] | undefined => {
  try {
    const entries = ctx?.sessionManager?.getEntries?.()
    return Array.isArray(entries) ? entries : undefined
  } catch {
    return undefined
  }
}
const sessionBranch = (ctx: any): any[] | undefined => {
  try {
    const branch = ctx?.sessionManager?.getBranch?.()
    if (Array.isArray(branch)) return branch
    return sessionEntries(ctx)
  } catch {
    return undefined
  }
}
const storedTitleState = (entries: any[] | undefined): PrimeTitleState | undefined => {
  const entry = entries?.findLast?.((candidate: any) =>
    candidate?.type === "custom" && candidate?.customType === TITLE_STATE_CUSTOM_TYPE
  )
  const data = entry?.data
  if (
    data?.version !== 1
    || typeof data?.title !== "string"
    || !Number.isSafeInteger(data?.lastRefreshTurn)
    || data.lastRefreshTurn < 1
  ) return undefined
  return {
    version: 1,
    title: cleanDisplayTitle(data.title),
    ownership: data.ownership === "external" ? "external" : "auto",
    lastRefreshTurn: data.lastRefreshTurn,
    observedRootTurns: Number.isSafeInteger(data.observedRootTurns)
      ? Math.max(data.lastRefreshTurn, data.observedRootTurns)
      : data.lastRefreshTurn,
  }
}
const sessionNameWrittenAfterTitleState = (entries: any[] | undefined): boolean => {
  if (!entries) return false
  const stateIndex = entries.findLastIndex((entry: any) =>
    entry?.type === "custom" && entry?.customType === TITLE_STATE_CUSTOM_TYPE
  )
  if (stateIndex < 0) return false
  const nameIndex = entries.findLastIndex((entry: any) => entry?.type === "session_info")
  return nameIndex > stateIndex
}
const latestContextSummary = (entries: any[] | undefined): string => {
  const status = entries?.findLast?.((entry: any) =>
    entry?.type === "agent_status" && cleanDisplayTitle(entry?.status?.summary, 300)
  )
  if (status) return cleanDisplayTitle(status.status.summary, 300)
  const compaction = entries?.findLast?.((entry: any) =>
    entry?.type === "compaction" && cleanDisplayTitle(entry?.summary, 300)
  )
  return compaction ? cleanDisplayTitle(compaction.summary, 300) : ""
}
const rememberSharedTitleState = (key: string, state: PrimeTitleState) => {
  sharedTitleStates.delete(key)
  sharedTitleStates.set(key, state)
  if (sharedTitleStates.size > 256) {
    const oldest = sharedTitleStates.keys().next().value
    if (oldest) sharedTitleStates.delete(oldest)
  }
}
const persistTitleState = (pi: any, state: PrimeTitleState) => {
  try {
    pi.appendEntry?.(TITLE_STATE_CUSTOM_TYPE, state)
  } catch {
    // Naming is best-effort and must never block a Prime turn.
  }
}
const setPrimeSessionName = async (pi: any, title: string): Promise<boolean> => {
  if (typeof pi.setSessionName !== "function") return false
  try {
    await Promise.resolve(pi.setSessionName(title))
    return true
  } catch {
    return false
  }
}
const primeSessionName = (pi: any): string | undefined => {
  if (typeof pi.getSessionName !== "function") return undefined
  try {
    return cleanDisplayTitle(pi.getSessionName())
  } catch {
    return undefined
  }
}

export default function (pi: any) {
  const heartbeatGeneration = randomUUID()
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let heartbeatWatchDebounce: ReturnType<typeof setTimeout> | undefined
  let heartbeatWatcher: ReturnType<typeof watch> | undefined
  let heartbeatWatchSessionKey: string | undefined
  let heartbeatPollBusy = false
  let heartbeatClosed = false
  let heartbeatSessionKey: string | undefined
  let titleTimer: ReturnType<typeof setInterval> | undefined
  let titleContext: any
  let titlePollBusy = false
  let titleClosed = false
  let idleReconcileTimer: ReturnType<typeof setTimeout> | undefined
  let idleReconcileClosed = false
  let idleReconcileCandidate: {
    key: string
    depth: number
    binding: TurnBinding
    terminal: PendingTerminal
  } | undefined
  let publishedCanonicalTitle: string | undefined
  let publishingCanonicalTitle: string | undefined
  let activeClientBinding: ClientBinding | undefined
  let pendingClientBinding: ClientBinding | undefined
  let modernBindingAccepted = false
  let titleOperationTail: Promise<void> = Promise.resolve()
  let titleOperationBusy = false
  const withTitleOperation = async <T>(binding: ClientBinding, operation: () => Promise<T>): Promise<T | undefined> => {
    const prior = titleOperationTail
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    titleOperationTail = prior.catch(() => undefined).then(() => gate)
    await prior.catch(() => undefined)
    titleOperationBusy = true
    try {
      if (!activeBinding(binding)) return undefined
      return await operation()
    } finally {
      titleOperationBusy = false
      release()
    }
  }
  const retireActiveClientBinding = (previous: ClientBinding | undefined) => {
    if (!previous) return
    const activity = previous.generation > 0 ? sharedActivities.get(activityKey(previous)) : undefined
    if (activity) {
      for (const pending of activity.retryFailures.values()) if (pending.timer) clearTimeout(pending.timer)
      for (const late of activity.lateRetryFailures.values()) if (late.timer) clearTimeout(late.timer)
      activity.retryFailures.clear()
      activity.lateRetryFailures.clear()
      activity.root = undefined
      activity.descendants.clear()
      activity.pendingQuestions.clear()
      activity.pendingRootTerminal = undefined
      activity.syntheticDescendantTurn = undefined
      const publishedHeartbeatActive = activity.publishedHeartbeatActive === true
      activity.publishedHeartbeatActive = false
      if (publishedHeartbeatActive) {
        // Retiring a binding must clear the server-side scheduler pulse before
        // dropping the old activity. This final scoped clear is not a lifecycle
        // event and is queued after all earlier sends for the old owner.
        activity.sendQueue = activity.sendQueue
          .then(() => sendHeartbeatStateNow(previous.identity, false))
          .catch(() => {})
      }
      activity.heartbeatSessions.clear()
      // The registry high-water mark or fixed tombstone makes every queued old
      // callback fail closed even after this activity record is reclaimed.
      void cleanupActivity(previous, activity).catch(() => {})
    }
    if (sameClientBinding(activeClientBinding, previous)) heartbeatSessionKey = undefined
  }
  const acceptClientBinding = (next: ClientBinding, context: ValidatedContext): ClientActivation => {
    const changed = !sameClientBinding(activeClientBinding, next)
    if (!changed) return { accepted: true, binding: next, changed: false, context }
    const previous = activeClientBinding
    clearIdleReconcile()
    retireActiveClientBinding(previous)
    activeClientBinding = next
    stopHeartbeatWatcher()
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
    if (titleTimer) clearInterval(titleTimer)
    titleTimer = undefined
    titleContext = undefined
    publishedCanonicalTitle = undefined
    publishingCanonicalTitle = undefined
    return { accepted: true, binding: next, changed: true, context }
  }
  const unbindClientBinding = () => {
    const previous = activeClientBinding
    clearIdleReconcile()
    if (previous && previous.generation > 0) {
      const shared = bindingRegistry(previous)
      if (shared?.highWaterGeneration === previous.generation && sameIdentity(shared.identity, previous.identity)) {
        shared.retired = true
      }
    }
    activeClientBinding = undefined
    pendingClientBinding = undefined
    retireActiveClientBinding(previous)
    stopHeartbeatWatcher()
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
    stopTitlePolling()
    if (titleTimer) clearInterval(titleTimer)
    titleTimer = undefined
    titleContext = undefined
    publishedCanonicalTitle = undefined
    publishingCanonicalTitle = undefined
  }
  const proposedClientBinding = (ctx: any):
    | { accepted: true; binding: ClientBinding; modern: boolean; context: ValidatedContext }
    | { accepted: false; reason: "invalid" | "unbound" | "absent" } => {
    const snapshot = callbackContextSnapshot(ctx)
    if (!snapshot) return { accepted: false, reason: "invalid" }
    const context = validatedContext(snapshot)
    if (!context) return { accepted: false, reason: "invalid" }
    if (snapshot.modern && snapshot.clientContext === undefined) return { accepted: false, reason: "absent" }
    const scoped = sessionClientBinding(snapshot, context)
    const proposed = scoped === undefined
      ? (boundIdentity ? makeClientBinding(0, boundIdentity, context) : undefined)
      : scoped ?? undefined
    if (!proposed) return { accepted: false, reason: scoped === undefined ? "unbound" : "invalid" }
    return { accepted: true, binding: proposed, modern: snapshot.modern, context }
  }
  const modernBindingAllowed = (proposed: ClientBinding): "accepted" | "stale" | "conflict" => {
    const shared = sharedClientBindings.get(proposed.familyId)
    if (!shared) return possiblyRetiredFamily(proposed.familyId) ? "stale" : "accepted"
    if (proposed.generation < shared.highWaterGeneration) return "stale"
    if (proposed.generation === shared.highWaterGeneration && shared.retired) return "stale"
    if (proposed.generation === shared.highWaterGeneration && !sameIdentity(shared.identity, proposed.identity)) return "conflict"
    return "accepted"
  }
  const activateProposedBinding = (
    proposed: ClientBinding,
    modern: boolean,
    context: ValidatedContext,
  ): ClientActivation => {
    if (!modern) {
      if (modernBindingAccepted) return { accepted: false, reason: "stale" }
      return acceptClientBinding(proposed, context)
    }
    const allowed = modernBindingAllowed(proposed)
    if (allowed !== "accepted") return { accepted: false, reason: allowed }
    modernBindingAccepted = true
    const shared = sharedClientBindings.get(proposed.familyId)
    if (!shared || proposed.generation > shared.highWaterGeneration) {
      touchSharedClientBinding(proposed.familyId, {
        highWaterGeneration: proposed.generation,
        identity: freezeIdentity(proposed.identity),
      })
    } else {
      touchSharedClientBinding(proposed.familyId, shared)
    }
    return acceptClientBinding(proposed, context)
  }
  const activateClientBinding = (ctx: any): ClientActivation => {
    const proposed = proposedClientBinding(ctx)
    if (!proposed.accepted) return proposed
    if (pendingClientBinding && !sameClientBinding(pendingClientBinding, proposed.binding)) {
      return { accepted: false, reason: "stale" }
    }
    if (titleOperationBusy && !sameClientBinding(activeClientBinding, proposed.binding)) {
      return { accepted: false, reason: "stale" }
    }
    return activateProposedBinding(proposed.binding, proposed.modern, proposed.context)
  }
  const activeBinding = (binding: ClientBinding | undefined) => {
    if (!sameClientBinding(activeClientBinding, binding)) return false
    if (pendingClientBinding && !sameClientBinding(pendingClientBinding, binding)) return false
    if (!binding || binding.generation === 0) return Boolean(binding)
    const shared = bindingRegistry(binding)
    return Boolean(shared
      && !shared.retired
      && shared.highWaterGeneration === binding.generation
      && sameIdentity(shared.identity, binding.identity))
  }
  const canonicalTitleBinding = (binding: ClientBinding): TurnBinding =>
    makeTurnBinding(binding, "prime-title-sync", "")
  const titleDedupeKey = (binding: ClientBinding, title: string) => binding.generation + ":" + title
  const setPrimeSessionNameForBinding = async (binding: ClientBinding, title: string): Promise<boolean> => {
    const result = await withTitleOperation(binding, async () => {
      const prior = primeSessionName(pi)
      if (!activeBinding(binding)) return false
      const applied = await setPrimeSessionName(pi, title)
      if (activeBinding(binding)) return applied
      // A newer client context arrived while Prime was applying this generated
      // name. Activation waits for this serialized operation, so restore the
      // prior canonical value before the replacement can reconcile its title.
      if (applied && primeSessionName(pi) === title) {
        await setPrimeSessionName(pi, prior ?? "")
      }
      return false
    })
    return result === true
  }
  const publishCanonicalTitle = async (
    binding: ClientBinding,
    title: string,
    force = false,
  ) => {
    const dedupe = titleDedupeKey(binding, title)
    if (!activeBinding(binding) || !title || (!force && (publishedCanonicalTitle === dedupe || publishingCanonicalTitle === dedupe))) return
    publishingCanonicalTitle = dedupe
    const activity = activityFor(binding)
    const published = await publishAutoTitle(title, canonicalTitleBinding(binding))
    if (activeBinding(binding) && published) publishedCanonicalTitle = dedupe
    if (publishingCanonicalTitle === dedupe) publishingCanonicalTitle = undefined
    await cleanupActivity(binding, activity)
  }
  const reconcileCanonicalTitle = async (ctx: any, force = false, binding = activeClientBinding, context?: ValidatedContext) => {
    if (titleClosed || process.env.WMUX_DELEGATED_RUN === "1" || !binding || !activeBinding(binding)) return
    const identity = binding.identity
    const depth = context?.depth
    const key = context?.sessionId
    if (depth !== 0 || !key) return
    const currentName = primeSessionName(pi)
    if (currentName === undefined) return
    const entries = sessionBranch(ctx)
    const allEntries = sessionEntries(ctx)
    const stateKey = titleStateKey(identity, key)
    const persisted = storedTitleState(entries)
    const globalPersisted = storedTitleState(allEntries)
    const shared = sharedTitleStates.get(stateKey)
    const priorState = entries === undefined ? (shared ?? persisted) : persisted
    const currentNameIsKnownAuto = !sessionNameWrittenAfterTitleState(allEntries)
      && globalPersisted?.ownership === "auto"
      && currentName === globalPersisted.title
    const externalOwnership = priorState?.ownership === "external"
      || globalPersisted?.ownership === "external"
      || sessionNameWrittenAfterTitleState(allEntries)
      || sessionNameWrittenAfterTitleState(entries)
      || (
        !currentNameIsKnownAuto
        && (
          (!priorState && Boolean(currentName))
          || (priorState?.ownership === "auto" && currentName !== priorState.title)
        )
      )
    if (externalOwnership) {
      const nextState: PrimeTitleState = {
        version: 1,
        title: currentName,
        ownership: "external",
        lastRefreshTurn: priorState?.lastRefreshTurn ?? 1,
        observedRootTurns: Math.max(1, priorState?.observedRootTurns ?? 0),
      }
      rememberSharedTitleState(stateKey, nextState)
      if (
        !priorState
        || priorState.title !== nextState.title
        || priorState.ownership !== "external"
      ) persistTitleState(pi, nextState)
    }
    if (!activeBinding(binding)) return
    await publishCanonicalTitle(binding, currentName, force)
  }
  const pollCanonicalTitle = (ctx: any, binding: ClientBinding, context: ValidatedContext) => {
    if (titlePollBusy || !activeBinding(binding)) return
    titlePollBusy = true
    void reconcileCanonicalTitle(ctx, false, binding, context).finally(() => { titlePollBusy = false })
  }
  const stopTitlePolling = () => {
    titleClosed = true
    titleContext = undefined
    if (titleTimer) clearInterval(titleTimer)
    titleTimer = undefined
  }
  const stopHeartbeatWatcher = () => {
    if (heartbeatWatchDebounce) clearTimeout(heartbeatWatchDebounce)
    heartbeatWatchDebounce = undefined
    heartbeatWatcher?.close()
    heartbeatWatcher = undefined
    heartbeatWatchSessionKey = undefined
  }
  const ensureHeartbeatWatcher = (ctx: any, key: string, binding: ClientBinding, context: ValidatedContext) => {
    if (heartbeatWatcher && heartbeatWatchSessionKey === key) return
    stopHeartbeatWatcher()
    const file = scheduledHeartbeatFile(ctx, key)
    if (!file) return
    try {
      heartbeatWatcher = watch(dirname(file), { persistent: false }, (_event, filename) => {
        if (filename && filename.toString() !== "scheduled-jobs.json") return
        if (heartbeatWatchDebounce) clearTimeout(heartbeatWatchDebounce)
        heartbeatWatchDebounce = setTimeout(() => pollHeartbeatState(ctx, binding, context), 75)
        heartbeatWatchDebounce.unref?.()
      })
      heartbeatWatcher.on("error", () => stopHeartbeatWatcher())
      heartbeatWatchSessionKey = key
    } catch {
      heartbeatWatcher = undefined
    }
  }
  const reconcileHeartbeatState = async (ctx: any, force = false, binding = activeClientBinding, context?: ValidatedContext) => {
    if (heartbeatClosed || process.env.WMUX_DELEGATED_RUN === "1" || !binding || !activeBinding(binding)) return
    const depth = context?.depth
    const key = context?.sessionId
    if (depth === undefined || !key || !context) return
    ensureHeartbeatWatcher(ctx, key, binding, context)
    const active = await readScheduledHeartbeatActive(ctx, key)
    // A resumed session can activate another immutable client generation while
    // the artifact read is in flight. Never publish that stale result.
    if (heartbeatClosed || active === undefined || !activeBinding(binding)) return
    const activity = activityFor(binding)
    if (heartbeatSessionKey && heartbeatSessionKey !== key) {
      const previous = activity.heartbeatSessions.get(heartbeatSessionKey)
      if (previous?.generation === heartbeatGeneration) activity.heartbeatSessions.delete(heartbeatSessionKey)
    }
    activity.heartbeatSessions.set(key, { generation: heartbeatGeneration, active })
    heartbeatSessionKey = key
    await publishHeartbeatAggregate(binding, activity, force)
  }
  const pollHeartbeatState = (ctx: any, binding: ClientBinding, context: ValidatedContext) => {
    if (heartbeatPollBusy || !activeBinding(binding)) return
    heartbeatPollBusy = true
    void reconcileHeartbeatState(ctx, false, binding, context).finally(() => { heartbeatPollBusy = false })
  }
  const clearIdleReconcile = () => {
    if (idleReconcileTimer) clearTimeout(idleReconcileTimer)
    idleReconcileTimer = undefined
    idleReconcileCandidate = undefined
  }
  const scheduleIdleReconcile = (ctx: any, client: ClientBinding, context: ValidatedContext) => {
    if (idleReconcileClosed || idleReconcileTimer || !activeBinding(client)) return
    idleReconcileTimer = setTimeout(() => {
      idleReconcileTimer = undefined
      void reconcileIdleActivity(ctx, client, context).catch(() => {})
    }, idleReconcileGraceMs)
    idleReconcileTimer.unref?.()
  }
  const reconcileIdleActivity = async (ctx: any, client: ClientBinding, context: ValidatedContext) => {
    if (idleReconcileClosed || process.env.WMUX_DELEGATED_RUN === "1" || !activeBinding(client)) return
    const depth = context.depth
    const key = context.sessionId
    const activity = sharedActivities.get(activityKey(client))
    const binding = depth > 0
      ? activity?.descendants.get(key)
      : activity?.root?.sessionKey === key ? activity.root.binding : undefined
    if (!activity || !binding) {
      idleReconcileCandidate = undefined
      return
    }
    // A provider-error hold owns this binding across extension reloads. Its
    // retry grace must finish or be resumed before ordinary idle healing.
    if (activity.retryFailures.has(key)) {
      idleReconcileCandidate = undefined
      return
    }
    if (
      idleReconcileCandidate
      && (
        idleReconcileCandidate.key !== key
        || idleReconcileCandidate.depth !== depth
        || idleReconcileCandidate.binding !== binding
      )
    ) {
      idleReconcileCandidate = undefined
      return
    }
    let idle = false
    let pending = false
    try {
      idle = ctx?.isIdle?.() === true
    } catch {
      idle = false
    }
    try {
      pending = ctx?.hasPendingMessages?.() === true
    } catch {
      pending = true
    }
    if (!idle || pending || activity.pendingQuestions.size > 0) {
      scheduleIdleReconcile(ctx, client, context)
      return
    }
    const terminal = idleReconcileCandidate?.terminal ?? {
      input: { hook_event_name: "Stop" },
      binding,
    }
    idleReconcileCandidate = undefined
    await completeAgentBinding(client, key, depth, binding, terminal)
  }
  const armIdleReconcile = (
    ctx: any,
    client: ClientBinding,
    context: ValidatedContext,
    candidate?: { key: string; depth: number; binding: TurnBinding; terminal: PendingTerminal },
  ) => {
    clearIdleReconcile()
    idleReconcileCandidate = candidate
    scheduleIdleReconcile(ctx, client, context)
  }
  const stopIdleReconcile = () => {
    idleReconcileClosed = true
    clearIdleReconcile()
  }
  const startReconciliation = async (ctx: any, binding: ClientBinding, context: ValidatedContext, force = false) => {
    if (!activeBinding(binding) || process.env.WMUX_DELEGATED_RUN === "1") return
    heartbeatClosed = false
    titleClosed = false
    idleReconcileClosed = false
    titleContext = ctx
    await reconcileHeartbeatState(ctx, force, binding, context)
    await reconcileCanonicalTitle(ctx, force, binding, context)
    if (!activeBinding(binding)) return
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (titleTimer) clearInterval(titleTimer)
    armIdleReconcile(ctx, binding, context)
    heartbeatTimer = setInterval(() => pollHeartbeatState(ctx, binding, context), 1_000)
    heartbeatTimer.unref?.()
    titleTimer = setInterval(() => {
      if (titleContext === ctx) pollCanonicalTitle(ctx, binding, context)
    }, titleReconcileIntervalMs)
    titleTimer.unref?.()
  }
  pi.on("session_start", async (_event: any, ctx: any) => {
    const activation = activateClientBinding(ctx)
    if (!activation.accepted) return
    await startReconciliation(ctx, activation.binding, activation.context, true)
  })
  try {
    pi.on("session_client_context_changed", async (_event: any, ctx: any) => {
      const proposed = proposedClientBinding(ctx)
      if (!proposed.accepted) {
        if (proposed.reason === "absent") unbindClientBinding()
        return
      }
      if (!proposed.modern) return
      if (modernBindingAllowed(proposed.binding) !== "accepted") return
      if (sameClientBinding(activeClientBinding, proposed.binding)) return
      if (pendingClientBinding) {
        if (proposed.binding.familyId !== pendingClientBinding.familyId) return
        if (proposed.binding.generation < pendingClientBinding.generation) return
        if (proposed.binding.generation === pendingClientBinding.generation
          && !sameIdentity(proposed.binding.identity, pendingClientBinding.identity)) return
      }
      // Mark the replacement before waiting so the active title operation can
      // detect that it lost authority. Activation itself is serialized after
      // that operation, so a delayed old setSessionName cannot land later.
      pendingClientBinding = proposed.binding
      await titleOperationTail.catch(() => undefined)
      if (!sameClientBinding(pendingClientBinding, proposed.binding)) return
      pendingClientBinding = undefined
      const activation = activateProposedBinding(proposed.binding, true, proposed.context)
      if (activation.accepted && activation.changed) await startReconciliation(ctx, activation.binding, activation.context, true)
    })
  } catch {
    // Older Prime does not expose the client-context lifecycle event.
  }
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event?.toolName === "questionnaire") {
      const activation = activateClientBinding(ctx)
      if (activation.accepted) await markQuestionPending(event, activation.binding)
      return
    }
    if (event?.toolName !== "ipython" || typeof event?.input?.code !== "string") return
    const activation = activateClientBinding(ctx)
    if (!activation.accepted) {
      // The old Prime fallback has no client snapshot. Clear an invalid
      // load-scoped tuple, but never touch a rejected modern callback.
      if (activation.reason === "unbound") event.input.code = bindIpythonEnvironment(event.input.code, undefined, true)
      return
    }
    const binding = activation.binding
    const depth = activation.context.depth
    const key = activation.context.sessionId
    const activity = sharedActivities.get(activityKey(binding))
    const turn = depth !== undefined && key
      ? (depth > 0 ? activity?.descendants.get(key) : activity?.root?.sessionKey === key ? activity.root.binding : undefined)
      : undefined
    // A tool can be the first observable hook on older Prime. It still gets a
    // one-shot immutable binding, while active turns retain their own binding.
    const toolBinding = turn ?? makeTurnBinding(binding, "prime-tool-context", "")
    event.input.code = bindIpythonEnvironment(event.input.code, toolBinding)
  })
  pi.on("tool_result", async (event: any, ctx: any) => {
    if (event?.toolName !== "questionnaire") return
    const activation = activateClientBinding(ctx)
    if (activation.accepted) await markQuestionResolved(event, activation.binding)
  })
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const activation = activateClientBinding(ctx)
    if (!activation.accepted || process.env.WMUX_DELEGATED_RUN === "1") return
    const binding = activation.binding
    const context = activation.context
    await reconcileHeartbeatState(ctx, false, binding, activation.context)
    // A newer immutable context may arrive while the heartbeat artifact is read.
    // Do not let this predecessor mutate or enqueue its retired activity.
    if (!activeBinding(binding)) return
    const identity = binding.identity
    const depth = activation.context.depth
    const key = activation.context.sessionId
    if (depth === undefined || !key) return
    idleReconcileClosed = false
    clearIdleReconcile()
    const activity = activityFor(binding)
    cancelRetryFailure(activity, key)
    if (depth > 0) {
      if (activity.descendants.has(key)) return
      const descendant = makeTurnBinding(binding, randomUUID(), "")
      activity.descendants.set(key, descendant)
      if (activity.root || activity.pendingRootTerminal || activity.syntheticDescendantTurn) return
      activity.syntheticDescendantTurn = descendant
      await send({ hook_event_name: "UserPromptSubmit" }, descendant)
      return
    }

    const prompt = typeof event.prompt === "string" ? event.prompt : ""
    let root = activity.root?.sessionKey === key ? activity.root.binding : undefined
    const newRootTurn = !root
    if (!root) {
      root = makeTurnBinding(binding, randomUUID(), prompt)
      activity.root = { sessionKey: key, binding: root }
      // A new root turn supersedes an older deferred/synthetic pane activity.
      // Its running event makes the server interrupt that prior run.
      activity.pendingRootTerminal = undefined
      activity.syntheticDescendantTurn = undefined
    }

    if (newRootTurn && prompt.trim()) {
      titleContext = ctx
      await reconcileCanonicalTitle(ctx, false, binding, context)
      if (!activeBinding(binding)) return
      const entries = sessionBranch(ctx)
      const allEntries = sessionEntries(ctx)
      const stateKey = titleStateKey(identity, key)
      const persisted = storedTitleState(entries)
      const globalPersisted = storedTitleState(allEntries)
      const shared = sharedTitleStates.get(stateKey)
      // A branch-local persisted marker is authoritative. Process memory is
      // only a compatibility fallback when the host cannot expose entries.
      const priorState = entries === undefined ? (shared ?? persisted) : persisted
      const rootTurn = (priorState?.observedRootTurns ?? 0) + 1
      const currentName = primeSessionName(pi)
      const globalNameWrittenAfterTitleState = sessionNameWrittenAfterTitleState(allEntries)
      const currentNameIsKnownAuto = currentName !== undefined
        && !globalNameWrittenAfterTitleState
        && globalPersisted?.ownership === "auto"
        && currentName === globalPersisted.title
      const branchAutoMismatch = priorState?.ownership === "auto"
        && currentNameIsKnownAuto
        && currentName !== priorState.title
      const externalOwnership = priorState?.ownership === "external"
        || globalPersisted?.ownership === "external"
        || globalNameWrittenAfterTitleState
        || sessionNameWrittenAfterTitleState(entries)
        || (
          currentName !== undefined
          && !currentNameIsKnownAuto
          && (
            (!priorState && Boolean(currentName))
            || (priorState?.ownership === "auto" && currentName !== priorState.title)
          )
        )

      if (externalOwnership) {
        // Prime is canonical once the user names or clears its session.
        // Contextual generation stays disabled across later turns and reloads.
        const nextState: PrimeTitleState = {
          version: 1,
          title: currentName !== undefined ? currentName : (priorState?.title ?? ""),
          ownership: "external",
          lastRefreshTurn: priorState?.lastRefreshTurn ?? rootTurn,
          observedRootTurns: Math.max(rootTurn, priorState?.observedRootTurns ?? 0),
        }
        rememberSharedTitleState(stateKey, nextState)
        persistTitleState(pi, nextState)
      } else {
        const refreshDue = !priorState
          || branchAutoMismatch
          || rootTurn - priorState.lastRefreshTurn >= TITLE_REFRESH_INTERVAL
        if (refreshDue) {
          const contextualSource = rootTurn > 1 ? latestContextSummary(entries) : ""
          let candidate = titleFromText(contextualSource || prompt) || priorState?.title || titleFromText(prompt)
          let canonical = currentName
          if (candidate && currentName === undefined) {
            let applied = await setPrimeSessionNameForBinding(binding, candidate)
            if (!activeBinding(binding)) return
            canonical = primeSessionName(pi)
            if (!applied || canonical !== candidate) {
              const suffix = key.replace(/[^A-Za-z0-9]+/g, "").slice(-6) || "wmux"
              const retry = cleanDisplayTitle(candidate.slice(0, Math.max(1, 49 - suffix.length)) + " " + suffix, 50)
              applied = retry !== candidate && await setPrimeSessionNameForBinding(binding, retry)
              if (!activeBinding(binding)) return
              canonical = primeSessionName(pi)
              if (applied && canonical === retry) candidate = retry
              else candidate = ""
            }
          } else if (candidate && currentName !== candidate) {
            // Do not race an external /name that lands between reconciliation
            // and wmux's deliberate generated-name update.
            let applied = primeSessionName(pi) === currentName
              && await setPrimeSessionNameForBinding(binding, candidate)
            if (!activeBinding(binding)) return
            canonical = primeSessionName(pi)
            applied = applied && canonical === candidate
            if (!applied && canonical === currentName) {
              const suffix = key.replace(/[^A-Za-z0-9]+/g, "").slice(-6) || "wmux"
              const retry = cleanDisplayTitle(candidate.slice(0, Math.max(1, 49 - suffix.length)) + " " + suffix, 50)
              if (retry !== candidate) {
                applied = await setPrimeSessionNameForBinding(binding, retry)
                if (!activeBinding(binding)) return
                canonical = primeSessionName(pi)
                if (applied && canonical === retry) candidate = retry
                else applied = false
              }
            }
            if (!applied) candidate = priorState?.title ?? ""
          }
          const nextState: PrimeTitleState = {
            version: 1,
            title: canonical === candidate ? canonical : candidate,
            ownership: "auto",
            lastRefreshTurn: rootTurn,
            observedRootTurns: rootTurn,
          }
          rememberSharedTitleState(stateKey, nextState)
          persistTitleState(pi, nextState)
          if (canonical && canonical === nextState.title) {
            await publishCanonicalTitle(binding, canonical)
          }
        } else {
          const nextState: PrimeTitleState = {
            ...priorState,
            observedRootTurns: Math.max(rootTurn, priorState.observedRootTurns),
          }
          rememberSharedTitleState(stateKey, nextState)
          persistTitleState(pi, nextState)
        }
      }
    }
    if (!activeBinding(binding)) return
    await send({ hook_event_name: "UserPromptSubmit" }, root)
  })
  pi.on("agent_start", async (_event: any, ctx: any) => {
    if (process.env.WMUX_DELEGATED_RUN === "1") return
    const activation = activateClientBinding(ctx)
    if (!activation.accepted) return
    const binding = activation.binding
    const depth = activation.context.depth
    const key = activation.context.sessionId
    if (depth === undefined || !key) return
    idleReconcileClosed = false
    clearIdleReconcile()
    const activity = activityFor(binding)
    if (await resumeRetryFailure(binding, activity, key, depth)) return
    if (!activeBinding(binding)) return

    // Agent-to-agent messages can reactivate an idle root or descendant without
    // another before_agent_start. Recreate the pane lifecycle from agent_start.
    if (depth > 0) {
      if (activity.descendants.has(key)) return
      const descendant = makeTurnBinding(binding, randomUUID(), "")
      activity.descendants.set(key, descendant)
      if (activity.root || activity.pendingRootTerminal || activity.syntheticDescendantTurn) return
      activity.syntheticDescendantTurn = descendant
      await send({ hook_event_name: "UserPromptSubmit" }, descendant)
      return
    }
    if (activity.root?.sessionKey === key) return
    const root = makeTurnBinding(binding, randomUUID(), "")
    activity.root = { sessionKey: key, binding: root }
    activity.pendingRootTerminal = undefined
    activity.syntheticDescendantTurn = undefined
    await send({ hook_event_name: "UserPromptSubmit" }, root)
  })
  pi.on("agent_end", async (event: any, ctx: any) => {
    if (process.env.WMUX_DELEGATED_RUN === "1") return
    const messages = Array.isArray(event.messages) ? event.messages : []
    const assistant = messages.findLast((message: any) => message?.role === "assistant")
    const stopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : ""
    // Prime emits intermediate toolUse ends before auto-compaction. A queued
    // continuation gets a short idle grace below so it cannot strand a run.
    if (stopReason === "toolUse") return
    const activation = activateClientBinding(ctx)
    if (!activation.accepted) return
    const binding = activation.binding
    const depth = activation.context.depth
    const key = activation.context.sessionId
    if (depth === undefined || !key) return
    await reconcileHeartbeatState(ctx, false, binding, activation.context)
    if (!activeBinding(binding)) return
    const activity = sharedActivities.get(activityKey(binding))
    if (!activity) return
    const completed = depth > 0
      ? activity.descendants.get(key)
      : activity.root?.sessionKey === key ? activity.root.binding : undefined
    if (!completed) return
    const errorMessage = typeof assistant?.errorMessage === "string" ? assistant.errorMessage.trim() : ""
    const terminal: PendingTerminal = {
      input: {
        hook_event_name: stopReason === "error" ? "Error" : stopReason === "aborted" ? "Interrupted" : "Stop",
        last_assistant_message: (stopReason === "error" || stopReason === "aborted") && errorMessage
          ? errorMessage
          : messageText(assistant),
      },
      binding: completed,
    }
    if (stopReason === "error") {
      clearIdleReconcile()
      holdRetryFailure(binding, activity, key, depth, completed, terminal)
      return
    }
    if (ctx.hasPendingMessages?.()) {
      armIdleReconcile(ctx, binding, activation.context, { key, depth, binding: completed, terminal })
      return
    }
    clearIdleReconcile()
    await completeAgentBinding(binding, key, depth, completed, terminal)
  })
  pi.on("session_shutdown", async (event: any, ctx: any) => {
    if (process.env.WMUX_DELEGATED_RUN === "1") return
    const activation = activateClientBinding(ctx)
    // A stale or malformed shutdown belongs to no current lifecycle. In
    // particular it must not terminalize a newer generation's root activity.
    if (!activation.accepted) return
    const binding = activation.binding
    heartbeatClosed = true
    stopHeartbeatWatcher()
    stopTitlePolling()
    stopIdleReconcile()
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
    const depth = activation.context.depth
    const key = activation.context.sessionId
    if (depth === undefined || !key) return
    const activity = sharedActivities.get(activityKey(binding))
    const clearedFinalQuestion = activity ? clearQuestionsForSession(activity, key) : false
    if (event?.reason === "reload") return
    if (activity) cancelRetryFailure(activity, key)
    if (activity?.root && depth > 0 && clearedFinalQuestion) {
      await send({ hook_event_name: "Resume" }, activity.root.binding)
      if (!activeBinding(binding)) return
    }
    if (activity) {
      let removedHeartbeat = false
      for (const [sessionKey, member] of activity.heartbeatSessions) {
        if (member.generation !== heartbeatGeneration) continue
        activity.heartbeatSessions.delete(sessionKey)
        removedHeartbeat = true
      }
      if (removedHeartbeat) {
        heartbeatSessionKey = undefined
        await publishHeartbeatAggregate(binding, activity)
        if (!activeBinding(binding)) return
      }
    }
    if (depth > 0) {
      await finishDescendant(binding, key)
      return
    }
    const interrupted = activity?.root?.sessionKey === key ? activity.root.binding : undefined
    if (!activity) return
    if (!interrupted) {
      await cleanupActivity(binding, activity)
      return
    }
    activity.root = undefined
    const terminal: PendingTerminal = {
      input: {
        hook_event_name: "Interrupted",
        last_assistant_message: "Prime Agent session "
          + (typeof event?.reason === "string" ? event.reason : "shutdown"),
      },
      binding: interrupted,
    }
    if (activity.descendants.size > 0) {
      activity.pendingRootTerminal = terminal
      return
    }
    await send(terminal.input, terminal.binding)
    await cleanupActivity(binding, activity)
  })
}

import {
  PORT_NAME,
  type BgToPanel,
  type BreakpointInfo,
  type CallFrame,
  type CapturedRequest,
  type EventBreakpointInfo,
  type ExtractedHandler,
  type FrameworkId,
  type FrameworkResolution,
  type FunctionBreakpointInfo,
  type GqlOpBreakpointInfo,
  type GraphQLMeta,
  type ListenerInfo,
  type PanelToBg,
  type PausedSnapshot,
  type PickerMessage,
  type RemoteProperty,
  type ScreenshotMode,
  type ScriptInfo,
  type SourceMapFetchResult,
  type SourceMapFetchStrategy,
} from "../shared/messages";
import { decodeDataUri } from "../shared/dataUri";
import { pickerScript } from "../content/picker";
import { buildGqlHookSource, GQL_PAUSE_SENTINEL } from "./gqlHook";
import {
  getGraphQLBody,
  isGraphQLCandidate,
  nullGraphQLMeta,
  parseGraphQLBody,
} from "./graphql";

// ---- Minimal shapes for the CDP events/results we consume (protocol 1.3) ----

interface StackNode {
  description?: string;
  callFrames: CallFrame[];
  parent?: StackNode;
}

interface Initiator {
  type: string;
  stack?: StackNode;
  url?: string;
  lineNumber?: number;
}

interface RequestWillBeSentParams {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    hasPostData?: boolean;
  };
  timestamp: number;
  type?: string;
  initiator?: Initiator;
}

interface ResponseReceivedParams {
  requestId: string;
  response: { status: number; mimeType: string };
}

interface ScriptParsedParams {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  hasSourceURL?: boolean;
  executionContextId?: number;
}

interface LoadNetworkResourceResult {
  resource: {
    success: boolean;
    netError?: number;
    netErrorName?: string;
    httpStatusCode?: number;
    stream?: string; // IO.StreamHandle
  };
}

interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
}

interface PausedParams {
  reason: string;
  data?: { url?: string; breakpointURL?: string; eventName?: string };
  hitBreakpoints?: string[];
  callFrames: {
    callFrameId?: string;
    functionName: string;
    location: { scriptId: string; lineNumber: number; columnNumber?: number };
    scopeChain: { type: string; object: RemoteObject }[];
  }[];
  // M7: async parents of the paused stack (Runtime.StackTrace — same shape as
  // the initiator StackNode). Present when setAsyncCallStackDepth > 0.
  asyncStackTrace?: StackNode;
}

interface SetBreakpointResult {
  breakpointId: string;
  locations: unknown[];
}

interface BreakpointResolvedParams {
  breakpointId: string;
}

interface GetPropertiesResult {
  result: { name: string; value?: RemoteObject }[];
}

// MV3 service workers are killed when idle, which wipes this in-memory state
// even though the real chrome.debugger attachment can outlive the worker. That
// means attachedTabId can desync from reality after a worker restart. The
// eventual fix (not built yet) is to reconcile against
// chrome.debugger.getTargets() on startup. The requests map, breakpoints, and
// paused state are lost the same way; a reconnecting panel just gets an empty
// snapshot, which is a known limitation.
let attachedTabId: number | null = null;
let attachedTabTitle: string | undefined;
let port: chrome.runtime.Port | null = null;
const requests = new Map<string, CapturedRequest>();

// M4/M5 session state — all cleared on detach.
const breakpoints = new Map<string, BreakpointInfo>();
const xhrBreakpoints = new Set<string>();
const eventBreakpoints = new Map<string, EventBreakpointInfo>(); // eventName -> info
const functionBreakpoints = new Map<string, FunctionBreakpointInfo>(); // breakpointId -> info
const gqlOpBreakpoints = new Map<string, GqlOpBreakpointInfo>(); // target -> info
// Registration id of the new-document hook script; the live-patch flag tells
// teardown whether the current page needs its fetch/XHR restored.
let gqlHookScriptId: string | null = null;
let gqlHookInstalled = false;
const scripts = new Map<string, ScriptInfo>(); // scriptId -> info
let pausedState: PausedSnapshot | null = null;
// Stamped onto every NEW pausedState (never on the GraphQL detail-refinement
// re-post, which mutates the same object) — see PausedSnapshot.pauseId.
let pauseSeq = 0;
// Network.loadNetworkResource needs the frame whose network context (cookies,
// credentials) the fetch should run in. The top frame is the default/retry
// target; for MFE remote chunks the SCRIPT'S OWN frame (via
// executionContextId -> frameId, from Runtime.executionContextCreated) is
// tried first — a differently-originated resource can fail against the
// wrong frame's network context.
let mainFrameId: string | null = null;
let pageUrl: string | undefined; // for mixed-content detection
const contextFrames = new Map<number, string>(); // executionContextId -> frameId

// ---- M7: lifecycle & load-time capture ----
// The panel usually attaches AFTER the page loaded, so init-time requests
// (bootstrap, lifecycle hooks) fired before we were listening. "Reload &
// capture" re-arms everything and reloads so capture starts from the first
// request; breakpoint definitions persist per-origin so they can be re-armed
// before the app bootstraps.
const CAPTURE_KEY = "captureByOrigin"; // { [origin]: { autoCapture: boolean } }
const PERSISTED_BP_KEY = "breakpointsByOrigin";
const ASYNC_DEPTH_KEY = "asyncStackDepth"; // global setting
const DEFAULT_ASYNC_DEPTH = 64; // lifecycle→service→RxJS→fetch chains are deep
let asyncDepth = DEFAULT_ASYNC_DEPTH;
let autoCapture = false; // loaded per-origin on attach
let alreadyLoaded = false; // attached to a page that had finished loading
// Suppresses per-mutation persistence writes while re-arming from the store
// (each setBreakpoint call would otherwise overwrite the store with a subset).
let rearming = false;

interface PersistedBreakpoints {
  lines: {
    url: string;
    lineNumber: number;
    columnNumber?: number;
    originalLabel?: string;
    tag?: string;
  }[];
  xhr: string[];
  gqlOps: GqlOpBreakpointInfo[];
}

function post(msg: BgToPanel) {
  port?.postMessage(msg);
}

function pushStatus(error?: string) {
  post({
    type: "status",
    attached: attachedTabId !== null,
    tabId: attachedTabId,
    tabTitle: attachedTabTitle,
    error,
    alreadyLoaded,
    autoCapture,
    asyncDepth,
  });
}

function pushBreakpoints() {
  post({
    type: "breakpoints",
    breakpoints: [...breakpoints.values()],
    xhrBreakpoints: [...xhrBreakpoints],
    eventBreakpoints: [...eventBreakpoints.values()],
    functionBreakpoints: [...functionBreakpoints.values()],
    gqlOpBreakpoints: [...gqlOpBreakpoints.values()],
  });
}

// The CDP async stack is a linked list: each node has callFrames plus an
// optional parent node, which may carry a description like "Promise.then" or
// "setTimeout" naming the async boundary it crossed.
function flattenStack(stack?: StackNode): CallFrame[] {
  const frames: CallFrame[] = [];
  let node: StackNode | undefined = stack;
  while (node) {
    if (node.description) {
      // synthetic separator frame so the UI can show the async boundary
      frames.push({
        functionName: `[async: ${node.description}]`,
        scriptId: "",
        url: "",
        lineNumber: 0,
        columnNumber: 0,
      });
    }
    if (Array.isArray(node.callFrames)) frames.push(...node.callFrames);
    node = node.parent;
  }
  return frames;
}

function buildInitiatorFrames(initiator?: Initiator): CallFrame[] {
  if (initiator?.stack) return flattenStack(initiator.stack);
  // Parser-initiated requests carry url/lineNumber directly on the initiator.
  if (initiator?.type === "parser" && initiator.url) {
    return [
      {
        functionName: "(parser)",
        scriptId: "",
        url: initiator.url,
        lineNumber: initiator.lineNumber ?? 0,
        columnNumber: 0,
      },
    ];
  }
  return [];
}

function clearRequests() {
  requests.clear();
  post({ type: "requests-cleared" });
}

function clearDebugSessionState() {
  breakpoints.clear();
  xhrBreakpoints.clear();
  eventBreakpoints.clear();
  functionBreakpoints.clear();
  // The new-document script and armed targets die with the CDP session; the
  // live fetch/XHR patch is restored (best-effort) by teardownGqlHookInPage
  // before a voluntary detach, or by the next page reload otherwise.
  gqlOpBreakpoints.clear();
  gqlHookScriptId = null;
  gqlHookInstalled = false;
  scripts.clear();
  mainFrameId = null;
  pageUrl = undefined;
  contextFrames.clear();
  if (pausedState) {
    pausedState = null;
    post({ type: "resumed" }); // execution is effectively released
  }
  pushBreakpoints();
}

async function attach(tabId: number) {
  if (attachedTabId !== null) {
    pushStatus();
    return;
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
    await chrome.debugger.sendCommand({ tabId }, "Debugger.enable");
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    await chrome.debugger.sendCommand({ tabId }, "Page.enable"); // screenshots (M5)
    // Without this, initiator stacks stop at the synchronous frames — no
    // await / .then() / setTimeout chain. Depth is user-configurable (M7):
    // lifecycle chains (hook → service → RxJS → fetch) need more than the
    // old default of 32; higher values cost performance.
    asyncDepth = await loadAsyncDepth();
    await chrome.debugger.sendCommand({ tabId }, "Debugger.setAsyncCallStackDepth", {
      maxDepth: asyncDepth,
    });
    attachedTabId = tabId;
    // Main frame id + URL: needed for page-context resource fetches
    // (Network.loadNetworkResource) and mixed-content diagnosis.
    try {
      const tree = (await chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree")) as {
        frameTree: { frame: { id: string; url?: string } };
      };
      mainFrameId = tree.frameTree.frame.id;
      pageUrl = tree.frameTree.frame.url;
    } catch {
      mainFrameId = null; // loadNetworkResource still works frameless in most Chromes
    }
    // Blackbox patterns are per-session; re-apply the last set on re-attach.
    if (blackboxPatterns.length > 0) void applyBlackboxPatterns(blackboxPatterns);
    try {
      attachedTabTitle = (await chrome.tabs.get(tabId)).title;
    } catch {
      attachedTabTitle = undefined;
    }
    // M7: if the page already finished loading, its init-time requests fired
    // before we attached — the panel shows a "Reload & capture" hint.
    alreadyLoaded = await detectAlreadyLoaded();
    autoCapture = await loadAutoCapture();
    if (autoCapture) {
      await rearmPersistedBreakpoints();
      await syncGqlHook();
    }
    pushStatus();
  } catch (e) {
    pushStatus(e instanceof Error ? e.message : String(e));
  }
}

async function detectAlreadyLoaded(): Promise<boolean> {
  try {
    const res = await sendCdp<{ result: RemoteObject }>("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    return res.result?.value === "interactive" || res.result?.value === "complete";
  } catch {
    return false;
  }
}

async function loadAsyncDepth(): Promise<number> {
  try {
    const stored = await chrome.storage.local.get(ASYNC_DEPTH_KEY);
    const depth = Number(stored[ASYNC_DEPTH_KEY]);
    return Number.isInteger(depth) && depth > 0 ? Math.min(depth, 256) : DEFAULT_ASYNC_DEPTH;
  } catch {
    return DEFAULT_ASYNC_DEPTH;
  }
}

async function loadAutoCapture(): Promise<boolean> {
  const origin = await getTabOrigin();
  if (!origin) return false;
  try {
    const stored = await chrome.storage.local.get(CAPTURE_KEY);
    const byOrigin = (stored[CAPTURE_KEY] ?? {}) as Record<string, { autoCapture?: boolean }>;
    return byOrigin[origin]?.autoCapture === true;
  } catch {
    return false;
  }
}

async function detach() {
  if (attachedTabId === null) return;
  await teardownGqlHookInPage(); // needs the live attachment; must run first
  const tabId = attachedTabId;
  attachedTabId = null;
  attachedTabTitle = undefined;
  alreadyLoaded = false;
  autoCapture = false;
  clearRequests();
  clearDebugSessionState();
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Tab already closed or debugger already detached — nothing to clean up.
  }
  pushStatus();
}

async function reattachActiveTab() {
  await detach();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    pushStatus("No active tab to attach to");
    return;
  }
  await attach(tab.id);
}

// ---- CDP command wrappers (all no-op when not attached) ----

function sendCdp<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  if (attachedTabId === null) return Promise.reject(new Error("Not attached"));
  return chrome.debugger.sendCommand(
    { tabId: attachedTabId },
    method,
    params,
  ) as unknown as Promise<T>;
}

async function setBreakpoint(msg: {
  url: string;
  scriptId?: string;
  lineNumber: number;
  columnNumber?: number;
  originalLabel?: string;
  tag?: string;
}) {
  try {
    if (!msg.url && msg.scriptId) {
      // Eval'd/anonymous scripts (webpack eval builds) have no URL that
      // setBreakpointByUrl could match — bind by scriptId. Dies with the
      // document (scriptIds are per-load), so it's session-only by nature.
      const result = await sendCdp<{ breakpointId: string }>("Debugger.setBreakpoint", {
        location: {
          scriptId: msg.scriptId,
          lineNumber: msg.lineNumber,
          ...(msg.columnNumber !== undefined ? { columnNumber: msg.columnNumber } : {}),
        },
      });
      breakpoints.set(result.breakpointId, {
        breakpointId: result.breakpointId,
        url: scripts.get(msg.scriptId)?.url ?? "",
        lineNumber: msg.lineNumber,
        columnNumber: msg.columnNumber,
        originalLabel: msg.originalLabel,
        tag: msg.tag,
        bound: true, // setBreakpoint binds immediately or throws
      });
      pushBreakpoints();
      return;
    }
    const result = await sendCdp<SetBreakpointResult>("Debugger.setBreakpointByUrl", {
      url: msg.url,
      lineNumber: msg.lineNumber,
      ...(msg.columnNumber !== undefined ? { columnNumber: msg.columnNumber } : {}),
    });
    breakpoints.set(result.breakpointId, {
      breakpointId: result.breakpointId,
      url: msg.url,
      lineNumber: msg.lineNumber,
      columnNumber: msg.columnNumber,
      originalLabel: msg.originalLabel,
      tag: msg.tag,
      // Empty locations = didn't bind yet (script not loaded); it may still
      // bind later via Debugger.breakpointResolved.
      bound: result.locations.length > 0,
    });
    pushBreakpoints();
    void persistSessionBreakpoints();
  } catch (e) {
    post({
      type: "breakpoint-error",
      error: `Failed to set breakpoint: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function removeBreakpoint(breakpointId: string) {
  breakpoints.delete(breakpointId);
  try {
    await sendCdp("Debugger.removeBreakpoint", { breakpointId });
  } catch {
    // already gone (detached / navigated) — list state is what matters
  }
  pushBreakpoints();
  void persistSessionBreakpoints();
}

async function setXhrBreakpoint(url: string) {
  try {
    await sendCdp("DOMDebugger.setXHRBreakpoint", { url });
    xhrBreakpoints.add(url);
    pushBreakpoints();
    void persistSessionBreakpoints();
  } catch (e) {
    post({
      type: "breakpoint-error",
      error: `Failed to set XHR breakpoint: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function removeXhrBreakpoint(url: string) {
  xhrBreakpoints.delete(url);
  try {
    await sendCdp("DOMDebugger.removeXHRBreakpoint", { url });
  } catch {
    // already gone
  }
  pushBreakpoints();
  void persistSessionBreakpoints();
}

// ---- M7: per-origin breakpoint persistence & re-arm ----
// Line/XHR/GraphQL-op breakpoint DEFINITIONS survive the session so "Reload &
// capture" (and auto-capture) can arm them before the app bootstraps. Event
// and function-call breakpoints are not persisted — the latter bind to live
// function objects that don't survive a load.

async function readPersistedStore(): Promise<Record<string, PersistedBreakpoints>> {
  const stored = await chrome.storage.local.get(PERSISTED_BP_KEY);
  return (stored[PERSISTED_BP_KEY] ?? {}) as Record<string, PersistedBreakpoints>;
}

/** Snapshot the current session's re-armable breakpoints into storage. */
async function persistSessionBreakpoints() {
  if (rearming) return; // re-arm is *reading* the store; don't overwrite mid-loop
  const origin = await getTabOrigin();
  if (!origin) return;
  try {
    const store = await readPersistedStore();
    store[origin] = {
      // scriptId-bound breakpoints (url "") can't be re-armed across loads —
      // scriptIds are per-document — so they're not persisted.
      lines: [...breakpoints.values()]
        .filter((b) => b.url)
        .map((b) => ({
        url: b.url,
        lineNumber: b.lineNumber,
        columnNumber: b.columnNumber,
        originalLabel: b.originalLabel,
        tag: b.tag,
      })),
      xhr: [...xhrBreakpoints],
      gqlOps: [...gqlOpBreakpoints.values()],
    };
    await chrome.storage.local.set({ [PERSISTED_BP_KEY]: store });
  } catch {
    // persistence is best-effort; the live session state is authoritative
  }
}

/** Arm everything persisted for this origin that isn't already armed. */
async function rearmPersistedBreakpoints() {
  const origin = await getTabOrigin();
  if (!origin) return;
  let persisted: PersistedBreakpoints | undefined;
  try {
    persisted = (await readPersistedStore())[origin];
  } catch {
    return;
  }
  if (!persisted) return;
  rearming = true;
  try {
    const armedLines = new Set(
      [...breakpoints.values()].map((b) => `${b.url}\n${b.lineNumber}\n${b.columnNumber ?? ""}`),
    );
    for (const line of persisted.lines ?? []) {
      const key = `${line.url}\n${line.lineNumber}\n${line.columnNumber ?? ""}`;
      if (!armedLines.has(key)) await setBreakpoint(line);
    }
    for (const url of persisted.xhr ?? []) {
      if (!xhrBreakpoints.has(url)) await setXhrBreakpoint(url);
    }
    let gqlChanged = false;
    for (const op of persisted.gqlOps ?? []) {
      if (!gqlOpBreakpoints.has(op.target)) {
        gqlOpBreakpoints.set(op.target, op);
        gqlChanged = true;
      }
    }
    if (gqlChanged) {
      pushBreakpoints();
      await syncGqlHook();
    }
  } finally {
    rearming = false;
  }
}

/**
 * M7 "Reload & capture": guarantee the debugger is armed BEFORE the app
 * bootstraps. Attach if needed (attach already enables all domains, applies
 * async depth + blackbox), re-arm persisted breakpoints, install in-page
 * hooks, then reload — so capture starts from the very first request and
 * pre-load breakpoints sit pending until their scripts parse.
 */
async function reloadAndCapture() {
  try {
    if (attachedTabId === null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) {
        pushStatus("No active tab to attach to");
        return;
      }
      await attach(tab.id);
      if (attachedTabId === null) return; // attach failed; status already pushed
    }
    await rearmPersistedBreakpoints();
    await syncGqlHook(); // (re)registers the new-document GraphQL hook
    clearRequests();
    alreadyLoaded = false;
    pushStatus();
    await sendCdp("Page.reload", { ignoreCache: false });
  } catch (e) {
    pushStatus(e instanceof Error ? e.message : String(e));
  }
}

async function setAutoCapture(enabled: boolean) {
  autoCapture = enabled;
  const origin = await getTabOrigin();
  if (origin) {
    try {
      const stored = await chrome.storage.local.get(CAPTURE_KEY);
      const byOrigin = (stored[CAPTURE_KEY] ?? {}) as Record<string, { autoCapture?: boolean }>;
      byOrigin[origin] = { autoCapture: enabled };
      await chrome.storage.local.set({ [CAPTURE_KEY]: byOrigin });
    } catch {
      // toggle still applies for this session
    }
  }
  if (enabled && attachedTabId !== null) {
    await rearmPersistedBreakpoints();
    await syncGqlHook();
  }
  pushStatus();
}

async function setAsyncDepth(maxDepth: number) {
  if (!Number.isInteger(maxDepth) || maxDepth < 1) return;
  asyncDepth = Math.min(maxDepth, 256);
  try {
    await chrome.storage.local.set({ [ASYNC_DEPTH_KEY]: asyncDepth });
  } catch {
    // applies for this session regardless
  }
  if (attachedTabId !== null) {
    try {
      await sendCdp("Debugger.setAsyncCallStackDepth", { maxDepth: asyncDepth });
    } catch (e) {
      pushStatus(e instanceof Error ? e.message : String(e));
    }
  }
  pushStatus();
}

// ---- M6 patch: GraphQL operation-scoped breakpoints (see gqlHook.ts) ----

/**
 * Reconcile the in-page hook with the armed target set, two ways:
 * - re-register the Page.addScriptToEvaluateOnNewDocument script with the
 *   targets baked in, so a reload installs the hook (already armed) before any
 *   page script can capture window.fetch;
 * - Runtime.evaluate the same source immediately so the current page is
 *   patched live (works for clients that call window.fetch at request time).
 */
async function syncGqlHook() {
  const targets = [...gqlOpBreakpoints.keys()];
  try {
    if (gqlHookScriptId !== null) {
      const identifier = gqlHookScriptId;
      gqlHookScriptId = null;
      await sendCdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
    if (targets.length > 0) {
      const { identifier } = await sendCdp<{ identifier: string }>(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: buildGqlHookSource(targets) },
      );
      gqlHookScriptId = identifier;
      await sendCdp("Runtime.evaluate", { expression: buildGqlHookSource(targets) });
      gqlHookInstalled = true;
    } else if (gqlHookInstalled) {
      // Nothing armed: leave the (now inert) wrappers in place, clear targets.
      await sendCdp("Runtime.evaluate", {
        expression:
          "window.__aiDevtoolsGqlHook && window.__aiDevtoolsGqlHook.setTargets([])",
      });
    }
  } catch (e) {
    post({
      type: "breakpoint-error",
      error: `GraphQL operation breakpoint: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function setGqlOpBreakpoint(target: string, label: string) {
  gqlOpBreakpoints.set(target, { target, label });
  pushBreakpoints();
  void persistSessionBreakpoints();
  await syncGqlHook();
}

async function removeGqlOpBreakpoint(target: string) {
  gqlOpBreakpoints.delete(target);
  pushBreakpoints();
  void persistSessionBreakpoints();
  await syncGqlHook();
}

/**
 * Restore the page's original fetch/XHR before letting go of the tab. The
 * new-document registration dies with the CDP session automatically, but a
 * live monkey-patch would outlive us until the next reload.
 */
async function teardownGqlHookInPage() {
  if (!gqlHookInstalled) return;
  gqlHookInstalled = false;
  try {
    // Runtime.evaluate queues while paused — release execution first (the
    // detach would resume it anyway).
    if (pausedState !== null) await sendCdp("Debugger.resume");
    await sendCdp("Runtime.evaluate", {
      expression:
        "window.__aiDevtoolsGqlHook && window.__aiDevtoolsGqlHook.uninstall()",
    });
  } catch {
    // best-effort — a reload cleans the page anyway
  }
}

/**
 * The exact matched operation names live in the sentinel frame's `matched`
 * local; read them while paused and refresh the pause detail (which starts as
 * the full armed-target list).
 */
async function refineGqlPauseDetail(callFrameId: string) {
  const state = pausedState;
  if (!state) return;
  try {
    const res = await sendCdp<{ result: RemoteObject }>(
      "Debugger.evaluateOnCallFrame",
      { callFrameId, expression: "matched.join(', ')", returnByValue: true },
    );
    const names = typeof res.result?.value === "string" ? res.result.value : "";
    if (names && pausedState === state) {
      state.detail = names;
      post({ type: "paused", state });
    }
  } catch {
    // keep the armed-target fallback detail
  }
}

// ---- M4 patch: interaction breakpoints ----

async function setEventBreakpoint(eventName: string, oneShot: boolean) {
  try {
    await sendCdp("DOMDebugger.setEventListenerBreakpoint", { eventName });
    eventBreakpoints.set(eventName, { eventName, oneShot });
    pushBreakpoints();
  } catch (e) {
    post({
      type: "breakpoint-error",
      error: `Failed to set event breakpoint: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function removeEventBreakpoint(eventName: string) {
  eventBreakpoints.delete(eventName);
  try {
    await sendCdp("DOMDebugger.removeEventListenerBreakpoint", { eventName });
  } catch {
    // already gone
  }
  pushBreakpoints();
}

interface GetEventListenersResult {
  listeners: {
    type: string;
    useCapture: boolean;
    handler?: { objectId?: string; description?: string };
  }[];
}

/** Evaluate `expression`, and if it yields a node, collect its listeners. */
async function collectListenersAt(
  expression: string,
  eventType: string,
  origin: ListenerInfo["origin"],
  out: ListenerInfo[],
): Promise<boolean> {
  const evalRes = await sendCdp<{ result: RemoteObject }>("Runtime.evaluate", {
    expression,
  });
  const node = evalRes.result;
  if (!node?.objectId) return false;
  try {
    const { listeners } = await sendCdp<GetEventListenersResult>(
      "DOMDebugger.getEventListeners",
      { objectId: node.objectId },
    );
    for (const l of listeners) {
      if (l.type !== eventType) continue;
      out.push({
        type: l.type,
        useCapture: l.useCapture,
        handlerObjectId: l.handler?.objectId,
        description: (l.handler?.description ?? "(unknown handler)").slice(0, 200),
        node: node.description ?? origin,
        origin,
      });
    }
  } catch {
    // getEventListeners can fail on exotic nodes — treat as "none here"
  }
  return true;
}

// ---- M4 enhancement: framework detection + handler extraction ----
// Everything here runs in the PAGE'S MAIN WORLD via Runtime.evaluate /
// Runtime.callFunctionOn — framework internals (__reactProps$, ng,
// __vueParentComponent) are invisible to content-script isolated worlds.

const FRAMEWORK_KEY = "frameworkByOrigin";

interface FrameworkStoreEntry {
  override?: FrameworkId;
  detected?: { framework: FrameworkId | "unknown"; confidence: "high" | "low" };
}

async function getTabOrigin(): Promise<string | null> {
  if (attachedTabId === null) return null;
  try {
    const tab = await chrome.tabs.get(attachedTabId);
    return tab.url ? new URL(tab.url).origin : null;
  } catch {
    return null;
  }
}

async function readFrameworkStore(): Promise<Record<string, FrameworkStoreEntry>> {
  const stored = await chrome.storage.local.get(FRAMEWORK_KEY);
  return (stored[FRAMEWORK_KEY] ?? {}) as Record<string, FrameworkStoreEntry>;
}

const DETECT_PROBE = `(() => {
  const els = Array.from(document.querySelectorAll("*")).slice(0, 300);
  const anyKey = (re) => els.some((el) => Object.keys(el).some((k) => re.test(k)));
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if ((hook && hook.renderers && hook.renderers.size > 0) ||
      anyKey(/^__reactFiber\\$|^__reactProps\\$/)) {
    return { framework: "react", confidence: "high" };
  }
  if (window.ng || document.querySelector("[ng-version]") || anyKey(/^__ngContext__$/)) {
    return { framework: "angular", confidence: "high" };
  }
  if (window.__VUE__ ||
      els.some((el) => el.__vueParentComponent || el.__vnode || el.__vue__)) {
    return { framework: "vue", confidence: "high" };
  }
  return { framework: "vanilla", confidence: "low" };
})()`;

async function detectFramework(): Promise<FrameworkStoreEntry["detected"]> {
  try {
    const res = await sendCdp<{ result: RemoteObject }>("Runtime.evaluate", {
      expression: DETECT_PROBE,
      returnByValue: true,
    });
    const value = res.result?.value as
      | { framework: FrameworkId; confidence: "high" | "low" }
      | undefined;
    return value ?? { framework: "unknown", confidence: "low" };
  } catch {
    return { framework: "unknown", confidence: "low" };
  }
}

/** Override always wins; else cached detection; else probe once and cache. */
async function resolveFramework(requestToken: number) {
  const origin = await getTabOrigin();
  const store = await readFrameworkStore();
  const entry = origin ? store[origin] : undefined;
  let resolution: FrameworkResolution;
  if (entry?.override) {
    resolution = { framework: entry.override, confidence: "high", source: "override" };
  } else if (entry?.detected) {
    resolution = { ...entry.detected, source: "detected" };
  } else {
    const detected = (await detectFramework())!;
    if (origin) {
      store[origin] = { ...entry, detected };
      await chrome.storage.local.set({ [FRAMEWORK_KEY]: store });
    }
    resolution = { ...detected, source: "detected" };
  }
  post({ type: "framework", requestToken, resolution });
}

async function setFrameworkOverride(
  framework: FrameworkId | "auto",
  requestToken: number,
) {
  const origin = await getTabOrigin();
  if (origin) {
    const store = await readFrameworkStore();
    const entry = store[origin] ?? {};
    if (framework === "auto") {
      // Reset: forget the manual choice AND stale detection so we re-probe.
      delete entry.override;
      delete entry.detected;
    } else {
      entry.override = framework;
    }
    store[origin] = entry;
    await chrome.storage.local.set({ [FRAMEWORK_KEY]: store });
  }
  await resolveFramework(requestToken);
}

// Per-framework extraction functions, evaluated with the picked element as
// `this`. Each walks up the ancestor chain (delegation can bind the handler
// prop above the picked node) and returns the developer's handler function
// by reference, or null.
const ADAPTER_DECLARATIONS: Record<Exclude<FrameworkId, "vanilla">, string> = {
  react: `function(eventType) {
    const map = { click: "onClick", submit: "onSubmit", change: "onChange",
      input: "onInput", keydown: "onKeyDown", keyup: "onKeyUp",
      mousedown: "onMouseDown", focus: "onFocus", blur: "onBlur" };
    const propName = map[eventType] ||
      "on" + eventType.charAt(0).toUpperCase() + eventType.slice(1);
    let node = this;
    for (let i = 0; node && i < 15; i++, node = node.parentElement) {
      const keys = Object.keys(node);
      const propsKey = keys.find((k) => k.indexOf("__reactProps$") === 0);
      if (propsKey && node[propsKey] && typeof node[propsKey][propName] === "function") {
        return node[propsKey][propName];
      }
      const fiberKey = keys.find((k) => k.indexOf("__reactFiber$") === 0);
      if (fiberKey) {
        let fiber = node[fiberKey];
        for (let d = 0; fiber && d < 10; d++, fiber = fiber.return) {
          const props = fiber.memoizedProps;
          if (props && typeof props[propName] === "function") return props[propName];
        }
      }
    }
    return null;
  }`,
  angular: `function(eventType) {
    const ng = window.ng;
    if (!ng || typeof ng.getListeners !== "function") return null;
    let node = this;
    for (let i = 0; node && i < 15; i++, node = node.parentElement) {
      try {
        const listeners = ng.getListeners(node) || [];
        const match = listeners.find(
          (l) => l.name === eventType && typeof l.callback === "function");
        if (match) return match.callback;
      } catch (e) {}
    }
    return null;
  }`,
  vue: `function(eventType) {
    const propName = "on" + eventType.charAt(0).toUpperCase() + eventType.slice(1);
    let node = this;
    for (let i = 0; node && i < 15; i++, node = node.parentElement) {
      const vnodeProps = (node.__vnode && node.__vnode.props) ||
        (node.__vueParentComponent && node.__vueParentComponent.vnode &&
         node.__vueParentComponent.vnode.props);
      if (vnodeProps) {
        const h = vnodeProps[propName];
        if (typeof h === "function") return h;
        if (Array.isArray(h) && typeof h[0] === "function") return h[0];
      }
      const vue2 = node.__vue__;
      if (vue2 && vue2.$listeners && typeof vue2.$listeners[eventType] === "function") {
        return vue2.$listeners[eventType];
      }
    }
    return null;
  }`,
};

const ADAPTER_VIA: Record<Exclude<FrameworkId, "vanilla">, string> = {
  react: "React props (onEvent)",
  angular: "ng.getListeners",
  vue: "Vue vnode props",
};

interface InternalPropsResult {
  internalProperties?: {
    name: string;
    value?: {
      objectId?: string;
      value?: { scriptId: string; lineNumber: number; columnNumber: number };
    };
  }[];
}

/**
 * Unwrap bound functions ([[TargetFunction]]) so the breakpoint arms on the
 * real body, then read [[FunctionLocation]] for display.
 */
async function resolveHandlerFunction(
  objectId: string,
  depth = 0,
): Promise<{ objectId: string; location: { scriptId: string; lineNumber: number; columnNumber: number } | null }> {
  try {
    const props = await sendCdp<InternalPropsResult>("Runtime.getProperties", {
      objectId,
      ownProperties: true,
    });
    const internals = props.internalProperties ?? [];
    const target = internals.find((p) => p.name === "[[TargetFunction]]")?.value
      ?.objectId;
    if (target && depth < 3) return resolveHandlerFunction(target, depth + 1);
    const location =
      internals.find((p) => p.name === "[[FunctionLocation]]")?.value?.value ?? null;
    return { objectId, location };
  } catch {
    return { objectId, location: null };
  }
}

async function extractHandler(
  selector: string,
  eventType: string,
  framework: FrameworkId,
  requestToken: number,
) {
  try {
    const evalRes = await sendCdp<{ result: RemoteObject }>("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
    });
    const elementObjectId = evalRes.result?.objectId;
    if (!elementObjectId) throw new Error("Element not found — it may have been removed");

    const candidates: ExtractedHandler[] = [];
    if (framework === "vanilla") {
      // Real attached listeners; walk ancestors/document for delegation.
      const out: ListenerInfo[] = [];
      let expression = `document.querySelector(${JSON.stringify(selector)})`;
      await collectListenersAt(expression, eventType, "element", out);
      for (let depth = 0; depth < 15 && out.length === 0; depth++) {
        expression += ".parentElement";
        if (!(await collectListenersAt(expression, eventType, "ancestor", out))) break;
      }
      if (out.length === 0) {
        await collectListenersAt("document", eventType, "document", out);
      }
      for (const l of out) {
        if (!l.handlerObjectId) continue;
        candidates.push({
          handlerObjectId: l.handlerObjectId,
          description: l.description,
          via: `addEventListener on ${l.node}${l.useCapture ? " (capture)" : ""}`,
        });
      }
    } else {
      const res = await sendCdp<{ result: RemoteObject }>("Runtime.callFunctionOn", {
        objectId: elementObjectId,
        functionDeclaration: ADAPTER_DECLARATIONS[framework],
        arguments: [{ value: eventType }],
        returnByValue: false,
      });
      const fn = res.result;
      if (fn?.type === "function" && fn.objectId) {
        candidates.push({
          handlerObjectId: fn.objectId,
          description: (fn.description ?? "(function)").slice(0, 200),
          via: ADAPTER_VIA[framework],
        });
      }
    }

    // Enrich with the real function body + [[FunctionLocation]] for display.
    for (const candidate of candidates) {
      const resolved = await resolveHandlerFunction(candidate.handlerObjectId);
      candidate.handlerObjectId = resolved.objectId;
      if (resolved.location) {
        candidate.scriptId = resolved.location.scriptId;
        candidate.url = scripts.get(resolved.location.scriptId)?.url;
        candidate.lineNumber = resolved.location.lineNumber;
        candidate.columnNumber = resolved.location.columnNumber;
      }
    }
    post({ type: "handler-candidates", requestToken, candidates });
  } catch (e) {
    post({
      type: "handler-candidates",
      requestToken,
      candidates: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

let blackboxPatterns: string[] = [];

async function applyBlackboxPatterns(patterns: string[]) {
  blackboxPatterns = patterns;
  try {
    await sendCdp("Debugger.setBlackboxPatterns", { patterns });
  } catch (e) {
    post({
      type: "breakpoint-error",
      error: `Blackbox patterns failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function setFunctionBreakpoint(handlerObjectId: string, label: string) {
  try {
    const { breakpointId } = await sendCdp<{ breakpointId: string }>(
      "Debugger.setBreakpointOnFunctionCall",
      { objectId: handlerObjectId },
    );
    functionBreakpoints.set(breakpointId, { id: breakpointId, label });
    pushBreakpoints();
  } catch (e) {
    post({
      type: "breakpoint-error",
      error: `Failed to break on handler: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function removeFunctionBreakpoint(id: string) {
  functionBreakpoints.delete(id);
  try {
    // Debugger.removeBreakpoint accepts function-call breakpoint ids in
    // current Chrome; if a given version ignores it, the breakpoint dies with
    // the page/session anyway — our list state is authoritative for the UI.
    await sendCdp("Debugger.removeBreakpoint", { breakpointId: id });
  } catch {
    // already gone
  }
  pushBreakpoints();
}

/** Resume/step are only valid while paused — no-op otherwise. */
async function debuggerCommand(method: string) {
  if (pausedState === null) return;
  try {
    await sendCdp(method);
  } catch (e) {
    pushStatus(e instanceof Error ? e.message : String(e));
  }
}

async function getProperties(objectId: string, requestToken: number) {
  try {
    const result = await sendCdp<GetPropertiesResult>("Runtime.getProperties", {
      objectId,
      ownProperties: true,
      generatePreview: true,
    });
    const properties: RemoteProperty[] = result.result.map((p) => {
      const v = p.value;
      const type = v ? (v.subtype ? `${v.type} (${v.subtype})` : v.type) : "unknown";
      const description =
        v?.description ?? (v && "value" in v ? JSON.stringify(v.value) : undefined);
      return { name: p.name, type, description, objectId: v?.objectId };
    });
    post({ type: "properties", requestToken, properties });
  } catch (e) {
    post({
      type: "properties",
      requestToken,
      properties: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---- M5: screenshots / picker / sources ----

/**
 * Images inflate token cost; cap width at ~1500px before they reach a model.
 * MV3 service workers have createImageBitmap + OffscreenCanvas.
 */
async function maybeDownscale(base64Png: string): Promise<string> {
  const dataUrl = `data:image/png;base64,${base64Png}`;
  try {
    const binary = atob(base64Png);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    if (bitmap.width <= 1500) return dataUrl;
    const scale = 1500 / bitmap.width;
    const canvas = new OffscreenCanvas(
      Math.round(bitmap.width * scale),
      Math.round(bitmap.height * scale),
    );
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let out = "";
    for (let i = 0; i < buffer.length; i += 0x8000) {
      out += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
    }
    return `data:image/png;base64,${btoa(out)}`;
  } catch {
    return dataUrl; // downscaling is best-effort
  }
}

async function captureScreenshot(
  mode: ScreenshotMode,
  clip: { x: number; y: number; width: number; height: number } | undefined,
  requestToken: number,
) {
  try {
    const params: Record<string, unknown> = { format: "png" };
    if (mode === "fullpage") params.captureBeyondViewport = true;
    if (mode === "clip") {
      if (!clip || clip.width < 1 || clip.height < 1) {
        throw new Error("No element bounds to clip");
      }
      // Clip coords are page-absolute; captureBeyondViewport lets the clip
      // land outside the current scroll position.
      params.captureBeyondViewport = true;
      params.clip = { ...clip, scale: 1 };
    }
    const { data } = await sendCdp<{ data: string }>("Page.captureScreenshot", params);
    post({ type: "screenshot", requestToken, dataUrl: await maybeDownscale(data) });
  } catch (e) {
    post({
      type: "screenshot",
      requestToken,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function activatePicker() {
  if (attachedTabId === null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: attachedTabId },
      func: pickerScript,
    });
  } catch (e) {
    post({
      type: "breakpoint-error",
      error: `Element picker failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

// ---- Source-map fetch, the way DevTools does it (page network context) ----

/** Drain a CDP IO stream (from Network.loadNetworkResource) to a string. */
async function readCdpStream(handle: string): Promise<string> {
  let text = "";
  let base64 = "";
  try {
    for (;;) {
      const chunk = await sendCdp<{ data: string; base64Encoded?: boolean; eof: boolean }>(
        "IO.read",
        { handle },
      );
      if (chunk.base64Encoded) base64 += chunk.data;
      else text += chunk.data;
      if (chunk.eof) break;
    }
  } finally {
    void sendCdp("IO.close", { handle }).catch(() => {});
  }
  if (base64) {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return text + new TextDecoder().decode(bytes);
  }
  return text;
}

/**
 * HTTPS container loading an HTTP map is blocked as mixed content — except
 * localhost/loopback, which browsers treat as potentially trustworthy (the
 * common MFE dev setup: HTTPS container + http://localhost remote is fine).
 */
function isMixedContent(page: string | undefined, resourceUrl: string): boolean {
  if (!page) return false;
  try {
    const p = new URL(page);
    const r = new URL(resourceUrl);
    if (p.protocol !== "https:" || r.protocol !== "http:") return false;
    return !["localhost", "127.0.0.1", "[::1]"].includes(r.hostname);
  } catch {
    return false;
  }
}

interface PageResourceOutcome {
  ok: boolean;
  content?: string;
  httpStatus?: number;
  netError?: string;
}

/** Self-signed/untrusted dev certs (the common `https://localhost:PORT` MFE
 * remote case) surface as one of these net error names — distinct and
 * actionable from a generic fetch failure. */
function isTlsError(netError: string | undefined): boolean {
  return !!netError && /ERR_CERT_|ERR_SSL_|ERR_BAD_SSL_CLIENT_AUTH_CERT/i.test(netError);
}

/** Fetch via CDP in a SPECIFIC frame's network context (cookies/credentials
 * of that frame — not necessarily the top frame). */
async function loadViaCdp(url: string, frameId: string | null): Promise<PageResourceOutcome> {
  try {
    const res = await sendCdp<LoadNetworkResourceResult>("Network.loadNetworkResource", {
      ...(frameId ? { frameId } : {}),
      url,
      options: { disableCache: false, includeCredentials: true },
    });
    const r = res.resource;
    if (r.success && r.stream) {
      return { ok: true, content: await readCdpStream(r.stream) };
    }
    return {
      ok: false,
      httpStatus: r.httpStatusCode,
      netError:
        r.netErrorName ?? (r.netError !== undefined ? `net error ${r.netError}` : undefined),
    };
  } catch (e) {
    return { ok: false, netError: e instanceof Error ? e.message : String(e) };
  }
}

/** The service worker's own fetch — not subject to the PAGE's CSP or
 * mixed-content rules, so it can often reach a local dev server the page
 * context can't (and vice versa — kept as one option among several, never
 * the only one). */
async function workerFetch(url: string): Promise<PageResourceOutcome> {
  try {
    const resp = await fetch(url, { credentials: "include" });
    if (resp.ok) return { ok: true, content: await resp.text() };
    return { ok: false, httpStatus: resp.status };
  } catch (e) {
    return { ok: false, netError: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Fetch a URL in the PAGE's network context via CDP — with the page's
 * cookies/credentials, exactly like DevTools fetches source maps. This is
 * what makes maps on authenticated hosts resolve; a panel/extension-origin
 * fetch() has no page credentials and silently 401s. Used for the (simpler,
 * non-map) original-source fetch path — source maps go through the fuller
 * strategy chain in fetchSourceMapFor below.
 */
async function loadPageResource(url: string): Promise<PageResourceOutcome> {
  const viaCdp = await loadViaCdp(url, mainFrameId);
  if (viaCdp.ok) return viaCdp;
  return workerFetch(url);
}

/** executionContextId -> frameId, when Runtime.executionContextCreated told us. */
function frameForScript(script: ScriptInfo): string | null {
  if (script.executionContextId === undefined) return null;
  return contextFrames.get(script.executionContextId) ?? null;
}

// Last-resort discovery (strategy 5): scriptParsed carried no sourceMapURL,
// but the script's OWN text might still end in the comment. This does NOT
// replace scriptParsed.sourceMapURL as the primary discovery mechanism —
// script text is fetched here only as a narrow fallback for the specific
// scripts where the event gave us nothing to go on.
const SOURCE_MAPPING_COMMENT_RE = /\/\/[#@][ \t]*sourceMappingURL=([^\s'"]+)[ \t]*$/m;

async function commentScanForMapRef(scriptId: string): Promise<string | null> {
  try {
    const { scriptSource } = await sendCdp<{ scriptSource: string }>(
      "Debugger.getScriptSource",
      { scriptId },
    );
    return SOURCE_MAPPING_COMMENT_RE.exec(scriptSource)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a script's source map to raw JSON, trying each strategy in turn
 * and recording which one worked. Discovery is scriptParsed's sourceMapURL
 * (per-script — every MFE bundle/remote resolves independently) with a
 * comment-scan fallback only when that event gave us nothing; inline data:
 * URIs (webpack eval-source-map) decode locally with no network at all.
 * Every failure returns an explicit reason — never a silent null.
 */
async function fetchSourceMapFor(scriptId: string, requestToken: number) {
  const reply = (result: SourceMapFetchResult) =>
    post({ type: "source-map", requestToken, result });
  const script = scripts.get(scriptId);
  if (!script) {
    return reply({
      ok: false,
      scriptId,
      reason: "no-map",
      message: "Script is no longer in the registry (page navigated?)",
    });
  }
  let ref = script.sourceMapURL;
  let viaCommentScan = false;
  if (!ref) {
    ref = (await commentScanForMapRef(scriptId)) ?? undefined;
    viaCommentScan = !!ref;
  }
  if (!ref) {
    return reply({
      ok: false,
      scriptId,
      reason: "no-map",
      message:
        "Debugger.scriptParsed reported no sourceMapURL for this script, and no //# sourceMappingURL= comment was found in its source",
    });
  }

  // Strategy 1: inline data: URI — no network at all.
  if (ref.startsWith("data:")) {
    const mapUrl = "(inline data: URI)";
    try {
      return reply({
        ok: true,
        scriptId,
        mapUrl,
        inline: true,
        mapJson: decodeDataUri(ref),
        strategy: "inline",
      });
    } catch (e) {
      return reply({
        ok: false,
        scriptId,
        reason: "fetch-failed",
        mapUrl,
        message: `Inline map decode failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // Relative refs resolve against the SCRIPT's own URL, never the page's —
  // essential for MFE, where remote chunks live on a different origin than
  // the container.
  let mapUrl: string;
  try {
    mapUrl = new URL(ref, script.url || undefined).href;
  } catch {
    return reply({
      ok: false,
      scriptId,
      reason: "unresolvable-url",
      message: `Map URL "${ref}" is relative, but the script URL ("${script.url || "(none)"}") is not a resolvable base`,
    });
  }
  if (!/^https?:/.test(mapUrl)) {
    return reply({
      ok: false,
      scriptId,
      reason: "unresolvable-url",
      mapUrl,
      message: `Map URL is not fetchable: ${mapUrl}`,
    });
  }

  // Strategy 2: CDP in the frame that actually loaded the script; retry
  // against the top frame if that frame can't be determined or fails.
  const scriptFrameId = frameForScript(script);
  let out = await loadViaCdp(mapUrl, scriptFrameId ?? mainFrameId);
  let strategy: SourceMapFetchStrategy = viaCommentScan ? "comment-scan" : "cdp-frame";
  if (!out.ok && scriptFrameId && scriptFrameId !== mainFrameId && mainFrameId) {
    const retry = await loadViaCdp(mapUrl, mainFrameId);
    if (retry.ok) {
      out = retry;
      strategy = "cdp-top-frame";
    }
  }
  if (out.ok && out.content !== undefined) {
    return reply({ ok: true, scriptId, mapUrl, inline: false, mapJson: out.content, strategy });
  }

  if (isTlsError(out.netError)) {
    return tlsErrorReply(out.netError);
  }
  if (isMixedContent(pageUrl, mapUrl)) {
    return reply({
      ok: false,
      scriptId,
      reason: "mixed-content",
      mapUrl,
      httpStatus: out.httpStatus,
      netError: out.netError,
      message:
        "Blocked as mixed content: this HTTPS page can't load an HTTP source map. Serve the remote (or its maps) over HTTPS, or use inline maps in dev.",
    });
  }

  // Strategy 4: the service worker's own fetch — a different network/CSP
  // context than the page, and often reaches a local dev server the page
  // context can't (self-signed cert aside — see the TLS check below).
  const workerOut = await workerFetch(mapUrl);
  if (workerOut.ok && workerOut.content !== undefined) {
    return reply({
      ok: true,
      scriptId,
      mapUrl,
      inline: false,
      mapJson: workerOut.content,
      strategy: "worker-fetch",
    });
  }
  if (isTlsError(workerOut.netError)) {
    return tlsErrorReply(workerOut.netError);
  }

  // Every worker-side strategy is exhausted. Strategy 3 (a panel-context
  // fetch — different CORS story than the worker) is attempted by the panel
  // itself (sourceMapResolver.ts) when it receives this failure with a
  // resolved mapUrl, before giving up for good.
  return reply({
    ok: false,
    scriptId,
    reason: "fetch-failed",
    mapUrl,
    httpStatus: workerOut.httpStatus ?? out.httpStatus,
    netError: workerOut.netError ?? out.netError,
    message: (workerOut.httpStatus ?? out.httpStatus)
      ? `Map fetch failed: HTTP ${workerOut.httpStatus ?? out.httpStatus}`
      : `Map fetch failed: ${workerOut.netError ?? out.netError ?? "unknown network error"}`,
  });

  function tlsErrorReply(netError: string | undefined) {
    let origin = mapUrl;
    try {
      origin = new URL(mapUrl).origin;
    } catch {
      // keep the full URL if it somehow doesn't parse here
    }
    return reply({
      ok: false,
      scriptId,
      reason: "tls-error",
      mapUrl,
      netError,
      message: `TLS/cert error fetching the map from ${origin} — open that URL directly in a browser tab and accept the certificate, then retry.`,
    });
  }
}

/** Original-source fetch (map without sourcesContent) — same page-context path. */
async function fetchPageResourceFor(url: string, requestToken: number) {
  const out = await loadPageResource(url);
  if (out.ok) post({ type: "page-resource", requestToken, content: out.content });
  else {
    post({
      type: "page-resource",
      requestToken,
      error: out.httpStatus ? `HTTP ${out.httpStatus}` : out.netError ?? "fetch failed",
    });
  }
}

async function getScriptSource(scriptId: string, requestToken: number) {
  try {
    const { scriptSource } = await sendCdp<{ scriptSource: string }>(
      "Debugger.getScriptSource",
      { scriptId },
    );
    post({ type: "script-source", requestToken, source: scriptSource });
  } catch (e) {
    post({
      type: "script-source",
      requestToken,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// The injected picker reports back over runtime messaging (it has no port).
chrome.runtime.onMessage.addListener((msg: PickerMessage, sender) => {
  if (sender.tab?.id !== attachedTabId) return;
  if (msg.type === "element-picked") post({ type: "element-picked", payload: msg.payload });
  else if (msg.type === "picker-cancelled") post({ type: "picker-cancelled" });
});

// ---- CDP events ----

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== attachedTabId) return;

  switch (method) {
    case "Network.requestWillBeSent": {
      const p = params as unknown as RequestWillBeSentParams;
      const request: CapturedRequest = {
        requestId: p.requestId,
        url: p.request.url,
        method: p.request.method,
        type: p.type,
        timestamp: p.timestamp,
        headers: p.request.headers,
        initiatorType: p.initiator?.type ?? "other",
        initiatorStack: buildInitiatorFrames(p.initiator),
      };
      requests.set(request.requestId, request);
      post({ type: "request-added", request });

      // M6: GraphQL candidate detection / body retrieval. Only candidates run
      // the fetch/parse path; non-GraphQL requests are never slowed down.
      const candidateTabId = source.tabId;
      if (isGraphQLCandidate(request.method, request.url, request.headers) && candidateTabId !== undefined) {
        void (async () => {
          const bodyResult = await getGraphQLBody(
            candidateTabId,
            request.requestId,
            p.request.postData,
            p.request.hasPostData,
          );
          let meta: GraphQLMeta | null;
          if (bodyResult === null) {
            // Body unreachable; still flag it so the shared endpoint doesn't
            // dominate the list with identical URLs.
            meta = nullGraphQLMeta();
          } else {
            meta = parseGraphQLBody(bodyResult.body);
          }
          if (meta) {
            const stored = requests.get(request.requestId);
            if (stored) {
              stored.graphql = meta;
              post({
                type: "request-updated",
                requestId: request.requestId,
                graphql: meta,
              });
            }
          }
        })();
      }
      break;
    }
    case "Network.responseReceived": {
      const p = params as unknown as ResponseReceivedParams;
      const request = requests.get(p.requestId);
      if (!request) return;
      request.status = p.response.status;
      request.mimeType = p.response.mimeType;
      post({
        type: "request-updated",
        requestId: p.requestId,
        status: request.status,
        mimeType: request.mimeType,
      });
      break;
    }
    case "Page.frameNavigated": {
      const p = params as unknown as {
        frame: { id: string; url?: string; parentId?: string };
      };
      if (p.frame.parentId) break; // sub-frames don't reset the session
      // New document: parsed scripts are per-document, and the "already
      // loaded" hint no longer applies — we're attached from the first byte.
      mainFrameId = p.frame.id;
      pageUrl = p.frame.url;
      scripts.clear();
      post({ type: "scripts", scripts: [] }); // diagnostics list resets live
      alreadyLoaded = false;
      if (autoCapture) {
        // Auto-capture: re-assert persisted breakpoints and in-page hooks on
        // every navigation so the user never has to click "Reload & capture".
        // (In-session CDP breakpoints survive navigation; this covers
        // definitions persisted from earlier sessions and the GraphQL hook's
        // target sync.)
        void rearmPersistedBreakpoints().then(() => syncGqlHook());
      }
      pushStatus();
      break;
    }
    case "Runtime.executionContextCreated": {
      // Builds executionContextId -> frameId so map fetches for MFE remote
      // chunks can target the frame that actually loaded them, not always
      // the top frame (see frameForScript / fetchSourceMapFor).
      const p = params as unknown as {
        context: { id: number; auxData?: { frameId?: string } };
      };
      if (p.context.auxData?.frameId) {
        contextFrames.set(p.context.id, p.context.auxData.frameId);
      }
      break;
    }
    case "Runtime.executionContextsCleared": {
      contextFrames.clear();
      break;
    }
    case "Debugger.scriptParsed": {
      const p = params as unknown as ScriptParsedParams;
      // Register EVERY script — eval'd Module Federation modules often have no
      // URL (or a webpack:// pseudo-URL) yet carry an inline sourceMapURL, and
      // frames key into this registry by scriptId. CDP hands us sourceMapURL
      // directly; the script text is never fetched or regexed for it.
      const script: ScriptInfo = {
        scriptId: p.scriptId,
        url: p.url ?? "",
        sourceMapURL: p.sourceMapURL || undefined,
        hasSourceURL: p.hasSourceURL,
        executionContextId: p.executionContextId,
      };
      scripts.set(p.scriptId, script);
      // Live update: lazily-loaded MFE remote chunks parse long after load.
      post({ type: "script-parsed", script });
      break;
    }
    case "Debugger.breakpointResolved": {
      const p = params as unknown as BreakpointResolvedParams;
      const bp = breakpoints.get(p.breakpointId);
      if (bp && !bp.bound) {
        bp.bound = true;
        pushBreakpoints();
      }
      break;
    }
    case "Debugger.paused": {
      // Only one pause at a time; Chrome shouldn't send a second paused
      // without a resumed in between, but guard anyway by replacing state.
      const p = params as unknown as PausedParams;
      // One-shot event breakpoints clear themselves on first hit so the user
      // isn't repeatedly paused by every subsequent click/keydown.
      if (p.reason === "EventListener") {
        const eventName = p.data?.eventName?.replace(/^listener:/, "");
        if (eventName && eventBreakpoints.get(eventName)?.oneShot) {
          void removeEventBreakpoint(eventName);
        }
      }
      let reason = p.reason;
      let detail = p.data?.eventName ?? p.data?.url ?? p.data?.breakpointURL;
      let frames = p.callFrames;
      // The in-page GraphQL hook pauses via a `debugger;` statement (reason
      // "other") inside a sentinel-named helper. Relabel the pause and drop
      // the helper + wrapper frames so the stack starts at the app code that
      // issued the operation.
      const gqlFrameId =
        reason === "other" && frames[0]?.functionName === GQL_PAUSE_SENTINEL
          ? frames[0].callFrameId
          : undefined;
      if (gqlFrameId !== undefined) {
        reason = "GraphQLOperation";
        detail = [...gqlOpBreakpoints.keys()].join(", ") || undefined;
        if (frames.length > 2) frames = frames.slice(2);
      }
      // M7: flatten async parents into the paused stack, exactly like the M1
      // initiator stacks — separator rows mark each async boundary. This is
      // what lets request-triggered discovery walk back to a lifecycle hook
      // (ngOnInit → service → RxJS → fetch crosses several boundaries). Async
      // frames carry no scopeChain/callFrameId: not steppable or inspectable,
      // but breakable via url:line. Note the chain can still break short of
      // user code — zone.js (Angular) and long RxJS pipelines are the common
      // causes; the panel shows explicit guidance instead of failing silently.
      const asyncFrames = flattenStack(p.asyncStackTrace).map((f) => ({
        functionName: f.functionName,
        // Real scriptId when CDP provides one (async parents do) — needed for
        // source-map resolution; separator rows keep "". Async frames still
        // carry no callFrameId/scopeChain: not steppable or inspectable.
        scriptId: f.scriptId ?? "",
        url: f.url,
        lineNumber: f.lineNumber,
        columnNumber: f.columnNumber,
        scopeChain: [],
      }));
      pausedState = {
        pauseId: ++pauseSeq,
        reason,
        detail,
        hitBreakpoints: p.hitBreakpoints ?? [],
        callFrames: [
          ...frames.map((f) => ({
            functionName: f.functionName,
            scriptId: f.location.scriptId,
            url: scripts.get(f.location.scriptId)?.url ?? "",
            lineNumber: f.location.lineNumber,
            columnNumber: f.location.columnNumber ?? 0,
            scopeChain: f.scopeChain.map((s) => ({
              type: s.type,
              objectId: s.object.objectId,
            })),
          })),
          ...asyncFrames,
        ],
      };
      post({ type: "paused", state: pausedState });
      if (gqlFrameId !== undefined) void refineGqlPauseDetail(gqlFrameId);
      break;
    }
    case "Debugger.resumed": {
      pausedState = null;
      post({ type: "resumed" });
      break;
    }
  }
});

// ---- Extension events ----

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  if (tabId === undefined) return;
  // sidePanel.open must be the first await so the user-gesture context is
  // still live when it runs.
  await chrome.sidePanel.open({ tabId });
  await attach(tabId);
});

chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== PORT_NAME) return;
  port = p;
  p.onMessage.addListener((msg: PanelToBg) => {
    switch (msg.type) {
      case "get-status":
        pushStatus();
        break;
      case "clear-requests":
        clearRequests();
        break;
      case "reattach-active-tab":
        void reattachActiveTab();
        break;
      case "reload-and-capture":
        void reloadAndCapture();
        break;
      case "set-auto-capture":
        void setAutoCapture(msg.enabled);
        break;
      case "set-async-depth":
        void setAsyncDepth(msg.maxDepth);
        break;
      case "set-breakpoint":
        void setBreakpoint(msg);
        break;
      case "remove-breakpoint":
        void removeBreakpoint(msg.breakpointId);
        break;
      case "set-xhr-breakpoint":
        void setXhrBreakpoint(msg.url);
        break;
      case "remove-xhr-breakpoint":
        void removeXhrBreakpoint(msg.url);
        break;
      case "set-gql-op-breakpoint":
        void setGqlOpBreakpoint(msg.target, msg.label);
        break;
      case "remove-gql-op-breakpoint":
        void removeGqlOpBreakpoint(msg.target);
        break;
      case "resume":
        void debuggerCommand("Debugger.resume");
        break;
      case "step-over":
        void debuggerCommand("Debugger.stepOver");
        break;
      case "step-into":
        void debuggerCommand("Debugger.stepInto");
        break;
      case "step-out":
        void debuggerCommand("Debugger.stepOut");
        break;
      case "get-properties":
        void getProperties(msg.objectId, msg.requestToken);
        break;
      case "capture-screenshot":
        void captureScreenshot(msg.mode, msg.clip, msg.requestToken);
        break;
      case "activate-picker":
        void activatePicker();
        break;
      case "get-scripts":
        post({ type: "scripts", scripts: [...scripts.values()] });
        break;
      case "fetch-source-map":
        void fetchSourceMapFor(msg.scriptId, msg.requestToken);
        break;
      case "fetch-page-resource":
        void fetchPageResourceFor(msg.url, msg.requestToken);
        break;
      case "get-script-source":
        void getScriptSource(msg.scriptId, msg.requestToken);
        break;
      case "set-event-breakpoint":
        void setEventBreakpoint(msg.eventName, msg.oneShot);
        break;
      case "remove-event-breakpoint":
        void removeEventBreakpoint(msg.eventName);
        break;
      case "get-framework":
        void resolveFramework(msg.requestToken);
        break;
      case "set-framework-override":
        void setFrameworkOverride(msg.framework, msg.requestToken);
        break;
      case "extract-handler":
        void extractHandler(msg.selector, msg.eventType, msg.framework, msg.requestToken);
        break;
      case "set-blackbox-patterns":
        void applyBlackboxPatterns(msg.patterns);
        break;
      case "set-function-breakpoint":
        void setFunctionBreakpoint(msg.handlerObjectId, msg.label);
        break;
      case "remove-function-breakpoint":
        void removeFunctionBreakpoint(msg.id);
        break;
    }
  });
  p.onDisconnect.addListener(() => {
    // The side panel closing is only observable as its port disconnecting.
    if (port === p) port = null;
    void detach();
  });
  pushStatus();
  // Replay current state so a reopened panel isn't empty.
  post({ type: "requests-snapshot", requests: [...requests.values()] });
  post({ type: "scripts", scripts: [...scripts.values()] });
  pushBreakpoints();
  if (pausedState) post({ type: "paused", state: pausedState });
});

chrome.debugger.onDetach.addListener((source) => {
  // Fires when the user dismisses the "is debugging this browser" banner.
  if (source.tabId === attachedTabId) {
    attachedTabId = null;
    attachedTabTitle = undefined;
    alreadyLoaded = false;
    autoCapture = false;
    clearRequests();
    clearDebugSessionState();
    pushStatus("Detached externally");
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === attachedTabId) {
    attachedTabId = null;
    attachedTabTitle = undefined;
    alreadyLoaded = false;
    autoCapture = false;
    clearRequests();
    clearDebugSessionState();
    pushStatus();
  }
});

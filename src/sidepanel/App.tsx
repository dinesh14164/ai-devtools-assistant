import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  PORT_NAME,
  type BgToPanel,
  type BreakpointInfo,
  type CapturedRequest,
  type EventBreakpointInfo,
  type ExtractedHandler,
  type FrameworkId,
  type FrameworkResolution,
  type FunctionBreakpointInfo,
  type GqlOpBreakpointInfo,
  type GraphQLOperation,
  type PanelToBg,
  type PausedSnapshot,
  type PickedElement,
  type RemoteProperty,
  type ScreenshotMode,
  type ScriptInfo,
} from "../shared/messages";
import { deriveGraphQLDisplay, getOperationArmTarget } from "../background/graphql";
import {
  clearAllCaches,
  clearRequestCache,
  configureWorkerBridge,
  describeSourceMapStatus,
  getSourceMapStatuses,
  resolveGeneratedPosition,
  resolveOriginalLocation,
  resolveRequestStack,
  subscribeSourceMapStatuses,
  type ResolvedFrame,
  type SourceMapStatus,
} from "./sourceMapResolver";
import { getConfig, type ModelConfigState } from "./modelConfig";
import { DEFAULT_QUESTION, formatRequestContext } from "./requestContext";
import Chat, { type ChatPrefill } from "./Chat";
import Settings from "./Settings";
import Debugger, {
  DEFAULT_BLACKBOX,
  type DisplayHandler,
  type HandlerCandidates,
} from "./Debugger";
import SourcesView, { type SourcesNavTarget } from "./SourcesView";
import { fileNameOf, originLabelOf, prettySourcePath } from "./framePath";
import type { EntryCandidate } from "./entryPointAgent";
import NetworkFilterBar from "./NetworkFilterBar";
import {
  EMPTY_FILTER_STATE,
  hasHiddenMatch,
  hiddenMatchFields,
  highlightParts,
  loadFilterSession,
  matchesFilters,
  saveFilterSession,
  searchRequest,
  SEARCH_FIELD_LABELS,
  type FilterState,
} from "./networkFilter";
import {
  DEFAULT_QUESTIONS,
  type Attachment,
  type AttachmentInput,
} from "./attachments";

interface Status {
  attached: boolean;
  tabId: number | null;
  tabTitle?: string;
  error?: string;
  alreadyLoaded?: boolean; // attached after the page finished loading (M7)
  autoCapture?: boolean;
  asyncDepth?: number;
}

type View = "network" | "debug" | "sources" | "chat" | "settings";

type PendingPreview =
  | { kind: "image"; dataUrl: string; label: string }
  | { kind: "element"; payload: PickedElement };

const METHOD_BADGE: Record<string, string> = {
  GET: "bg-green-100 text-green-800",
  POST: "bg-blue-100 text-blue-800",
  PUT: "bg-amber-100 text-amber-800",
  PATCH: "bg-amber-100 text-amber-800",
  DELETE: "bg-red-100 text-red-800",
};

function operationTypeBadgeClass(type?: GraphQLOperation["operationType"]): string {
  switch (type) {
    case "mutation":
      return "bg-rose-100 text-rose-800";
    case "subscription":
      return "bg-violet-100 text-violet-800";
    default:
      return "bg-sky-100 text-sky-800";
  }
}

function GraphQLBadge({ type }: { type?: GraphQLOperation["operationType"] }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${operationTypeBadgeClass(type)}`}
    >
      GQL
    </span>
  );
}

function formatVariables(variables: unknown): string {
  try {
    return JSON.stringify(variables, null, 2);
  } catch {
    return String(variables);
  }
}

/** Renders `text` with active search terms wrapped in <mark> (Part B). */
function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  return (
    <>
      {highlightParts(text, query).map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded-sm bg-yellow-200 px-0.5 text-inherit">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function FrameRow({
  frame,
  mapStatus,
  originChip,
  onBreak,
  onOpenSource,
  onOpenGenerated,
}: {
  frame: ResolvedFrame;
  mapStatus: SourceMapStatus | undefined;
  originChip: string | null; // shown only when the origin differs from the previous frame
  onBreak: (frame: ResolvedFrame) => void;
  onOpenSource: (frame: ResolvedFrame) => void;
  onOpenGenerated: (scriptId: string, lineNumber: number, columnNumber: number) => void;
}) {
  if (frame.isAsyncSeparator) {
    return (
      <li className="-ml-5 list-none py-0.5 font-mono text-xs italic text-gray-400">
        {frame.raw.functionName}
      </li>
    );
  }
  const rawLocationFull = frame.raw.url
    ? `${frame.raw.url}:${frame.raw.lineNumber}:${frame.raw.columnNumber}`
    : frame.raw.scriptId
      ? `scriptId ${frame.raw.scriptId}:${frame.raw.lineNumber}:${frame.raw.columnNumber}`
      : null;
  const rawLocationDisplay = frame.raw.url
    ? `${fileNameOf(frame.raw.url)}:${frame.raw.lineNumber}:${frame.raw.columnNumber}`
    : rawLocationFull;
  const chip = originChip ? (
    <span
      className="shrink-0 rounded bg-sky-100 px-1 py-px font-mono text-[10px] font-semibold text-sky-700"
      title={frame.raw.url}
    >
      {originChip}
    </span>
  ) : null;
  // Breakable when the frame identifies a real script — by URL or (eval'd
  // webpack modules) by scriptId.
  const breakButton =
    frame.raw.url || frame.raw.scriptId ? (
      <button
        className="rounded bg-gray-200 px-1.5 py-px align-middle text-[10px] font-medium text-gray-700 hover:bg-gray-300"
        title="Set a breakpoint at this frame"
        onClick={() => onBreak(frame)}
      >
        ⏸ break
      </button>
    ) : null;
  if (!frame.resolved) {
    // Never silent — an unmapped frame says why on hover; with a scriptId it
    // still navigates, to the pretty-printed generated script.
    const reason = !frame.raw.scriptId
      ? "no script attribution (native/synthetic frame)"
      : mapStatus?.state === "resolved"
        ? "map resolved, but this exact position has no original mapping"
        : describeSourceMapStatus(mapStatus);
    return (
      <li className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        {chip}
        <span className="font-mono">{frame.raw.functionName || "(anonymous)"}</span>
        <span
          className="cursor-help rounded bg-amber-100 px-1 py-px align-middle text-[10px] font-semibold text-amber-700"
          title={reason}
        >
          ⚠ {mapStatus?.state === "no-map" || !frame.raw.scriptId ? "no source map" : "unmapped"}
        </span>
        {breakButton}
        {rawLocationDisplay &&
          (frame.raw.scriptId ? (
            <button
              className="break-all text-left font-mono text-xs text-gray-600 underline decoration-dotted hover:text-gray-900"
              title={`${rawLocationFull} — click to open the generated script (pretty-printed) at this position`}
              onClick={() =>
                onOpenGenerated(
                  frame.raw.scriptId,
                  frame.raw.lineNumber,
                  frame.raw.columnNumber,
                )
              }
            >
              {rawLocationDisplay}
            </button>
          ) : (
            <span
              className="cursor-help break-all font-mono text-xs text-gray-500"
              title={`${rawLocationFull ?? ""} — not navigable: ${reason}`}
            >
              {rawLocationDisplay}
            </span>
          ))}
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      {chip}
      <span className="font-mono">
        {frame.resolved.name || frame.raw.functionName || "(anonymous)"}
      </span>
      <span className="rounded bg-emerald-100 px-1 py-px align-middle text-[10px] font-semibold text-emerald-700">
        mapped
      </span>
      {breakButton}
      <button
        className="break-all text-left font-mono text-xs text-blue-700 underline decoration-dotted hover:text-blue-900"
        title={`${frame.resolved.source} — click to open the original file at this line`}
        onClick={() => onOpenSource(frame)}
      >
        {prettySourcePath(frame.resolved.source)}:{frame.resolved.line}:
        {frame.resolved.column}
      </button>
      {rawLocationDisplay && (
        <span
          className="w-full break-all font-mono text-[10px] text-gray-400"
          title={rawLocationFull ?? undefined}
        >
          {rawLocationDisplay}
        </span>
      )}
    </li>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>({ attached: false, tabId: null });
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resolvedFrames, setResolvedFrames] = useState<ResolvedFrame[] | null>(null);
  const [resolving, setResolving] = useState(false);
  const [view, setView] = useState<View>("network");
  const [config, setConfig] = useState<ModelConfigState>({
    profiles: [],
    activeProfileId: null,
  });
  const [prefill, setPrefill] = useState<ChatPrefill | null>(null);
  const [breakpoints, setBreakpoints] = useState<BreakpointInfo[]>([]);
  const [xhrBreakpoints, setXhrBreakpoints] = useState<string[]>([]);
  const [eventBreakpoints, setEventBreakpoints] = useState<EventBreakpointInfo[]>([]);
  const [functionBreakpoints, setFunctionBreakpoints] = useState<
    FunctionBreakpointInfo[]
  >([]);
  const [gqlOpBreakpoints, setGqlOpBreakpoints] = useState<GqlOpBreakpointInfo[]>([]);
  const [handlerCandidates, setHandlerCandidates] =
    useState<HandlerCandidates | null>(null);
  const [framework, setFramework] = useState<FrameworkResolution | null>(null);
  const [askFramework, setAskFramework] = useState(false);
  // Event type waiting on a framework answer before the picker can start.
  const pendingHandlerEventRef = useRef<string | null>(null);
  // Armed when extraction failed and the user opted into the AI-stack fallback.
  const aiFallbackRef = useRef<{ eventType: string; framework: string } | null>(null);
  const [paused, setPaused] = useState<PausedSnapshot | null>(null);
  const [breakpointError, setBreakpointError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pendingPreview, setPendingPreview] = useState<PendingPreview | null>(null);
  const [picking, setPicking] = useState(false);
  const [scripts, setScripts] = useState<ScriptInfo[]>([]);
  // Per-script source-map statuses (Fix 4) — live view of the resolver's
  // registry, feeding frame indicators and the diagnostics panel.
  const mapStatuses = useSyncExternalStore(
    subscribeSourceMapStatuses,
    getSourceMapStatuses,
  );
  // Pending "open original file at line" navigation for the Sources tab.
  const [sourcesNav, setSourcesNav] = useState<SourcesNavTarget | null>(null);
  // Network filters + search (Part A/B) — display-only, session-persisted.
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTER_STATE);
  const [search, setSearch] = useState("");
  const filterSessionLoadedRef = useRef(false);
  const attachmentIdRef = useRef(0);
  // What the next element pick is for: chat attachment (default) or finding
  // an element's event handlers to break on.
  const pickModeRef = useRef<
    { kind: "attach" } | { kind: "handler"; eventType: string; framework: FrameworkId }
  >({ kind: "attach" });
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const requestsRef = useRef<CapturedRequest[]>([]);
  requestsRef.current = requests;
  // Correlates request/reply message pairs (properties, screenshots, script
  // source) over the port by token.
  const rpcTokenRef = useRef(0);
  const pendingRpcRef = useRef(new Map<number, (msg: BgToPanel) => void>());

  useEffect(() => {
    void getConfig().then(setConfig);
  }, []);

  // Filters/search persist per session (chrome.storage.session — survives
  // panel re-open, cleared on browser restart), not per origin.
  useEffect(() => {
    void loadFilterSession().then((session) => {
      setFilters(session.filters);
      setSearch(session.search);
      filterSessionLoadedRef.current = true;
    });
  }, []);

  useEffect(() => {
    if (!filterSessionLoadedRef.current) return; // don't clobber storage with defaults pre-hydration
    saveFilterSession({ filters, search });
  }, [filters, search]);

  useEffect(() => {
    const port = chrome.runtime.connect({ name: PORT_NAME });
    portRef.current = port;
    port.onMessage.addListener((msg: BgToPanel) => {
      switch (msg.type) {
        case "status":
          setStatus({
            attached: msg.attached,
            tabId: msg.tabId,
            tabTitle: msg.tabTitle,
            error: msg.error,
            alreadyLoaded: msg.alreadyLoaded,
            autoCapture: msg.autoCapture,
            asyncDepth: msg.asyncDepth,
          });
          break;
        case "request-added":
          setRequests((prev) => {
            const i = prev.findIndex((r) => r.requestId === msg.request.requestId);
            if (i === -1) return [...prev, msg.request];
            const next = prev.slice();
            next[i] = msg.request;
            return next;
          });
          break;
        case "request-updated":
          // Tolerates updates for requests we never saw: map matches nothing.
          setRequests((prev) =>
            prev.map((r) =>
              r.requestId === msg.requestId
                ? {
                    ...r,
                    status: msg.status ?? r.status,
                    mimeType: msg.mimeType ?? r.mimeType,
                    graphql: msg.graphql ?? r.graphql,
                  }
                : r,
            ),
          );
          break;
        case "requests-cleared":
          setRequests([]);
          setSelectedId(null);
          clearRequestCache();
          break;
        case "requests-snapshot":
          setRequests(msg.requests);
          break;
        case "breakpoints":
          setBreakpoints(msg.breakpoints);
          setXhrBreakpoints(msg.xhrBreakpoints);
          setEventBreakpoints(msg.eventBreakpoints);
          setFunctionBreakpoints(msg.functionBreakpoints);
          setGqlOpBreakpoints(msg.gqlOpBreakpoints);
          break;
        case "breakpoint-error":
          setBreakpointError(msg.error);
          break;
        case "paused": {
          setPaused(msg.state);
          setView("debug"); // jump to the inspector when execution stops
          const fallback = aiFallbackRef.current;
          if (fallback && msg.state.reason === "EventListener") {
            aiFallbackRef.current = null;
            void buildAiFallbackPrompt(fallback, msg.state);
          }
          break;
        }
        case "resumed":
          setPaused(null);
          break;
        case "properties":
        case "screenshot":
        case "script-source":
        case "source-map":
        case "page-resource":
        case "framework":
        case "handler-candidates": {
          const pending = pendingRpcRef.current.get(msg.requestToken);
          if (pending) {
            pendingRpcRef.current.delete(msg.requestToken);
            pending(msg);
          }
          break;
        }
        case "element-picked": {
          setPicking(false);
          const mode = pickModeRef.current;
          pickModeRef.current = { kind: "attach" };
          if (mode.kind === "handler") {
            // Framework-aware extraction (main world) for the picked element.
            const selector = msg.payload.selector;
            setView("debug");
            void extractHandler(selector, mode.eventType, mode.framework).then(
              async (candidates) => {
                const display: DisplayHandler[] = await Promise.all(
                  candidates.map(async (c) => {
                    if (!c.scriptId || c.lineNumber === undefined) return c;
                    const loc = await resolveOriginalLocation(
                      c.scriptId,
                      c.lineNumber,
                      c.columnNumber ?? 0,
                    );
                    return loc
                      ? {
                          ...c,
                          resolvedLocation: `${loc.name ? `${loc.name} — ` : ""}${loc.source}:${loc.line}`,
                        }
                      : c;
                  }),
                );
                setHandlerCandidates({
                  eventType: mode.eventType,
                  selector,
                  framework: mode.framework,
                  candidates: display,
                });
              },
              (e: unknown) =>
                setHandlerCandidates({
                  eventType: mode.eventType,
                  selector,
                  framework: mode.framework,
                  candidates: [],
                  error: e instanceof Error ? e.message : String(e),
                }),
            );
          } else {
            setPendingPreview({ kind: "element", payload: msg.payload });
          }
          break;
        }
        case "picker-cancelled":
          setPicking(false);
          pickModeRef.current = { kind: "attach" };
          break;
        case "scripts":
          setScripts(msg.scripts);
          break;
        case "script-parsed":
          // Live registry growth — lazily-loaded MFE remote chunks parse long
          // after initial load and must appear in diagnostics as they arrive.
          setScripts((prev) => {
            const i = prev.findIndex((s) => s.scriptId === msg.script.scriptId);
            if (i === -1) return [...prev, msg.script];
            const next = prev.slice();
            next[i] = msg.script;
            return next;
          });
          break;
      }
    });
    // The resolver fetches maps through the worker (page network context, with
    // the page's credentials) — hand it this port's RPC.
    configureWorkerBridge({
      fetchSourceMap: async (scriptId) => {
        const msg = (await sendRpc((requestToken) => ({
          type: "fetch-source-map",
          scriptId,
          requestToken,
        }))) as Extract<BgToPanel, { type: "source-map" }>;
        return msg.result;
      },
      fetchPageResource: async (url) => {
        const msg = (await sendRpc((requestToken) => ({
          type: "fetch-page-resource",
          url,
          requestToken,
        }))) as Extract<BgToPanel, { type: "page-resource" }>;
        if (msg.error || msg.content === undefined) {
          throw new Error(msg.error ?? "No content");
        }
        return msg.content;
      },
    });
    port.postMessage({ type: "get-status" } satisfies PanelToBg);
    return () => {
      portRef.current = null;
      configureWorkerBridge(null);
      port.disconnect();
      clearAllCaches();
    };
  }, []);

  // Resolve the site's framework once per attach (worker caches per-origin).
  useEffect(() => {
    if (status.attached) {
      void getFramework().then(applyFramework, () => {});
    } else {
      setFramework(null);
      setAskFramework(false);
      pendingHandlerEventRef.current = null;
      aiFallbackRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.attached, status.tabId]);

  const buildAiFallbackPrompt = async (
    fallback: { eventType: string; framework: string },
    state: PausedSnapshot,
  ) => {
    const locations = await Promise.all(
      state.callFrames.map((f) =>
        resolveOriginalLocation(f.scriptId, f.lineNumber, f.columnNumber),
      ),
    );
    const stackLines = state.callFrames.map((f, i) => {
      const loc = locations[i];
      const name = loc?.name || f.functionName || "(anonymous)";
      const where = loc
        ? `${loc.source}:${loc.line}`
        : f.url
          ? `${f.url}:${f.lineNumber}:${f.columnNumber}`
          : "";
      return `  ${name}  ${where}`;
    });
    setPrefill({
      text:
        `[AI fallback — heuristic] Handler extraction failed (likely a production build), ` +
        `so I paused on a broad "${fallback.eventType}" event-listener breakpoint in a ` +
        `${fallback.framework} app. From the call stack below, identify which frame is my ` +
        `own application handler rather than framework internals — name the function and ` +
        `file. I'll set a breakpoint on that frame (⏸ button in the Debug tab) for ` +
        `subsequent runs.\n\nCall stack (innermost first):\n${stackLines.join("\n")}`,
      nonce: Date.now(),
    });
    setView("chat");
  };

  // Lazy resolution: only the selected request's stack, when it's selected.
  useEffect(() => {
    if (!selectedId) {
      setResolvedFrames(null);
      setResolving(false);
      return;
    }
    const request = requestsRef.current.find((r) => r.requestId === selectedId);
    if (!request) return;
    let cancelled = false;
    setResolvedFrames(null);
    setResolving(true);
    void resolveRequestStack(request.requestId, request.initiatorStack).then(
      (frames) => {
        if (cancelled) return;
        setResolvedFrames(frames);
        setResolving(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const send = (msg: PanelToBg) => portRef.current?.postMessage(msg);

  // Filtering/search compose (AND): filters narrow the bucket, search then
  // narrows further — display-only, `requests` itself is never touched.
  const searching = search.trim() !== "";
  const visibleRequests = useMemo(
    () =>
      requests.filter(
        (r) => matchesFilters(r, filters) && (!searching || searchRequest(r, search).matched),
      ),
    [requests, filters, searching, search],
  );
  const matchMap = useMemo(
    () =>
      searching
        ? new Map(visibleRequests.map((r) => [r.requestId, searchRequest(r, search)] as const))
        : null,
    [searching, visibleRequests, search],
  );
  const clearAllFilters = () => {
    setFilters(EMPTY_FILTER_STATE);
    setSearch("");
  };

  const selected = requests.find((r) => r.requestId === selectedId) ?? null;
  // While resolution is in flight, show the raw frames so the pane never blocks.
  const displayFrames: ResolvedFrame[] | null = selected
    ? resolvedFrames ??
      selected.initiatorStack.map((f) => ({
        raw: f,
        isAsyncSeparator: f.functionName.startsWith("[async:"),
      }))
    : null;

  const sendRpc = (build: (token: number) => PanelToBg): Promise<BgToPanel> =>
    new Promise((resolve, reject) => {
      const port = portRef.current;
      if (!port) {
        reject(new Error("Disconnected"));
        return;
      }
      const token = ++rpcTokenRef.current;
      pendingRpcRef.current.set(token, resolve);
      port.postMessage(build(token));
    });

  const fetchProperties = async (objectId: string): Promise<RemoteProperty[]> => {
    const msg = (await sendRpc((requestToken) => ({
      type: "get-properties",
      objectId,
      requestToken,
    }))) as Extract<BgToPanel, { type: "properties" }>;
    if (msg.error) throw new Error(msg.error);
    return msg.properties;
  };

  const captureScreenshot = async (
    mode: ScreenshotMode,
    clip?: { x: number; y: number; width: number; height: number },
  ): Promise<string> => {
    const msg = (await sendRpc((requestToken) => ({
      type: "capture-screenshot",
      mode,
      clip,
      requestToken,
    }))) as Extract<BgToPanel, { type: "screenshot" }>;
    if (msg.error || !msg.dataUrl) throw new Error(msg.error ?? "No image data");
    return msg.dataUrl;
  };

  const getFramework = async (): Promise<FrameworkResolution> => {
    const msg = (await sendRpc((requestToken) => ({
      type: "get-framework",
      requestToken,
    }))) as Extract<BgToPanel, { type: "framework" }>;
    return msg.resolution;
  };

  const applyFramework = (resolution: FrameworkResolution) => {
    setFramework(resolution);
    // Blackboxing defaults follow the framework so stepping skips internals.
    const patterns = DEFAULT_BLACKBOX[resolution.framework] ?? [];
    if (patterns.length > 0) send({ type: "set-blackbox-patterns", patterns });
  };

  const chooseFramework = async (choice: FrameworkId | "auto") => {
    setAskFramework(false);
    const msg = (await sendRpc((requestToken) => ({
      type: "set-framework-override",
      framework: choice,
      requestToken,
    }))) as Extract<BgToPanel, { type: "framework" }>;
    applyFramework(msg.resolution);
    // If a "break on element handler" was waiting on this answer, continue it.
    const pendingEvent = pendingHandlerEventRef.current;
    if (pendingEvent && msg.resolution.framework !== "unknown") {
      pendingHandlerEventRef.current = null;
      startHandlerPick(pendingEvent, msg.resolution.framework);
    }
  };

  const extractHandler = async (
    selector: string,
    eventType: string,
    fw: FrameworkId,
  ): Promise<ExtractedHandler[]> => {
    const msg = (await sendRpc((requestToken) => ({
      type: "extract-handler",
      selector,
      eventType,
      framework: fw,
      requestToken,
    }))) as Extract<BgToPanel, { type: "handler-candidates" }>;
    if (msg.error) throw new Error(msg.error);
    return msg.candidates;
  };

  const startHandlerPick = (eventType: string, fw: FrameworkId) => {
    pickModeRef.current = { kind: "handler", eventType, framework: fw };
    setPicking(true);
    send({ type: "activate-picker" });
  };

  const getScriptSource = async (scriptId: string): Promise<string> => {
    const msg = (await sendRpc((requestToken) => ({
      type: "get-script-source",
      scriptId,
      requestToken,
    }))) as Extract<BgToPanel, { type: "script-source" }>;
    if (msg.error || msg.source === undefined) {
      throw new Error(msg.error ?? "No source");
    }
    return msg.source;
  };

  const addAttachment = (att: AttachmentInput, defaultQuestion: string) => {
    const withId: Attachment = { ...att, id: ++attachmentIdRef.current };
    setAttachments((prev) => {
      // First attachment pre-fills the matching default question (editable).
      if (prev.length === 0) {
        setPrefill({ text: defaultQuestion, nonce: Date.now() });
      }
      return [...prev, withId];
    });
    setView("chat");
  };

  const takeScreenshot = async (mode: ScreenshotMode, label: string) => {
    setBreakpointError(null);
    try {
      const dataUrl = await captureScreenshot(mode);
      setPendingPreview({ kind: "image", dataUrl, label });
    } catch (e) {
      setBreakpointError(
        `Screenshot failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const attachElementPreview = async (withScreenshot: boolean) => {
    if (pendingPreview?.kind !== "element") return;
    const payload = pendingPreview.payload;
    setPendingPreview(null);
    addAttachment({ kind: "element", payload }, DEFAULT_QUESTIONS.element);
    if (withScreenshot) {
      try {
        const dataUrl = await captureScreenshot("clip", payload.rect);
        setAttachments((prev) => [
          ...prev,
          {
            id: ++attachmentIdRef.current,
            kind: "image",
            dataUrl,
            label: `<${payload.tagName}> screenshot`,
          },
        ]);
      } catch {
        // element screenshot is optional sugar; the element context still went in
      }
    }
  };

  const setBreakpointFromFrame = async (frame: ResolvedFrame) => {
    if (frame.isAsyncSeparator || (!frame.raw.url && !frame.raw.scriptId)) return;
    setBreakpointError(null);
    if (frame.resolved) {
      // Reverse source-map direction: exact `source` string from the M2
      // resolution (never the display label) -> generated position. Keyed by
      // scriptId, so eval'd/webpack:// frames work too.
      const gen = await resolveGeneratedPosition(
        frame.raw.scriptId,
        frame.resolved.source,
        frame.resolved.line,
      );
      if (gen) {
        send({
          type: "set-breakpoint",
          url: frame.raw.url,
          scriptId: frame.raw.scriptId,
          lineNumber: gen.lineNumber,
          columnNumber: gen.columnNumber,
          originalLabel: `${frame.resolved.source}:${frame.resolved.line}`,
        });
        setView("debug");
        return;
      }
      if (
        !confirm(
          "This original line has no mapping in the shipped bundle (dead code or inlined). Set a raw breakpoint at the minified location instead?",
        )
      ) {
        return;
      }
    }
    send({
      type: "set-breakpoint",
      url: frame.raw.url,
      scriptId: frame.raw.scriptId,
      lineNumber: frame.raw.lineNumber,
      columnNumber: frame.raw.columnNumber,
    });
    setView("debug");
  };

  // A clicked resolved frame opens the ORIGINAL file at its line in the
  // Sources tab (sourcesContent-backed — usually zero extra network).
  const openOriginalSource = (scriptId: string, source: string, line: number) => {
    setSourcesNav({ kind: "original", scriptId, source, line, nonce: Date.now() });
    setView("sources");
  };

  // A clicked UNRESOLVED frame still reaches something: the generated script,
  // pretty-printed, highlighted at the mapped position.
  const openGeneratedSource = (
    scriptId: string,
    lineNumber: number,
    columnNumber: number,
  ) => {
    setSourcesNav({ kind: "generated", scriptId, lineNumber, columnNumber, nonce: Date.now() });
    setView("sources");
  };

  // "Break at entry point" from the Find-entry-point agent: reverse-map the
  // confirmed original line and arm it. Confirmation happens in the panel.
  const breakAtCandidate = async (candidate: EntryCandidate): Promise<string | null> => {
    const script = candidate.scriptId
      ? scripts.find((s) => s.scriptId === candidate.scriptId)
      : undefined;
    if (!script) return "That candidate's script is no longer loaded (page navigated?).";
    return breakOnOriginalLine(script, candidate.file, candidate.line);
  };

  // Fix 6: breakpoint from an original-source line — reverse-map, then arm.
  const breakOnOriginalLine = async (
    script: ScriptInfo,
    source: string,
    line: number,
  ): Promise<string | null> => {
    const gen = await resolveGeneratedPosition(script.scriptId, source, line);
    if (!gen) {
      return `${source}:${line} has no mapping in the shipped bundle (dead code or inlined) — can't arm it.`;
    }
    send({
      type: "set-breakpoint",
      url: script.url,
      scriptId: script.scriptId,
      lineNumber: gen.lineNumber,
      columnNumber: gen.columnNumber,
      originalLabel: `${source}:${line}`,
    });
    return null;
  };

  const breakOnGraphQLOperation = (op: GraphQLOperation) => {
    const target = getOperationArmTarget(op);
    if (!target) return;
    send({
      type: "set-gql-op-breakpoint",
      target,
      label: `${op.operationType} ${target}`,
    });
    setView("debug");
  };

  const breakOnSelectedUrl = () => {
    if (!selected) return;
    let substring: string;
    try {
      substring = new URL(selected.url).pathname;
    } catch {
      substring = selected.url;
    }
    if (!substring || substring === "/") substring = selected.url;
    send({ type: "set-xhr-breakpoint", url: substring });
    setView("debug");
  };

  const askAiAboutSelected = async () => {
    if (!selected) return;
    // Use the cached resolution (or finish it) so the attachment carries
    // original file:line locations, not minified offsets.
    const frames = await resolveRequestStack(
      selected.requestId,
      selected.initiatorStack,
    );
    setPrefill({
      text: `${DEFAULT_QUESTION}\n\n${formatRequestContext(selected, frames)}`,
      nonce: Date.now(),
    });
    setView("chat");
  };

  const tabClass = (v: View) =>
    `rounded px-2 py-1 text-xs font-medium ${
      view === v ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-800 hover:bg-gray-300"
    }`;

  return (
    <div className="flex h-screen flex-col font-sans text-sm">
      <header className="border-b border-gray-200 p-3">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold">AI DevTools Assistant</h1>
          <nav className="flex gap-1">
            <button className={tabClass("network")} onClick={() => setView("network")}>
              Network
            </button>
            <button className={tabClass("debug")} onClick={() => setView("debug")}>
              Debug{paused ? " ⏸" : ""}
            </button>
            <button className={tabClass("sources")} onClick={() => setView("sources")}>
              Sources
            </button>
            <button className={tabClass("chat")} onClick={() => setView("chat")}>
              Chat{attachments.length > 0 ? ` (${attachments.length})` : ""}
            </button>
            <button className={tabClass("settings")} onClick={() => setView("settings")}>
              Settings
            </button>
          </nav>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span
            className={`inline-block h-3 w-3 shrink-0 rounded-full ${
              status.attached ? "bg-green-500" : "bg-gray-400"
            }`}
          />
          <span>
            {status.attached ? `Attached (tab ${status.tabId})` : "Detached"}
          </span>
          {status.attached && status.tabTitle && (
            <span className="truncate text-gray-500" title={status.tabTitle}>
              — {status.tabTitle}
            </span>
          )}
        </div>
        {status.error && <p className="mt-1 text-red-600">{status.error}</p>}
        {status.attached && status.alreadyLoaded && (
          <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs">
            <span className="font-medium text-amber-800">
              This page already loaded — init-time requests (bootstrap, lifecycle
              hooks) were missed. Use "Reload &amp; capture" to catch them.
            </span>
            <button
              className="ml-2 rounded bg-amber-600 px-2 py-0.5 font-medium text-white hover:bg-amber-700"
              onClick={() => send({ type: "reload-and-capture" })}
            >
              ⟳ Reload &amp; capture
            </button>
          </div>
        )}
        {status.attached && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
              title="Re-arm all persisted breakpoints and in-page hooks, then reload — capture starts from the very first request"
              onClick={() => send({ type: "reload-and-capture" })}
            >
              ⟳ Reload &amp; capture
            </button>
            <label
              className="flex items-center gap-1 text-xs text-gray-600"
              title="Re-arm hooks and persisted breakpoints automatically on every navigation/reload (saved for this site)"
            >
              <input
                type="checkbox"
                checked={status.autoCapture ?? false}
                onChange={(e) =>
                  send({ type: "set-auto-capture", enabled: e.target.checked })
                }
              />
              Auto-capture on reload
            </label>
            <button
              className="rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-800 hover:bg-gray-300"
              onClick={() => void takeScreenshot("viewport", "viewport screenshot")}
            >
              📸 Viewport
            </button>
            <button
              className="rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-800 hover:bg-gray-300"
              onClick={() => void takeScreenshot("fullpage", "full-page screenshot")}
            >
              📸 Full page
            </button>
            <button
              className="rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-800 hover:bg-gray-300 disabled:opacity-50"
              disabled={picking}
              onClick={() => {
                setPicking(true);
                send({ type: "activate-picker" });
              }}
            >
              {picking ? "Picking… (Esc cancels)" : "🎯 Pick element"}
            </button>
          </div>
        )}
        {pendingPreview && (
          <div className="mt-2 rounded border border-blue-200 bg-blue-50 p-2">
            {pendingPreview.kind === "image" ? (
              <div className="flex items-center gap-2">
                <img
                  src={pendingPreview.dataUrl}
                  alt="capture preview"
                  className="max-h-24 max-w-[45%] rounded border border-gray-300 object-contain"
                />
                <div className="flex flex-col gap-1">
                  <button
                    className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                    onClick={() => {
                      const p = pendingPreview;
                      setPendingPreview(null);
                      addAttachment(
                        { kind: "image", dataUrl: p.dataUrl, label: p.label },
                        DEFAULT_QUESTIONS.image,
                      );
                    }}
                  >
                    Attach to question
                  </button>
                  <button
                    className="rounded bg-gray-200 px-2 py-1 text-xs hover:bg-gray-300"
                    onClick={() => setPendingPreview(null)}
                  >
                    Discard
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <p className="break-all font-mono text-xs">
                  {"<"}
                  {pendingPreview.payload.tagName}
                  {">"} {pendingPreview.payload.selector}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <button
                    className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                    onClick={() => void attachElementPreview(false)}
                  >
                    Attach to question
                  </button>
                  <button
                    className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                    onClick={() => void attachElementPreview(true)}
                  >
                    Attach + element screenshot
                  </button>
                  <button
                    className="rounded bg-gray-200 px-2 py-1 text-xs hover:bg-gray-300"
                    onClick={() => setPendingPreview(null)}
                  >
                    Discard
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {view === "network" && (
          <div className="mt-2 flex gap-2">
            <button
              className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
              onClick={() => {
                // New page context: consumers and resolved stacks are stale.
                clearAllCaches();
                send({ type: "reattach-active-tab" });
              }}
            >
              Re-attach to current tab
            </button>
            <button
              className="rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-800 hover:bg-gray-300"
              onClick={() => send({ type: "clear-requests" })}
            >
              Clear
            </button>
          </div>
        )}
      </header>

      {/* All views stay mounted so chat streaming and list state survive tab
          switches; visibility is CSS-only. */}
      <div className={view === "network" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <NetworkFilterBar
          requests={requests}
          visibleCount={visibleRequests.length}
          totalCount={requests.length}
          filters={filters}
          onFiltersChange={setFilters}
          search={search}
          onSearchChange={setSearch}
          onClearAll={clearAllFilters}
        />
        <ul className="min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto">
          {requests.length === 0 && (
            <li className="p-3 text-gray-500">No requests captured yet.</li>
          )}
          {requests.length > 0 && visibleRequests.length === 0 && (
            <li className="p-3 text-gray-500">
              {searching ? "No requests match your search." : "No requests match these filters."}{" "}
              <button
                className="font-medium text-blue-700 hover:underline"
                onClick={clearAllFilters}
              >
                Clear all
              </button>
            </li>
          )}
          {visibleRequests.map((r) => {
            const isGraphQL = !!r.graphql;
            const firstType = r.graphql?.operations[0]?.operationType;
            const displayLabel = isGraphQL ? deriveGraphQLDisplay(r.graphql!) : r.url;
            const match = matchMap?.get(r.requestId);
            const hiddenHint = match && hasHiddenMatch(match.fields);
            return (
              <li key={r.requestId}>
                <button
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50 ${
                    r.requestId === selectedId ? "bg-blue-50" : ""
                  }`}
                  onClick={() => setSelectedId(r.requestId)}
                >
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      METHOD_BADGE[r.method] ?? "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {r.method}
                  </span>
                  {isGraphQL && <GraphQLBadge type={firstType} />}
                  <span
                    className={`min-w-0 flex-1 truncate ${
                      isGraphQL ? "" : "url-cell"
                    }`}
                    title={isGraphQL ? r.url : undefined}
                  >
                    {isGraphQL ? (
                      <span className="font-medium">
                        <Highlighted text={displayLabel} query={search} />
                      </span>
                    ) : (
                      <bdi>
                        <Highlighted text={r.url} query={search} />
                      </bdi>
                    )}
                    {isGraphQL && (
                      <span className="ml-2 text-xs text-gray-400">
                        <bdi>{r.url}</bdi>
                      </span>
                    )}
                  </span>
                  {hiddenHint && (
                    <span
                      className="shrink-0 rounded bg-amber-100 px-1 py-px text-[9px] font-semibold text-amber-700"
                      title="This request matched on content not shown in the row"
                    >
                      matched: {hiddenMatchFields(match!.fields).map((f) => SEARCH_FIELD_LABELS[f]).join(", ")}
                    </span>
                  )}
                  <span className="shrink-0 text-xs text-gray-500">
                    {r.status ?? "…"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <section className="h-2/5 shrink-0 overflow-y-auto border-t border-gray-300 bg-gray-50 p-3">
          {!selected || !displayFrames ? (
            <p className="text-gray-500">Select a request to see its details.</p>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <p className="break-all font-medium">{selected.url}</p>
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    className="rounded bg-violet-600 px-2 py-1 text-xs font-medium text-white hover:bg-violet-700"
                    onClick={() => void askAiAboutSelected()}
                  >
                    Ask AI about this request
                  </button>
                  {/* For GraphQL the URL is a shared endpoint — a URL breakpoint
                      would pause on every operation, so the break actions move
                      into the per-operation cards below. */}
                  {!selected.graphql && (
                    <button
                      className="rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-800 hover:bg-gray-300"
                      title="Pause execution when a request with this URL fires"
                      onClick={breakOnSelectedUrl}
                    >
                      Break when this URL fires
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1 text-gray-600">
                {selected.method} · status {selected.status ?? "pending"} ·{" "}
                {selected.type ?? "unknown"}
                {selected.mimeType ? ` · ${selected.mimeType}` : ""}
              </p>

              {selected.graphql && (
                <div className="mt-3 rounded border border-indigo-100 bg-indigo-50/60 p-2">
                  <div className="flex items-center gap-2">
                    <GraphQLBadge
                      type={selected.graphql.operations[0]?.operationType}
                    />
                    <span className="font-semibold text-indigo-900">
                      {selected.graphql.isBatch
                        ? `GraphQL batch (${selected.graphql.operations.length} operations)`
                        : "GraphQL operation"}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-2">
                    {selected.graphql.operations.map((op, idx) => {
                      const armTarget = getOperationArmTarget(op);
                      return (
                      <li
                        key={idx}
                        className="rounded border border-indigo-100 bg-white p-2"
                      >
                        <p className="text-sm font-medium text-gray-900">
                          <span
                            className={`mr-1 rounded px-1 py-px text-[10px] font-bold uppercase ${operationTypeBadgeClass(op.operationType)}`}
                          >
                            {op.operationType}
                          </span>
                          {op.operationName ?? "(unnamed)"}
                          {op.isAnonymous && (
                            <span className="ml-1 text-xs text-gray-500">
                              (anonymous)
                            </span>
                          )}
                          {op.isPersisted && (
                            <span className="ml-1 text-xs text-amber-600">
                              [persisted]
                            </span>
                          )}
                        </p>
                        {op.query && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-gray-600 hover:text-gray-900">
                              Query
                            </summary>
                            <pre className="mt-1 max-h-40 overflow-auto rounded bg-gray-100 p-2 text-xs">
                              <code>{op.query}</code>
                            </pre>
                          </details>
                        )}
                        {op.variables !== undefined && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-gray-600 hover:text-gray-900">
                              Variables
                            </summary>
                            <pre className="mt-1 max-h-40 overflow-auto rounded bg-gray-100 p-2 text-xs">
                              <code>{formatVariables(op.variables)}</code>
                            </pre>
                          </details>
                        )}
                        {armTarget && (
                          <button
                            className="mt-1.5 rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-700"
                            title={`Pause when the ${op.operationType} "${armTarget}" is sent — other operations to this endpoint won't pause`}
                            onClick={() => breakOnGraphQLOperation(op)}
                          >
                            ⏸ Break when operation{" "}
                            <span className="font-mono">{armTarget}</span> fires
                          </button>
                        )}
                      </li>
                      );
                    })}
                  </ul>
                  <button
                    className="mt-2 rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-200"
                    title="URL-substring breakpoint (DOMDebugger.setXHRBreakpoint) — pauses on EVERY GraphQL operation sent to this endpoint, not just the one above"
                    onClick={breakOnSelectedUrl}
                  >
                    Break on ALL operations to this endpoint
                  </button>
                </div>
              )}

              <h2 className="mt-3 font-semibold">
                Initiator stack{" "}
                <span className="font-normal text-gray-500">
                  ({selected.initiatorType})
                </span>
                {resolving && (
                  <span className="ml-2 text-xs font-normal italic text-gray-400">
                    resolving…
                  </span>
                )}
              </h2>
              {displayFrames.length === 0 ? (
                <p className="mt-1 text-gray-500">
                  No JS initiator (parser or browser-initiated)
                </p>
              ) : (
                <ol className="mt-1 list-decimal space-y-1 pl-5">
                  {displayFrames.map((f, i) => {
                    // Origin chip only when the origin changes vs the previous
                    // real frame (MFE container/remote boundaries stay visible).
                    const origin = f.isAsyncSeparator ? null : originLabelOf(f.raw.url);
                    let prevOrigin: string | null = null;
                    for (let j = i - 1; j >= 0; j--) {
                      if (!displayFrames[j].isAsyncSeparator) {
                        prevOrigin = originLabelOf(displayFrames[j].raw.url);
                        break;
                      }
                    }
                    return (
                      <FrameRow
                        key={i}
                        frame={f}
                        mapStatus={mapStatuses[f.raw.scriptId]}
                        originChip={origin && origin !== prevOrigin ? origin : null}
                        onBreak={(fr) => void setBreakpointFromFrame(fr)}
                        onOpenSource={(fr) => {
                          if (fr.resolved) {
                            openOriginalSource(
                              fr.raw.scriptId,
                              fr.resolved.source,
                              fr.resolved.line,
                            );
                          }
                        }}
                        onOpenGenerated={openGeneratedSource}
                      />
                    );
                  })}
                </ol>
              )}
            </>
          )}
        </section>
      </div>

      <div className={view === "debug" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <Debugger
          breakpoints={breakpoints}
          xhrBreakpoints={xhrBreakpoints}
          eventBreakpoints={eventBreakpoints}
          functionBreakpoints={functionBreakpoints}
          gqlOpBreakpoints={gqlOpBreakpoints}
          handlerCandidates={handlerCandidates}
          framework={framework}
          askFramework={askFramework}
          paused={paused}
          breakpointError={breakpointError}
          scripts={scripts}
          refreshScripts={() => send({ type: "get-scripts" })}
          getScriptSource={getScriptSource}
          asyncDepth={status.asyncDepth}
          send={send}
          fetchProperties={fetchProperties}
          onOpenSource={openOriginalSource}
          onOpenGenerated={openGeneratedSource}
          requests={requests}
          config={config}
          onBreakAtCandidate={breakAtCandidate}
          onOpenSettings={() => setView("settings")}
          onOpenSourcesTab={() => setView("sources")}
          onExplain={(text) => {
            setPrefill({ text, nonce: Date.now() });
            setView("chat");
          }}
          onPickForHandler={(eventType) => {
            // Confident detection or explicit override → go straight to the
            // picker; otherwise ask the developer once (persisted per-origin).
            if (
              framework &&
              framework.framework !== "unknown" &&
              (framework.source === "override" || framework.confidence === "high")
            ) {
              startHandlerPick(eventType, framework.framework);
            } else {
              pendingHandlerEventRef.current = eventType;
              setAskFramework(true);
            }
          }}
          onDismissCandidates={() => setHandlerCandidates(null)}
          onChooseFramework={(choice) => void chooseFramework(choice)}
          onAiFallback={(eventType) => {
            aiFallbackRef.current = {
              eventType,
              framework: framework?.framework ?? "unknown",
            };
            send({ type: "set-event-breakpoint", eventName: eventType, oneShot: true });
          }}
        />
      </div>

      <div className={view === "sources" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <SourcesView
          scripts={scripts}
          statuses={mapStatuses}
          navigate={sourcesNav}
          refreshScripts={() => send({ type: "get-scripts" })}
          getScriptSource={getScriptSource}
          onAttach={(label, code) =>
            addAttachment({ kind: "source", label, text: code }, DEFAULT_QUESTIONS.source)
          }
          onBreakOnOriginalLine={breakOnOriginalLine}
        />
      </div>

      <div className={view === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <Chat
          config={config}
          onConfigChange={setConfig}
          prefill={prefill}
          onOpenSettings={() => setView("settings")}
          attachments={attachments}
          onRemoveAttachment={(id) =>
            setAttachments((prev) => prev.filter((a) => a.id !== id))
          }
          onClearAttachments={() => setAttachments([])}
        />
      </div>

      <div className={view === "settings" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <Settings config={config} onConfigChange={setConfig} />
      </div>
    </div>
  );
}

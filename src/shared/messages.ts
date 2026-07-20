export const PORT_NAME = "ai-devtools-panel";

export interface CallFrame {
  functionName: string;
  // CDP's Runtime.CallFrame carries scriptId on every real frame; "" only on
  // synthetic frames (async separators, parser initiators). Source-map
  // resolution keys off scriptId — NEVER off url, which may be empty or a
  // webpack:// pseudo-URL for eval'd Module Federation chunks.
  scriptId: string;
  url: string; // display only
  lineNumber: number;
  columnNumber: number;
}

export interface CapturedRequest {
  requestId: string;
  url: string;
  method: string;
  type?: string;
  status?: number;
  mimeType?: string;
  timestamp: number;
  headers?: Record<string, string>; // request headers (M3: AI context)
  initiatorType: string;
  initiatorStack: CallFrame[]; // empty array if none
  // ---- M6: GraphQL-aware request identification ----
  graphql?: GraphQLMeta;
}

// ---- M6: GraphQL operation metadata ----

export interface GraphQLOperation {
  operationName: string | null; // explicit or derived
  operationType: "query" | "mutation" | "subscription";
  isAnonymous: boolean;
  isPersisted: boolean;
  // Full text for the detail pane (omitted/trimmed when very large).
  query?: string;
  variables?: unknown;
}

export interface GraphQLMeta {
  isGraphQL: true;
  operations: GraphQLOperation[]; // 1 normally, >1 for batched requests
  isBatch: boolean;
}

// ---- M6 patch: GraphQL operation-scoped breakpoints ----

export interface GqlOpBreakpointInfo {
  target: string; // operation name matched by the in-page hook (or "persisted:<hash8>")
  label: string; // display label, e.g. "mutation SaveUser"
}

// ---- M4: breakpoints & pause inspection ----

export interface BreakpointInfo {
  breakpointId: string;
  url: string; // generated (minified) script URL
  lineNumber: number; // 0-based generated line (CDP convention)
  columnNumber?: number;
  originalLabel?: string; // e.g. "src/UserCard.tsx:34" when set via source map
  bound: boolean; // false = pending (script not loaded / no location matched yet)
  // M7: how the breakpoint was created — "lifecycle" ones get a distinct badge
  // and a bulk-clear action in the panel.
  tag?: string;
}

export interface PausedScope {
  type: string; // "local" | "closure" | "global" | ...
  objectId?: string;
}

export interface PausedFrame {
  functionName: string; // "[async: …]" rows are separator frames (M7)
  scriptId: string; // resolution key; "" only on separator rows
  url: string; // resolved from scriptId worker-side; "" if unknown
  lineNumber: number; // 0-based
  columnNumber: number;
  scopeChain: PausedScope[]; // empty for async parent frames
}

export interface PausedSnapshot {
  // Stable per LOGICAL pause, even across multiple "paused" messages for the
  // same pause (e.g. the GraphQL-operation detail refinement re-sends this
  // snapshot once the matched operation name resolves). Every "paused"
  // message is a fresh object after structured-clone across the port, so
  // consumers that need "is this still the same pause" must compare pauseId,
  // never object identity.
  pauseId: number;
  // "other" for line breakpoints, "XHR" for XHR breakpoints, ... Synthesized
  // worker-side: "GraphQLOperation" for the in-page GraphQL hook's pauses.
  reason: string;
  detail?: string; // e.g. the matching URL for XHR pauses, op names for GraphQL
  hitBreakpoints: string[];
  callFrames: PausedFrame[];
}

// ---- M4 patch: interaction breakpoints ----

export interface EventBreakpointInfo {
  eventName: string; // "click", "submit", ...
  oneShot: boolean; // auto-clears after its first pause
}

export interface FunctionBreakpointInfo {
  id: string; // CDP breakpointId from setBreakpointOnFunctionCall
  label: string; // e.g. `click handler on button#save`
}

export interface ListenerInfo {
  type: string; // event type, e.g. "click"
  useCapture: boolean;
  handlerObjectId?: string; // the handler function's objectId (breakable)
  description: string; // handler function preview
  node: string; // where it's attached, e.g. "button#save.btn" / "#document"
  origin: "element" | "ancestor" | "document";
}

// ---- M4 enhancement: framework-aware handler detection ----

export type FrameworkId = "react" | "angular" | "vue" | "vanilla";

export interface FrameworkResolution {
  framework: FrameworkId | "unknown";
  confidence: "high" | "low";
  source: "override" | "detected";
}

export interface ExtractedHandler {
  handlerObjectId: string; // the REAL handler function (bound fns unwrapped)
  description: string; // function preview
  via: string; // how it was found, e.g. "React onClick prop"
  scriptId?: string; // from [[FunctionLocation]] — the resolution key
  url?: string; // generated script URL, display only
  lineNumber?: number; // 0-based generated
  columnNumber?: number;
}

export interface RemoteProperty {
  name: string;
  type: string; // "string" | "number" | "object" | "function" | ... (subtype-qualified)
  description?: string; // printable value / preview
  objectId?: string; // present => expandable
}

// ---- M5: screenshots, element picker, source reading ----

export interface PickedElement {
  tagName: string;
  id?: string;
  classList: string[];
  attributes: Record<string, string>;
  outerHTMLTruncated: string;
  selector: string;
  // Page-absolute CSS pixels (getBoundingClientRect + scroll offset) so the
  // rect can be used directly as a Page.captureScreenshot clip.
  rect: { x: number; y: number; width: number; height: number };
  computedStyles: Record<string, string>; // curated subset
}

/** Runtime messages sent by the injected picker (content script -> worker). */
export type PickerMessage =
  | { type: "element-picked"; payload: PickedElement }
  | { type: "picker-cancelled" };

export interface ScriptInfo {
  scriptId: string;
  url: string; // may be "", or a webpack:// pseudo-URL for eval'd modules
  // Straight off Debugger.scriptParsed — external URL, relative URL, or an
  // inline data: URI (webpack eval-source-map). This is the source of truth
  // for map discovery; the script text is never fetched or regexed.
  sourceMapURL?: string;
  hasSourceURL?: boolean; // eval'd scripts named via //# sourceURL=
  executionContextId?: number;
}

// ---- Source-map fetch (worker performs it — it owns the debugger; the panel
// owns SourceMapConsumer + caches). The primary path is CDP
// Network.loadNetworkResource, which fetches in the PAGE's network context
// with the page's cookies/credentials — same as DevTools — so maps behind
// auth resolve. Every failure carries an explicit machine-readable reason so
// the UI can always answer "why isn't it using the real files?". ----

export type SourceMapFetchResult =
  | {
      ok: true;
      scriptId: string;
      mapUrl: string; // "(inline data: URI)" for embedded maps
      inline: boolean;
      mapJson: string;
    }
  | {
      ok: false;
      scriptId: string;
      mapUrl?: string;
      reason:
        | "no-map" // scriptParsed had no sourceMapURL
        | "unresolvable-url" // relative ref with no resolvable base (webpack://)
        | "mixed-content" // HTTPS page + HTTP non-localhost map (MFE remotes)
        | "fetch-failed";
      httpStatus?: number;
      netError?: string;
      message: string;
    };

export type ScreenshotMode = "viewport" | "fullpage" | "clip";

export type PanelToBg =
  | { type: "get-status" }
  | { type: "clear-requests" }
  | { type: "reattach-active-tab" }
  | {
      type: "set-breakpoint";
      url: string; // "" for eval'd/anonymous scripts — scriptId is used instead
      scriptId?: string; // enables Debugger.setBreakpoint when url is unusable
      lineNumber: number; // 0-based generated line
      columnNumber?: number;
      originalLabel?: string;
      tag?: string; // e.g. "lifecycle" (see BreakpointInfo.tag)
    }
  | { type: "remove-breakpoint"; breakpointId: string }
  | { type: "set-xhr-breakpoint"; url: string } // substring match; "" = all requests
  | { type: "remove-xhr-breakpoint"; url: string }
  | { type: "set-gql-op-breakpoint"; target: string; label: string }
  | { type: "remove-gql-op-breakpoint"; target: string }
  | { type: "resume" }
  | { type: "step-over" }
  | { type: "step-into" }
  | { type: "step-out" }
  | { type: "get-properties"; objectId: string; requestToken: number }
  | {
      type: "capture-screenshot";
      mode: ScreenshotMode;
      clip?: { x: number; y: number; width: number; height: number };
      requestToken: number;
    }
  | { type: "activate-picker" }
  | { type: "get-scripts" }
  | { type: "get-script-source"; scriptId: string; requestToken: number }
  | { type: "set-event-breakpoint"; eventName: string; oneShot: boolean }
  | { type: "remove-event-breakpoint"; eventName: string }
  | { type: "set-function-breakpoint"; handlerObjectId: string; label: string }
  | { type: "remove-function-breakpoint"; id: string }
  | { type: "get-framework"; requestToken: number }
  | {
      type: "set-framework-override";
      framework: FrameworkId | "auto";
      requestToken: number;
    }
  | {
      type: "extract-handler";
      selector: string;
      eventType: string;
      framework: FrameworkId;
      requestToken: number;
    }
  | { type: "set-blackbox-patterns"; patterns: string[] }
  // Source-map fetch through the worker (CDP page-context; see SourceMapFetchResult)
  | { type: "fetch-source-map"; scriptId: string; requestToken: number }
  // Original-source fetch (when a map has no sourcesContent) — same page-context path
  | { type: "fetch-page-resource"; url: string; requestToken: number }
  // ---- M7: lifecycle & load-time capture ----
  | { type: "reload-and-capture" } // re-arm everything, then Page.reload
  | { type: "set-auto-capture"; enabled: boolean } // persisted per-origin
  | { type: "set-async-depth"; maxDepth: number }; // persisted globally

export type BgToPanel =
  | {
      type: "status";
      attached: boolean;
      tabId: number | null;
      tabTitle?: string;
      error?: string;
      // ---- M7: lifecycle & load-time capture ----
      // True when we attached to a page that had already finished loading —
      // its init-time requests fired before we were listening.
      alreadyLoaded?: boolean;
      autoCapture?: boolean; // per-origin "auto-capture on reload" toggle
      asyncDepth?: number; // current Debugger.setAsyncCallStackDepth maxDepth
    }
  | { type: "request-added"; request: CapturedRequest }
  | {
      type: "request-updated";
      requestId: string;
      status?: number;
      mimeType?: string;
      graphql?: GraphQLMeta;
    }
  | { type: "requests-cleared" }
  | { type: "requests-snapshot"; requests: CapturedRequest[] }
  | {
      type: "breakpoints";
      breakpoints: BreakpointInfo[];
      xhrBreakpoints: string[];
      eventBreakpoints: EventBreakpointInfo[];
      functionBreakpoints: FunctionBreakpointInfo[];
      gqlOpBreakpoints: GqlOpBreakpointInfo[];
    }
  | { type: "breakpoint-error"; error: string }
  | { type: "paused"; state: PausedSnapshot }
  | { type: "resumed" }
  | {
      type: "properties";
      requestToken: number;
      properties: RemoteProperty[];
      error?: string;
    }
  | { type: "screenshot"; requestToken: number; dataUrl?: string; error?: string }
  | { type: "element-picked"; payload: PickedElement }
  | { type: "picker-cancelled" }
  | { type: "scripts"; scripts: ScriptInfo[] }
  // Live registry updates — MFE remote chunks parse long after load (lazy
  // routes), so the diagnostics list must grow as scriptParsed events arrive.
  | { type: "script-parsed"; script: ScriptInfo }
  | { type: "source-map"; requestToken: number; result: SourceMapFetchResult }
  | { type: "page-resource"; requestToken: number; content?: string; error?: string }
  | { type: "script-source"; requestToken: number; source?: string; error?: string }
  | { type: "framework"; requestToken: number; resolution: FrameworkResolution }
  | {
      type: "handler-candidates";
      requestToken: number;
      candidates: ExtractedHandler[];
      error?: string;
    };

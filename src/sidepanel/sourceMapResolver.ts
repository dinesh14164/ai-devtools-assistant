import { SourceMapConsumer } from "source-map";
import mappingsWasmUrl from "source-map/lib/mappings.wasm?url";
import type { CallFrame, SourceMapFetchResult } from "../shared/messages";

// M2 rework: consumers are keyed by SCRIPT ID, not URL — eval'd Module
// Federation modules have empty or webpack:// pseudo-URLs, so the URL is
// display-only. Map discovery/fetching moved to the worker (scriptParsed's
// sourceMapURL + CDP page-context fetch); this module keeps ownership of
// SourceMapConsumer construction and the consumer cache (WASM stays
// panel-side), and now tracks an explicit per-script status so no failure is
// ever silent.

export interface ResolvedFrame {
  raw: CallFrame; // the original minified frame
  resolved?: {
    source: string; // original file, e.g. "src/components/UserCard.tsx"
    line: number; // 1-based original line
    column: number;
    name: string | null; // original function name if available
  };
  isAsyncSeparator: boolean; // true for the [async: ...] rows from the M1 patch
}

// ---- Per-script resolution status (Fix 4: never fail silently) ----

export type SourceMapStatus =
  | { state: "resolved"; sourcesCount: number; mapUrl: string; inline: boolean }
  | { state: "no-map"; detail?: string } // scriptParsed had no sourceMapURL
  | {
      state: "fetch-failed";
      httpStatus?: number;
      netError?: string;
      mapUrl: string;
      mixedContent?: boolean;
    }
  | { state: "parse-failed"; error: string; mapUrl: string }
  | { state: "pending" };

// Immutable snapshot object, replaced on every change — lets React consume it
// via useSyncExternalStore without tearing.
let statuses: Record<string, SourceMapStatus> = {};
const statusListeners = new Set<() => void>();

function setStatus(scriptId: string, status: SourceMapStatus) {
  statuses = { ...statuses, [scriptId]: status };
  for (const l of statusListeners) l();
}

export function getSourceMapStatuses(): Record<string, SourceMapStatus> {
  return statuses;
}

export function subscribeSourceMapStatuses(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** One-line human answer to "why isn't this frame using the real file?". */
export function describeSourceMapStatus(status: SourceMapStatus | undefined): string {
  if (!status) return "source map not loaded yet";
  switch (status.state) {
    case "resolved":
      return `map resolved (${status.sourcesCount} sources, ${status.inline ? "inline" : status.mapUrl})`;
    case "no-map":
      return status.detail ?? "no source map";
    case "fetch-failed":
      if (status.mixedContent) return "map blocked: mixed content (HTTPS page, HTTP map)";
      return `map fetch failed: ${
        status.httpStatus ?? status.netError ?? "network error"
      }`;
    case "parse-failed":
      return `map parse error: ${status.error}`;
    case "pending":
      return "map loading…";
  }
}

// ---- Worker bridge: the worker owns the debugger attachment and performs
// the actual fetches (page network context, with credentials). ----

export interface WorkerBridge {
  fetchSourceMap(scriptId: string): Promise<SourceMapFetchResult>;
  fetchPageResource(url: string): Promise<string>;
}

let bridge: WorkerBridge | null = null;

export function configureWorkerBridge(b: WorkerBridge | null) {
  bridge = b;
}

// The bundled source-map types omit `initialize`, which exists at runtime and
// is required in browser contexts before any consumer is constructed.
const SourceMapConsumerStatics = SourceMapConsumer as unknown as {
  initialize(opts: { "lib/mappings.wasm": string | ArrayBuffer }): void;
};

let initPromise: Promise<boolean> | null = null;

function ensureInit(): Promise<boolean> {
  if (!initPromise) {
    initPromise = Promise.resolve()
      .then(() => {
        SourceMapConsumerStatics.initialize({ "lib/mappings.wasm": mappingsWasmUrl });
        return true;
      })
      .catch((e) => {
        console.warn("[sourceMapResolver] WASM init failed; frames stay raw.", e);
        return false;
      });
  }
  return initPromise;
}

// Keying the cache by promise dedupes concurrent loads of the same script's
// map; a resolved `null` is a cached negative ("known unresolvable" — the
// WHY lives in the status registry above).
const consumerCache = new Map<string, Promise<SourceMapConsumer | null>>();
const requestCache = new Map<string, Promise<ResolvedFrame[]>>();

async function loadConsumer(scriptId: string): Promise<SourceMapConsumer | null> {
  if (!(await ensureInit())) return null;
  if (!bridge) {
    setStatus(scriptId, {
      state: "fetch-failed",
      mapUrl: "",
      netError: "panel not connected to the worker yet",
    });
    return null;
  }
  setStatus(scriptId, { state: "pending" });
  const result = await bridge.fetchSourceMap(scriptId);
  if (!result.ok) {
    if (result.reason === "no-map" || result.reason === "unresolvable-url") {
      setStatus(scriptId, { state: "no-map", detail: result.message });
    } else {
      setStatus(scriptId, {
        state: "fetch-failed",
        mapUrl: result.mapUrl ?? "",
        httpStatus: result.httpStatus,
        netError: result.netError ?? result.message,
        mixedContent: result.reason === "mixed-content",
      });
    }
    return null;
  }
  try {
    const consumer = await new SourceMapConsumer(JSON.parse(result.mapJson));
    setStatus(scriptId, {
      state: "resolved",
      sourcesCount: (consumer as unknown as { sources: string[] }).sources.length,
      mapUrl: result.mapUrl,
      inline: result.inline,
    });
    return consumer;
  } catch (e) {
    setStatus(scriptId, {
      state: "parse-failed",
      error: e instanceof Error ? e.message : String(e),
      mapUrl: result.mapUrl,
    });
    return null;
  }
}

function getConsumer(scriptId: string): Promise<SourceMapConsumer | null> {
  if (!scriptId) return Promise.resolve(null);
  let promise = consumerCache.get(scriptId);
  if (!promise) {
    promise = loadConsumer(scriptId).catch((e) => {
      // Port died mid-fetch etc. — recorded in the status, cached as negative.
      setStatus(scriptId, {
        state: "fetch-failed",
        mapUrl: "",
        netError: e instanceof Error ? e.message : String(e),
      });
      return null;
    });
    consumerCache.set(scriptId, promise);
  }
  return promise;
}

/**
 * Drop the (possibly negative) cached consumer for one script and re-resolve.
 * Diagnostics-panel "Retry" and first-time lazy loads both land here.
 */
export function retrySourceMap(scriptId: string): Promise<boolean> {
  const existing = consumerCache.get(scriptId);
  consumerCache.delete(scriptId);
  existing?.then((c) => c?.destroy()).catch(() => {});
  // Cached stack resolutions may embed the old failure; re-resolve on demand.
  requestCache.clear();
  return getConsumer(scriptId).then((c) => c !== null);
}

async function resolveFrame(frame: CallFrame): Promise<ResolvedFrame> {
  if (frame.functionName.startsWith("[async:")) {
    return { raw: frame, isAsyncSeparator: true };
  }
  // scriptId is the key; url is display-only (may be "" or webpack://).
  const consumer = await getConsumer(frame.scriptId);
  if (!consumer) return { raw: frame, isAsyncSeparator: false };
  try {
    // CDP positions are 0-based; originalPositionFor wants a 1-based line and
    // a 0-based column.
    const pos = consumer.originalPositionFor({
      line: frame.lineNumber + 1,
      column: frame.columnNumber,
    });
    if (pos.source == null || pos.line == null) {
      return { raw: frame, isAsyncSeparator: false };
    }
    return {
      raw: frame,
      resolved: {
        source: pos.source,
        line: pos.line,
        column: pos.column ?? 0,
        name: pos.name ?? null,
      },
      isAsyncSeparator: false,
    };
  } catch {
    return { raw: frame, isAsyncSeparator: false };
  }
}

export interface OriginalLocation {
  source: string; // exact `sources` entry from the map — reusable in reverse
  line: number; // 1-based
  column: number;
  name: string | null;
}

/**
 * Forward direction (minified -> original) for a single CDP location, e.g. a
 * paused call frame. CDP lines are 0-based. Keyed by scriptId.
 */
export async function resolveOriginalLocation(
  scriptId: string,
  lineNumber: number,
  columnNumber: number,
): Promise<OriginalLocation | null> {
  const consumer = await getConsumer(scriptId);
  if (!consumer) return null;
  try {
    const pos = consumer.originalPositionFor({
      line: lineNumber + 1,
      column: columnNumber,
    });
    if (pos.source == null || pos.line == null) return null;
    return {
      source: pos.source,
      line: pos.line,
      column: pos.column ?? 0,
      name: pos.name ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Reverse direction (original -> generated), for setting breakpoints (M4).
 * `originalSource` must be the EXACT string that came out of
 * originalPositionFor / the map's `sources` — never a prettified display path.
 * Returns a CDP-convention location (0-based line) or null when the original
 * line has no generated mapping (dead code, inlined away).
 */
export async function resolveGeneratedPosition(
  scriptId: string,
  originalSource: string,
  originalLine: number, // 1-based
): Promise<{ lineNumber: number; columnNumber: number } | null> {
  const consumer = await getConsumer(scriptId);
  if (!consumer) return null;
  try {
    let pos = consumer.generatedPositionFor({
      source: originalSource,
      line: originalLine,
      column: 0,
      bias: SourceMapConsumer.LEAST_UPPER_BOUND,
    });
    if (pos.line == null) {
      pos = consumer.generatedPositionFor({
        source: originalSource,
        line: originalLine,
        column: 0,
        bias: SourceMapConsumer.GREATEST_LOWER_BOUND,
      });
    }
    if (pos.line == null) return null;
    // source-map lines are 1-based; CDP wants 0-based. One original line can
    // map to several generated spots — this lands on the first match.
    return { lineNumber: pos.line - 1, columnNumber: pos.column ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Original sources listed in a script's map (exact `sources` strings), or null
 * when the script has no usable map. (M5 sources view.)
 */
export async function getOriginalSources(scriptId: string): Promise<string[] | null> {
  const consumer = await getConsumer(scriptId);
  if (!consumer) return null;
  // `sources` is on the concrete consumer classes, not the base interface.
  return (consumer as unknown as { sources: string[] }).sources;
}

/**
 * The embedded original file content (`sourcesContent`) for one source, or
 * null when the map doesn't embed it. Preferred path: webpack maps almost
 * always embed the original TS/JS — no network, no auth.
 */
export async function getOriginalSourceContent(
  scriptId: string,
  source: string,
): Promise<string | null> {
  const consumer = await getConsumer(scriptId);
  if (!consumer) return null;
  try {
    return consumer.sourceContentFor(source, true);
  } catch {
    return null;
  }
}

/**
 * Fallback when sourcesContent is absent: fetch the original file itself via
 * the worker's page-context path (same credentials story as the map). Only
 * possible when the source resolves to an http(s) URL — webpack:// pseudo
 * paths without embedded content are genuinely unreachable.
 */
export async function fetchOriginalSourceOverNetwork(
  scriptId: string,
  source: string,
): Promise<string | null> {
  if (!bridge) return null;
  let abs: string | null = null;
  if (/^https?:\/\//.test(source)) {
    abs = source;
  } else {
    const status = statuses[scriptId];
    if (status?.state === "resolved" && /^https?:\/\//.test(status.mapUrl)) {
      try {
        abs = new URL(source, status.mapUrl).href;
      } catch {
        abs = null;
      }
    }
  }
  if (!abs || !/^https?:\/\//.test(abs)) return null;
  try {
    return await bridge.fetchPageResource(abs);
  } catch {
    return null;
  }
}

export function resolveRequestStack(
  requestId: string,
  frames: CallFrame[],
): Promise<ResolvedFrame[]> {
  let promise = requestCache.get(requestId);
  if (!promise) {
    promise = Promise.all(frames.map(resolveFrame));
    requestCache.set(requestId, promise);
  }
  return promise;
}

/** Requests are gone (Clear / requests-cleared) but the page is the same. */
export function clearRequestCache() {
  requestCache.clear();
}

/** New page context (re-attach) or panel teardown: drop everything. */
export function clearAllCaches() {
  requestCache.clear();
  for (const promise of consumerCache.values()) {
    promise.then((c) => c?.destroy()).catch(() => {});
  }
  consumerCache.clear();
  statuses = {};
  for (const l of statusListeners) l();
}

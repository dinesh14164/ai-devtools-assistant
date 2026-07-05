import { SourceMapConsumer } from "source-map";
import mappingsWasmUrl from "source-map/lib/mappings.wasm?url";
import type { CallFrame } from "../shared/messages";

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
// map; a resolved `null` is a cached negative ("known to have no usable map").
const consumerCache = new Map<string, Promise<SourceMapConsumer | null>>();
const requestCache = new Map<string, Promise<ResolvedFrame[]>>();

function extractSourceMappingURL(scriptText: string): string | null {
  const re = /\/\/[#@][ \t]*sourceMappingURL=([^\s'"]+)/g;
  let last: string | null = null;
  for (const m of scriptText.matchAll(re)) last = m[1];
  return last;
}

function decodeDataUri(uri: string): string {
  const comma = uri.indexOf(",");
  if (comma === -1) throw new Error("malformed data URI");
  const meta = uri.slice(0, comma);
  const data = uri.slice(comma + 1);
  if (!/;base64/i.test(meta)) return decodeURIComponent(data);
  const binary = atob(data);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function loadConsumer(scriptUrl: string): Promise<SourceMapConsumer | null> {
  if (!(await ensureInit())) return null;
  const scriptRes = await fetch(scriptUrl);
  if (!scriptRes.ok) return null;
  const mapRef = extractSourceMappingURL(await scriptRes.text());
  if (!mapRef) return null;

  let mapJson: string;
  if (mapRef.startsWith("data:")) {
    mapJson = decodeDataUri(mapRef);
  } else {
    const mapRes = await fetch(new URL(mapRef, scriptUrl).href);
    if (!mapRes.ok) return null;
    mapJson = await mapRes.text();
  }
  return await new SourceMapConsumer(JSON.parse(mapJson));
}

function getConsumer(scriptUrl: string): Promise<SourceMapConsumer | null> {
  let promise = consumerCache.get(scriptUrl);
  if (!promise) {
    promise = loadConsumer(scriptUrl).catch((e) => {
      // One debug line per script URL (the failure is cached), not per frame.
      // CORS-blocked or missing third-party maps land here and are expected.
      console.debug(`[sourceMapResolver] no usable map for ${scriptUrl}:`, e);
      return null;
    });
    consumerCache.set(scriptUrl, promise);
  }
  return promise;
}

async function resolveFrame(frame: CallFrame): Promise<ResolvedFrame> {
  if (frame.functionName.startsWith("[async:")) {
    return { raw: frame, isAsyncSeparator: true };
  }
  if (!frame.url) return { raw: frame, isAsyncSeparator: false };

  const consumer = await getConsumer(frame.url);
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
 * paused call frame. CDP lines are 0-based.
 */
export async function resolveOriginalLocation(
  scriptUrl: string,
  lineNumber: number,
  columnNumber: number,
): Promise<OriginalLocation | null> {
  if (!scriptUrl) return null;
  const consumer = await getConsumer(scriptUrl);
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
  scriptUrl: string,
  originalSource: string,
  originalLine: number, // 1-based
): Promise<{ lineNumber: number; columnNumber: number } | null> {
  const consumer = await getConsumer(scriptUrl);
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
export async function getOriginalSources(scriptUrl: string): Promise<string[] | null> {
  const consumer = await getConsumer(scriptUrl);
  if (!consumer) return null;
  // `sources` is on the concrete consumer classes, not the base interface.
  return (consumer as unknown as { sources: string[] }).sources;
}

/**
 * The embedded original file content (`sourcesContent`) for one source, or
 * null when the map doesn't embed it.
 */
export async function getOriginalSourceContent(
  scriptUrl: string,
  source: string,
): Promise<string | null> {
  const consumer = await getConsumer(scriptUrl);
  if (!consumer) return null;
  try {
    return consumer.sourceContentFor(source, true);
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
}

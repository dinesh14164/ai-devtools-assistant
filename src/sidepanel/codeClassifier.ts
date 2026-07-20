// M7: the shared "my code" classifier. Both discovery triggers use it —
// interaction-triggered (element handler / event breakpoint) and
// request-triggered (XHR / GraphQL-operation pauses) — the pipeline is the
// same, only the trigger differs. Fully generic: classification is driven by
// URL/source patterns (the user's blackbox/ignore list plus built-ins), never
// by app-, component-, or function-specific names.

// Three states, not two. A frame can only earn "user" through a SUCCESSFUL
// source-map resolution to a non-ignored path — an unresolved frame (no map,
// map fetch failed) is "unknown", never "user". Treating unresolved-and-not-
// ignore-listed as "user" was a real bug: in a Module Federation app where a
// remote's maps fail to load, this manufactures dozens of phantom "your
// code" frames that have no source behind them, and the entry-point agent's
// stack summary would then contradict its own conclusion (e.g. "73 in your
// code" followed by "no user frames were present").
export type FrameClass = "user" | "framework" | "unknown" | "separator";

/** Minimal shape shared by PausedFrame and CallFrame. */
export interface ClassifiableFrame {
  functionName: string;
  url: string;
}

// Always treated as framework territory regardless of the user's ignore list:
// dependency bundles, bundler runtime, Angular's zone.js, and our own
// extension code. Applied to both the generated URL and the source-mapped
// original path (webpack:///node_modules/... etc.).
const BUILTIN_IGNORE: RegExp[] = [
  /node_modules/,
  /^chrome-extension:/,
  /zone\.js/,
  /webpack\/(runtime|bootstrap)/,
  /^\[native/,
];

/** Compile the user's ignore/blackbox patterns, dropping invalid regexes. */
export function compileIgnorePatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    if (!p.trim()) continue;
    try {
      out.push(new RegExp(p));
    } catch {
      // an unparseable pattern shouldn't break classification
    }
  }
  return out;
}

/**
 * Classify a single already-known PATH (e.g. an entry from a resolved map's
 * `sources` list, or a generated script URL used purely as a filter) against
 * the ignore list. This is NOT about stack-frame resolution — the caller
 * already knows `path` is a real, known file; the only question is whether
 * it's ignore-listed territory. Used by search/scan tools that walk a map's
 * `sources` deciding which files to skip (vendor code inside the map).
 */
export function classifyPath(path: string, ignorePatterns: RegExp[]): "user" | "framework" {
  if (!path) return "framework";
  for (const re of BUILTIN_IGNORE) if (re.test(path)) return "framework";
  for (const re of ignorePatterns) if (re.test(path)) return "framework";
  return "user";
}

/**
 * Classify one RUNTIME STACK FRAME. `resolvedSource` is the source-mapped
 * original path when available — it's the better signal (a vendor chunk URL
 * tells you nothing; `webpack:///node_modules/rxjs/...` does), and is
 * REQUIRED for a "user" verdict: only a frame that actually resolved through
 * a source map to a non-ignored path can be the developer's own code. An
 * unresolved frame that isn't ignore-listed is "unknown" — we have no source
 * behind it, so we cannot claim it's user code; it just as easily means the
 * relevant script's source map failed to load (see sourceMapResolver.ts).
 */
export function classifyFrame(
  frame: ClassifiableFrame,
  resolvedSource: string | null,
  ignorePatterns: RegExp[],
): FrameClass {
  if (frame.functionName.startsWith("[async:")) return "separator";
  // No URL = native/VM/injected code — never the developer's own file.
  if (!frame.url) return "framework";
  const candidates = resolvedSource ? [frame.url, resolvedSource] : [frame.url];
  for (const text of candidates) {
    for (const re of BUILTIN_IGNORE) if (re.test(text)) return "framework";
    for (const re of ignorePatterns) if (re.test(text)) return "framework";
  }
  return resolvedSource ? "user" : "unknown";
}

/**
 * The discovery entry point: the OUTERMOST user-code frame. Stacks are
 * innermost-first, so walk from the end (deepest async parent) toward the top
 * and take the first user frame — the function in the developer's code that
 * started the chain (e.g. a lifecycle hook). Mirrors the interaction case's
 * "first user-code frame in execution order", derived from an existing stack
 * instead of by stepping. Returns -1 when no frame classifies as user code
 * (broken async chain, or — now distinguishable via the caller's own class
 * counts — a source-map problem) — the caller must surface guidance, not
 * fail silently.
 */
export function findEntryPointIndex(classes: FrameClass[]): number {
  for (let i = classes.length - 1; i >= 0; i--) {
    if (classes[i] === "user") return i;
  }
  return -1;
}

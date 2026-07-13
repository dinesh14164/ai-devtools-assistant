// M7: the shared "my code" classifier. Both discovery triggers use it —
// interaction-triggered (element handler / event breakpoint) and
// request-triggered (XHR / GraphQL-operation pauses) — the pipeline is the
// same, only the trigger differs. Fully generic: classification is driven by
// URL/source patterns (the user's blackbox/ignore list plus built-ins), never
// by app-, component-, or function-specific names.

export type FrameClass = "user" | "framework" | "separator";

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
 * Classify one frame. `resolvedSource` is the source-mapped original path
 * when available — it's the better signal (a vendor chunk URL tells you
 * nothing; `webpack:///node_modules/rxjs/...` does).
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
  return "user";
}

/**
 * The discovery entry point: the OUTERMOST user-code frame. Stacks are
 * innermost-first, so walk from the end (deepest async parent) toward the top
 * and take the first user frame — the function in the developer's code that
 * started the chain (e.g. a lifecycle hook). Mirrors the interaction case's
 * "first user-code frame in execution order", derived from an existing stack
 * instead of by stepping. Returns -1 when no frame classifies as user code
 * (broken async chain — the caller must surface guidance, not fail silently).
 */
export function findEntryPointIndex(classes: FrameClass[]): number {
  for (let i = classes.length - 1; i >= 0; i--) {
    if (classes[i] === "user") return i;
  }
  return -1;
}

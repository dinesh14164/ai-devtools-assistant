// M7: lifecycle-hook scanning over the user's own sources. Deterministic
// fallback (and direct approach) for when async chains are too mangled for
// request-triggered discovery: break at the lifecycle definition itself
// instead of tracing back from the request. Framework-aware only in the
// DEFAULT name lists — the scan itself is a generic identifier search, and
// the lists are user-editable.

export const DEFAULT_LIFECYCLE_HOOKS: Record<string, string[]> = {
  angular: [
    "ngOnInit",
    "ngOnChanges",
    "ngAfterViewInit",
    "ngAfterContentInit",
    "ngOnDestroy",
    "ngDoCheck",
  ],
  react: ["useEffect", "useLayoutEffect", "componentDidMount", "componentDidUpdate"],
  vue: ["mounted", "onMounted", "created", "watch", "onUpdated"],
  vanilla: [],
  unknown: [],
};

export interface LifecycleHit {
  name: string; // the hook name that matched
  line: number; // 1-based line in the scanned text
  snippet: string; // the matching line, trimmed, for display
}

const MAX_HITS_PER_FILE = 25;

/**
 * One regex per hook name. Matches definitions AND registration call sites —
 * `ngOnInit() {`, `useEffect(() => …`, `mounted() {`, `watch: {` — while
 * rejecting member calls like `this.ngOnInit()` (a preceding `.` means it's
 * an invocation on an instance, not where the hook lives). Heuristic by
 * design: for call-style hooks (useEffect, onMounted) the call site IS the
 * right place to break.
 */
export function buildHookRegex(name: string): RegExp | null {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return null; // identifiers only
  return new RegExp(`(?:^|[^.\\w$])${name}\\s*[(:=]`);
}

/** Scan one file's text for lifecycle hook occurrences, line by line. */
export function scanSourceForHooks(text: string, hookNames: string[]): LifecycleHit[] {
  const regexes = hookNames
    .map((name) => ({ name, re: buildHookRegex(name) }))
    .filter((h): h is { name: string; re: RegExp } => h.re !== null);
  if (regexes.length === 0) return [];
  const hits: LifecycleHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && hits.length < MAX_HITS_PER_FILE; i++) {
    const line = lines[i];
    // Skip obvious comment lines; cheap filter, not a parser.
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    for (const { name, re } of regexes) {
      if (re.test(line)) {
        hits.push({ name, line: i + 1, snippet: trimmed.slice(0, 120) });
        break; // one hit per line is enough for display/arming
      }
    }
  }
  return hits;
}

/** Parse the user-editable hook list (comma/newline separated). */
export function parseHookList(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
}

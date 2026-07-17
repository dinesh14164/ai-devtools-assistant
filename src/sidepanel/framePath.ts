// Frame path display helpers (Part B of the entry-point feature). Hosts and
// bundler prefixes bury the useful part of a location; these strip them for
// DISPLAY ONLY — resolution and reverse mapping always use the exact original
// strings. Nothing here is app-specific: the rules are scheme/structure-based.

const KEEP_FIRST_SEGMENT = new Set(["src", "app", "node_modules", "packages", "lib"]);

/**
 * Project-relative form of a source-map `sources` entry or script URL.
 * `webpack:///./src/a.ts`, `webpack://my-app/src/a.ts`, and
 * `https://host/src/a.ts` all become `src/a.ts`.
 */
export function prettySourcePath(source: string): string {
  if (!source) return source;
  let p = source;
  if (/^https?:\/\//.test(p)) {
    try {
      p = new URL(p).pathname.replace(/^\/+/, "");
    } catch {
      return source;
    }
  } else if (p.startsWith("webpack://")) {
    p = p.slice("webpack://".length).replace(/^\/+/, "");
    // A leading namespace segment (the project name) precedes the real path in
    // webpack 5 maps. Heuristic: dot-less first segment that isn't a common
    // top-level source dir is a namespace — drop it.
    const slash = p.indexOf("/");
    if (slash > 0) {
      const first = p.slice(0, slash);
      if (!first.includes(".") && !KEEP_FIRST_SEGMENT.has(first)) {
        p = p.slice(slash + 1);
      }
    }
  }
  while (p.startsWith("./")) p = p.slice(2);
  return p || source;
}

/** Last path segment of a URL/path (query/hash stripped) — for minified bundles. */
export function fileNameOf(url: string): string {
  if (!url) return url;
  let p = url;
  try {
    if (/^https?:\/\//.test(p)) p = new URL(p).pathname;
  } catch {
    // keep raw
  }
  p = p.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1) || p;
}

/**
 * Origin label for the per-frame chip (host[:port]); null when there is no
 * meaningful origin (webpack:// pseudo-URLs, eval'd scripts, empty URLs).
 */
export function originLabelOf(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.host;
    return null;
  } catch {
    return null;
  }
}

/** Leading-ellipsis truncation keeping the distinguishing tail visible. */
export function truncateStart(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - max + 1)}`;
}

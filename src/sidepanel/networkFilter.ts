import type { CapturedRequest, GraphQLOperation } from "../shared/messages";

// Network request filtering & search (display-only — never mutates or drops
// captured request state; clearing a filter/search restores everything
// instantly because `requests` in App.tsx is untouched).

// ---- Type buckets (Part A) ----

export type TypeBucket =
  | "fetch-xhr"
  | "graphql"
  | "js"
  | "css"
  | "img"
  | "font"
  | "doc"
  | "ws"
  | "other";

export const TYPE_BUCKET_LABELS: Record<TypeBucket, string> = {
  "fetch-xhr": "Fetch/XHR",
  graphql: "GraphQL",
  js: "JS",
  css: "CSS",
  img: "Img",
  font: "Font",
  doc: "Doc",
  ws: "WS",
  other: "Other",
};

export const TYPE_BUCKET_ORDER: TypeBucket[] = [
  "fetch-xhr",
  "graphql",
  "js",
  "css",
  "img",
  "font",
  "doc",
  "ws",
  "other",
];

/** GraphQL is a metadata-derived bucket (existing graphql.isGraphQL), not a raw CDP type. */
export function bucketOf(request: CapturedRequest): TypeBucket {
  if (request.graphql?.isGraphQL) return "graphql";
  switch (request.type) {
    case "XHR":
    case "Fetch":
      return "fetch-xhr";
    case "Script":
      return "js";
    case "Stylesheet":
      return "css";
    case "Image":
    case "Media":
      return "img";
    case "Font":
      return "font";
    case "Document":
      return "doc";
    case "WebSocket":
      return "ws";
    default:
      return "other";
  }
}

export type StatusBucket = "2xx" | "3xx" | "4xx" | "5xx" | "pending";

export const STATUS_BUCKET_LABELS: Record<StatusBucket, string> = {
  "2xx": "Success (2xx)",
  "3xx": "Redirect (3xx)",
  "4xx": "Client error (4xx)",
  "5xx": "Server error (5xx)",
  pending: "Pending",
};

export const STATUS_BUCKET_ORDER: StatusBucket[] = ["2xx", "3xx", "4xx", "5xx", "pending"];

export function statusBucketOf(status?: number): StatusBucket {
  if (status === undefined) return "pending";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500) return "5xx";
  return "pending";
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export interface FilterState {
  types: TypeBucket[]; // empty = "All"
  methods: string[];
  statuses: StatusBucket[];
  gqlOpTypes: GraphQLOperation["operationType"][];
  origins: string[];
}

export const EMPTY_FILTER_STATE: FilterState = {
  types: [],
  methods: [],
  statuses: [],
  gqlOpTypes: [],
  origins: [],
};

export function isFilterActive(f: FilterState): boolean {
  return (
    f.types.length > 0 ||
    f.methods.length > 0 ||
    f.statuses.length > 0 ||
    f.gqlOpTypes.length > 0 ||
    f.origins.length > 0
  );
}

/** AND across categories, OR within a category. */
export function matchesFilters(request: CapturedRequest, f: FilterState): boolean {
  if (f.types.length > 0 && !f.types.includes(bucketOf(request))) return false;
  if (f.methods.length > 0 && !f.methods.includes(request.method)) return false;
  if (f.statuses.length > 0 && !f.statuses.includes(statusBucketOf(request.status))) return false;
  if (f.origins.length > 0 && !f.origins.includes(originOf(request.url))) return false;
  if (f.gqlOpTypes.length > 0) {
    const ops = request.graphql?.operations;
    if (!ops || !ops.some((op) => f.gqlOpTypes.includes(op.operationType))) return false;
  }
  return true;
}

// ---- Search (Part B) ----

export type SearchField = "url" | "method" | "status" | "opName" | "opType" | "query" | "variables";

export const SEARCH_FIELD_LABELS: Record<SearchField, string> = {
  url: "URL",
  method: "method",
  status: "status",
  opName: "operation name",
  opType: "operation type",
  query: "query",
  variables: "variables",
};

// Fields not obviously visible in the collapsed row — when a match lands
// here (and nowhere visible), the row shows a "matched: …" hint so the user
// isn't confused about why it's in the results.
const HIDDEN_FIELDS = new Set<SearchField>(["query", "variables", "opType"]);

export function hasHiddenMatch(fields: SearchField[]): boolean {
  return fields.some((f) => HIDDEN_FIELDS.has(f));
}

/** The subset of matched fields not visible in the collapsed row — for the "matched: …" hint. */
export function hiddenMatchFields(fields: SearchField[]): SearchField[] {
  return fields.filter((f) => HIDDEN_FIELDS.has(f));
}

export interface SearchMatch {
  matched: boolean;
  fields: SearchField[];
}

interface SearchTerm {
  text: string;
  negate: boolean;
}

function parseSearchTerms(raw: string): SearchTerm[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) =>
      t.startsWith("-") && t.length > 1 ? { text: t.slice(1), negate: true } : { text: t, negate: false },
    );
}

interface FieldText {
  field: SearchField;
  text: string;
}

function collectFieldTexts(request: CapturedRequest): FieldText[] {
  const out: FieldText[] = [
    { field: "url", text: request.url },
    { field: "method", text: request.method },
  ];
  if (request.status !== undefined) out.push({ field: "status", text: String(request.status) });
  // Batched requests: every operation contributes — a match on ANY operation
  // in the batch is a match for the request (verification #12).
  for (const op of request.graphql?.operations ?? []) {
    if (op.operationName) out.push({ field: "opName", text: op.operationName });
    out.push({ field: "opType", text: op.operationType });
    if (op.query) out.push({ field: "query", text: op.query });
    if (op.variables !== undefined) {
      try {
        out.push({ field: "variables", text: JSON.stringify(op.variables) });
      } catch {
        // unstringifiable variables — nothing to search
      }
    }
  }
  return out;
}

/**
 * Plain substring search across URL/method/status/GraphQL op name+type+query
 * text+variables, case-insensitive. Space-separated terms are ANDed; a
 * leading "-" on a term excludes rows containing it. Not a query language —
 * deliberately simple per the spec.
 */
export function searchRequest(request: CapturedRequest, rawQuery: string): SearchMatch {
  const terms = parseSearchTerms(rawQuery);
  if (terms.length === 0) return { matched: true, fields: [] };
  const fieldTexts = collectFieldTexts(request).map((ft) => ({
    ...ft,
    lower: ft.text.toLowerCase(),
  }));
  const matchedFields = new Set<SearchField>();
  for (const term of terms) {
    const needle = term.text.toLowerCase();
    if (!needle) continue;
    const hitFields = fieldTexts.filter((ft) => ft.lower.includes(needle));
    if (term.negate) {
      if (hitFields.length > 0) return { matched: false, fields: [] };
    } else {
      if (hitFields.length === 0) return { matched: false, fields: [] };
      hitFields.forEach((ft) => matchedFields.add(ft.field));
    }
  }
  return { matched: true, fields: [...matchedFields] };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split `text` into alternating non-match/match segments for the positive
 * (non-negated) search terms — for rendering `<mark>` highlights. Odd
 * indices are always matches (single capturing group in the split regex).
 */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const terms = [
    ...new Set(
      parseSearchTerms(query)
        .filter((t) => !t.negate && t.text.trim())
        .map((t) => t.text),
    ),
  ];
  if (terms.length === 0) return [{ text, match: false }];
  const pattern = terms.map(escapeRegExp).join("|");
  const re = new RegExp(`(${pattern})`, "gi");
  return text
    .split(re)
    .map((part, i) => ({ text: part, match: i % 2 === 1 }))
    .filter((p) => p.text !== "");
}

// ---- Session persistence (Part A: "per session, not per origin") ----

const SESSION_KEY = "networkFilterSession";

export interface FilterSession {
  filters: FilterState;
  search: string;
}

export const EMPTY_FILTER_SESSION: FilterSession = { filters: EMPTY_FILTER_STATE, search: "" };

export async function loadFilterSession(): Promise<FilterSession> {
  try {
    const stored = await chrome.storage.session.get(SESSION_KEY);
    const val = stored[SESSION_KEY] as Partial<FilterSession> | undefined;
    if (!val) return EMPTY_FILTER_SESSION;
    return {
      filters: { ...EMPTY_FILTER_STATE, ...val.filters },
      search: val.search ?? "",
    };
  } catch {
    return EMPTY_FILTER_SESSION;
  }
}

export function saveFilterSession(session: FilterSession) {
  void chrome.storage.session.set({ [SESSION_KEY]: session }).catch(() => {});
}

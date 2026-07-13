import type { CapturedRequest, GraphQLMeta, GraphQLOperation } from "../shared/messages";

// M6: GraphQL-aware request identification.
// This module detects GraphQL requests, retrieves their bodies when needed, and
// extracts per-operation metadata using a lightweight regex parser. We avoid
// depending on the `graphql` package here: regex covers the overwhelming majority
// of real-world queries. If edge cases (complex string escapes in operation names,
// etc.) prove problematic, swapping in `graphql.parse()` is a drop-in upgrade.

const MAX_INLINE_QUERY_LEN = 50_000;

// URL/method based cheap checks first.
export function isGraphQLCandidate(method: string, url: string, headers?: Record<string, string>): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  if (pathname.toLowerCase().includes("graphql")) return true;

  // Some GraphQL gateways expose a single /query path.
  if (pathname.toLowerCase() === "/query" && method === "POST") return true;

  // Plain POST with JSON body is the common protocol; we still need body parsing
  // to confirm, but we mark it as a candidate if content-type hints JSON.
  if (method === "POST") {
    const ct = headers?.["content-type"] ?? headers?.["Content-Type"] ?? "";
    if (/application\/json|application\/graphql/.test(ct)) return true;
  }

  return false;
}

export interface GetRequestBodyResult {
  body: string;
  fetched: boolean;
}

export async function getGraphQLBody(
  tabId: number,
  requestId: string,
  postData?: string,
  hasPostData?: boolean,
): Promise<GetRequestBodyResult | null> {
  if (postData !== undefined && postData !== "") {
    return { body: postData, fetched: false };
  }
  if (!hasPostData) return null;

  try {
    const res = (await chrome.debugger.sendCommand(
      { tabId },
      "Network.getRequestPostData",
      { requestId },
    )) as { postData?: string };
    if (typeof res?.postData === "string" && res.postData.length > 0) {
      return { body: res.postData, fetched: true };
    }
  } catch {
    // Body not retrievable; detection/parse will degrade to "body unavailable".
  }
  return null;
}

interface PersistedQueryExtensions {
  persistedQuery?: { sha256Hash?: string; version?: number };
}

interface GraphQLPayload {
  operationName?: string;
  query?: string;
  variables?: unknown;
  extensions?: PersistedQueryExtensions;
}

function operationTypeFromQuery(query?: string): GraphQLOperation["operationType"] {
  if (!query || typeof query !== "string") return "query";
  // Strip leading whitespace and comments for keyword detection.
  const trimmed = query.replace(/^[\s\uFEFF\xA0]+/, "").replace(/#[^\n]*/g, "");
  if (/^\s*mutation\b/i.test(trimmed)) return "mutation";
  if (/^\s*subscription\b/i.test(trimmed)) return "subscription";
  // A bare `{ ... }` is a shorthand anonymous query per GraphQL spec.
  return "query";
}

// Match `query [Name]` or `mutation [Name]` with whitespace.
const NAMED_OPERATION_RE = /\b(query|mutation|subscription)\s+([A-Za-z0-9_]+)\s*[({]/i;

// Match the first top-level selection field (not inside arguments or fragments).
const FIRST_SELECTION_RE = /\{\s*([A-Za-z0-9_]+)/;

function extractNameFromQuery(query?: string): { name: string | null; anonymous: boolean } {
  if (!query || typeof query !== "string") return { name: null, anonymous: true };

  const named = NAMED_OPERATION_RE.exec(query);
  if (named) return { name: named[2], anonymous: false };

  // Bare shorthand `{ user { ... } }` -> first top-level field.
  const field = FIRST_SELECTION_RE.exec(query);
  if (field) return { name: field[1], anonymous: true };

  return { name: null, anonymous: true };
}

function extractOperation(payload: GraphQLPayload): GraphQLOperation {
  let query = payload.query;
  const variables = payload.variables;
  const persistedHash = payload.extensions?.persistedQuery?.sha256Hash;
  const isPersisted = typeof persistedHash === "string" && persistedHash.length > 0;

  // Persisted query without inline text.
  if (!query && isPersisted) {
    return {
      operationName: payload.operationName ?? `persisted:${persistedHash.slice(0, 8)}`,
      operationType: "query",
      isAnonymous: false,
      isPersisted: true,
      variables,
    };
  }

  const opType = operationTypeFromQuery(query);
  const { name, anonymous } = extractNameFromQuery(query);
  const explicitName = payload.operationName;

  return {
    operationName: explicitName ?? (anonymous && name ? `${name}` : name),
    operationType: opType,
    isAnonymous: anonymous && !explicitName,
    isPersisted,
    query: query && query.length > MAX_INLINE_QUERY_LEN ? query.slice(0, MAX_INLINE_QUERY_LEN) + "\n…(truncated)" : query,
    variables,
  };
}

export function parseGraphQLBody(body: string): GraphQLMeta | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    // Not JSON. Could be GraphQL SDL sent as raw text (legacy); still flag it.
    if (body.length > 0 && /\{|query|mutation|subscription/.test(body)) {
      return {
        isGraphQL: true,
        operations: [{
          operationName: null,
          operationType: "query",
          isAnonymous: true,
          isPersisted: false,
          query: body.slice(0, MAX_INLINE_QUERY_LEN) + (body.length > MAX_INLINE_QUERY_LEN ? "\n…(truncated)" : ""),
        }],
        isBatch: false,
      };
    }
    return null;
  }

  if (Array.isArray(json)) {
    const payloads = json.filter((item): item is GraphQLPayload =>
      typeof item === "object" && item !== null && ("query" in item || "extensions" in item),
    );
    if (payloads.length === 0) return null;
    const operations = payloads.map(extractOperation);
    return {
      isGraphQL: true,
      operations,
      isBatch: operations.length > 1,
    };
  }

  if (typeof json === "object" && json !== null && ("query" in (json as GraphQLPayload) || "extensions" in (json as GraphQLPayload))) {
    const operation = extractOperation(json as GraphQLPayload);
    return {
      isGraphQL: true,
      operations: [operation],
      isBatch: false,
    };
  }

  return null;
}

export function nullGraphQLMeta(): GraphQLMeta {
  return {
    isGraphQL: true,
    operations: [{
      operationName: "GraphQL (body unavailable)",
      operationType: "query",
      isAnonymous: false,
      isPersisted: false,
    }],
    isBatch: false,
  };
}

export function deriveGraphQLDisplay(meta: GraphQLMeta): string {
  const ops = meta.operations;
  if (ops.length === 0) return "GraphQL";
  const first = ops[0];
  let label = first.operationName ?? (first.query && extractNameFromQuery(first.query).name) ?? "GraphQL";
  if (first.isAnonymous && !first.isPersisted) label = `${label} (anonymous)`;
  if (ops.length > 1) {
    label = `${label} +${ops.length - 1} more`;
  }
  return label;
}

export function formatGraphQLForAI(request: CapturedRequest): string | null {
  if (!request.graphql) return null;
  const meta = request.graphql;
  const lines: string[] = [];
  lines.push(`[GraphQL ${meta.isBatch ? "batch" : "operation"}]`);
  for (const op of meta.operations) {
    const anonFlag = op.isAnonymous ? " (anonymous)" : "";
    const persistedFlag = op.isPersisted ? " [persisted]" : "";
    lines.push(`- ${op.operationType.toUpperCase()} ${op.operationName ?? "<unnamed>"}${anonFlag}${persistedFlag}`);
    if (op.query) lines.push(`  Query:\n${op.query.split("\n").map((l) => "    " + l).join("\n")}`);
    if (op.variables !== undefined) {
      lines.push(`  Variables: ${JSON.stringify(op.variables, null, 2)}`);
    }
  }
  return lines.join("\n");
}

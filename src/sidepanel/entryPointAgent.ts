import type {
  CapturedRequest,
  FrameworkResolution,
  PausedSnapshot,
  RemoteProperty,
  ScriptInfo,
} from "../shared/messages";
import { getProvider, type ChatMessage } from "./providers";
import type { ModelProfile } from "./modelConfig";
import {
  getOriginalSources,
  getOriginalSourceContent,
  resolveOriginalLocation,
} from "./sourceMapResolver";
import { classifyFrame, compileIgnorePatterns } from "./codeClassifier";
import { originLabelOf, prettySourcePath } from "./framePath";

// "Find entry point" (agentic). The paused stack is often 100% framework code
// because the request was scheduled across async boundaries after the
// developer's code returned — the stack is gone, but the HEAP is not:
// framework closures still hold the developer's objects (component instances,
// services, request configs). This bounded tool loop lets the active M3 model
// walk scopes → recognize a user class by constructor name → find it in the
// original sources (sourcesContent) → confirm the method that issues the
// paused request. Runs ONLY on explicit user click from a live pause.
//
// HARD CONSTRAINTS: every tool is fixed, extension-implemented, and READ-ONLY.
// There is no Runtime.evaluate-style tool — the model can never execute code
// in the page — and no tool resumes, steps, or mutates anything.

const MAX_TOOL_CALLS = 12;
const MAX_TURNS = 16; // tool turns + finish + a little slack for JSON retries
const TOOL_RESULT_CAP = 7000; // chars of tool output per turn
const MAX_SEARCH_MATCHES = 30;
const MAX_FILES_SCANNED = 300;
const MAX_SOURCE_LINES = 160;
const MAX_PROPS = 50;

export interface EvidenceLink {
  scriptId: string;
  source: string; // exact map `sources` entry
  line: number; // 1-based
}

export interface AgentStep {
  id: number;
  label: string; // friendly action phrasing, derived from tool + args
  state: "running" | "done" | "failed";
  finding?: string; // what the step FOUND, not just what it did
  link?: EvidenceLink;
}

export interface EntryCandidate {
  label: string; // e.g. "ngOnInit" / "loadTickets"
  file: string; // exact map source string (usable for reverse mapping)
  prettyFile: string;
  line: number; // 1-based original
  scriptId?: string;
  evidence: string;
}

export interface AgentResult {
  outcome: "found" | "partial" | "cancelled" | "error";
  summary: string;
  entryPoint?: EntryCandidate;
  candidates: EntryCandidate[];
  evidence: { text: string; link?: EvidenceLink }[];
  steps: AgentStep[];
  toolCalls: number;
  error?: string;
  fromCache?: boolean;
}

export interface AgentDeps {
  profile: ModelProfile;
  paused: PausedSnapshot;
  scripts: ScriptInfo[];
  requests: CapturedRequest[];
  framework: FrameworkResolution | null;
  ignorePatterns: string[];
  fetchProperties: (objectId: string) => Promise<RemoteProperty[]>;
}

// ---- Result cache: one confirmed investigation per (origin + trigger) ----

const resultCache = new Map<string, AgentResult>();

export function agentCacheKey(deps: Pick<AgentDeps, "paused" | "scripts">): string {
  const origin =
    deps.scripts.map((s) => originLabelOf(s.url)).find((o) => o !== null) ?? "";
  return `${origin}|${deps.paused.reason}|${deps.paused.detail ?? ""}`;
}

export function getCachedAgentResult(key: string): AgentResult | undefined {
  return resultCache.get(key);
}

export function clearAgentCache() {
  resultCache.clear();
}

// ---- System prompt & JSON protocol (provider-agnostic: works over any
// plain chat completion; no native tool-calling API required) ----

const SYSTEM_PROMPT = `You are a debugging agent inside a browser DevTools extension. A web app is PAUSED at a breakpoint. The visible call stack may contain NO user code at all — frameworks (zone.js, RxJS, Apollo, React scheduler) schedule requests across async boundaries after the developer's code returned. Your job: identify the FIRST function in the developer's OWN code that originated this request (e.g. a lifecycle hook or a service method), by inspecting live heap objects and the original source files.

Key technique: framework closures on the paused frames still reference the developer's objects. Scope variables and object previews include CONSTRUCTOR NAMES (e.g. "TicketsListComponent") — a user-class constructor name is often the decisive clue. Find such an instance, locate its class in the original sources, and verify which of its methods issues the paused request.

TOOLS (all read-only; you cannot execute code, resume, or step):
- get_stack {} — paused stack, source-map resolved, each frame classified "user" or "framework".
- get_scope {"frameIndex": number} — scope variables of one frame (names, types, previews with constructor names, objectIds).
- inspect_object {"objectId": string} — expand an object's properties one level (previews include constructor names).
- search_sources {"query": string} — full-text search across the developer's ORIGINAL sources (ignore-listed paths excluded). Returns file, line, snippet.
- get_source {"file": string, "lineFrom": number, "lineTo": number} — read a range of an original file. "file" must be an EXACT file string previously returned by a tool.
- get_request {} — the request that triggered this pause (URL, method, GraphQL operation/query/variables if applicable).
- get_framework {} — detected framework and ignore-list patterns.

RESPONSE CONTRACT — reply with EXACTLY ONE JSON object and nothing else (no markdown fences, no prose):
- To call a tool: {"tool": "<name>", "args": { ... }}
- To finish: {"finish": {"outcome": "found" | "partial", "summary": "<one sentence>", "entryPoint": {"label": "<functionOrHook>", "file": "<exact file>", "line": <number>} | null, "candidates": [{"label": "...", "file": "<exact file>", "line": <number>, "evidence": "<one line>"}], "evidence": [{"text": "<checkable claim>", "file": "<exact file, optional>", "line": <number, optional>}]}}

RULES:
- Ground EVERY claim in tool results. Never guess or invent a file/line you have not seen in a tool result this conversation.
- "file" values must be exact strings from tool results (map source paths), not prettified.
- Each evidence item must be independently checkable (state what was observed and where).
- If you cannot close the chain, finish with outcome "partial" and your strongest candidates — do not keep calling tools without a plan.
- You have a budget of ${MAX_TOOL_CALLS} tool calls. Be economical: start with get_stack and get_request.`;

// ---- JSON extraction (models occasionally add fences/prose) ----

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const candidates = [cleaned];
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(cleaned.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function truncate(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}\n…(truncated)`;
}

// ---- Tool implementations (fixed, read-only, extension-implemented) ----

interface ToolOutcome {
  result: unknown; // JSON-serialized back to the model
  finding: string; // human line for the live log
  link?: EvidenceLink;
}

/** Per-run helper state (source lists cached for the run; consumers are M2's). */
class ToolBox {
  private sourcesByScript = new Map<string, string[] | null>();
  private compiled;

  constructor(private deps: AgentDeps) {
    this.compiled = compileIgnorePatterns(deps.ignorePatterns);
  }

  private isUserPath(path: string): boolean {
    return classifyFrame({ functionName: "", url: path }, null, this.compiled) === "user";
  }

  private async sourcesOf(scriptId: string): Promise<string[] | null> {
    if (!this.sourcesByScript.has(scriptId)) {
      this.sourcesByScript.set(scriptId, await getOriginalSources(scriptId));
    }
    return this.sourcesByScript.get(scriptId) ?? null;
  }

  async findScriptForSource(file: string): Promise<string | null> {
    for (const s of this.deps.scripts) {
      if (!s.sourceMapURL) continue;
      const sources = await this.sourcesOf(s.scriptId);
      if (sources?.includes(file)) return s.scriptId;
    }
    return null;
  }

  async get_stack(): Promise<ToolOutcome> {
    const frames = await Promise.all(
      this.deps.paused.callFrames.map(async (f, index) => {
        if (f.functionName.startsWith("[async:")) {
          return { index, asyncBoundary: f.functionName };
        }
        const loc = await resolveOriginalLocation(f.scriptId, f.lineNumber, f.columnNumber);
        const cls = classifyFrame(f, loc?.source ?? null, this.compiled);
        return {
          index,
          functionName: loc?.name || f.functionName || "(anonymous)",
          classification: cls,
          file: loc ? loc.source : undefined,
          line: loc ? loc.line : undefined,
          rawUrl: !loc ? f.url || `(scriptId ${f.scriptId})` : undefined,
          rawLine: !loc ? f.lineNumber : undefined,
          hasScopes: f.scopeChain.length > 0,
        };
      }),
    );
    const userCount = frames.filter(
      (f) => "classification" in f && f.classification === "user",
    ).length;
    return {
      result: { reason: this.deps.paused.reason, detail: this.deps.paused.detail, frames },
      finding:
        userCount > 0
          ? `${frames.length} frames — ${userCount} in your code`
          : `${frames.length} frames — no user code (all framework)`,
    };
  }

  async get_scope(args: Record<string, unknown>): Promise<ToolOutcome> {
    const frameIndex = Number(args.frameIndex);
    const frame = this.deps.paused.callFrames[frameIndex];
    if (!frame) throw new Error(`No frame at index ${frameIndex}`);
    if (frame.scopeChain.length === 0) {
      throw new Error(
        `Frame ${frameIndex} has no inspectable scopes (async parent or separator frame) — pick a frame where hasScopes is true`,
      );
    }
    const scopes = [];
    let varCount = 0;
    for (const scope of frame.scopeChain) {
      if (scope.type === "global" || !scope.objectId) continue;
      const props = await this.deps.fetchProperties(scope.objectId);
      varCount += props.length;
      scopes.push({
        type: scope.type,
        variables: props.slice(0, MAX_PROPS).map((p) => ({
          name: p.name,
          type: p.type,
          preview: p.description?.slice(0, 120),
          objectId: p.objectId,
        })),
        ...(props.length > MAX_PROPS ? { omitted: props.length - MAX_PROPS } : {}),
      });
    }
    return {
      result: { frameIndex, scopes },
      finding: `${varCount} variables across ${scopes.length} scope(s) in frame ${frameIndex}`,
    };
  }

  async inspect_object(args: Record<string, unknown>): Promise<ToolOutcome> {
    const objectId = String(args.objectId ?? "");
    if (!objectId) throw new Error("objectId is required");
    const props = await this.deps.fetchProperties(objectId);
    // Constructor-name-shaped previews are the decisive clue — surface them.
    const instanceNames = [
      ...new Set(
        props
          .map((p) => p.description ?? "")
          .filter((d) => /^[A-Z][A-Za-z0-9_$]{2,60}$/.test(d)),
      ),
    ].slice(0, 6);
    return {
      result: {
        properties: props.slice(0, MAX_PROPS).map((p) => ({
          name: p.name,
          type: p.type,
          preview: p.description?.slice(0, 160),
          objectId: p.objectId,
        })),
        ...(props.length > MAX_PROPS ? { omitted: props.length - MAX_PROPS } : {}),
      },
      finding:
        instanceNames.length > 0
          ? `${props.length} properties — instances seen: ${instanceNames.join(", ")}`
          : `${props.length} properties`,
    };
  }

  async search_sources(args: Record<string, unknown>): Promise<ToolOutcome> {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query is required");
    const needle = query.toLowerCase();
    const matches: { file: string; scriptId: string; line: number; snippet: string }[] = [];
    let filesScanned = 0;
    for (const script of this.deps.scripts) {
      if (!script.sourceMapURL || matches.length >= MAX_SEARCH_MATCHES) continue;
      const sources = await this.sourcesOf(script.scriptId);
      if (!sources) continue;
      for (const source of sources) {
        if (matches.length >= MAX_SEARCH_MATCHES || filesScanned >= MAX_FILES_SCANNED) break;
        if (!this.isUserPath(source)) continue; // ignore-listed / vendor paths excluded
        const content = await getOriginalSourceContent(script.scriptId, source);
        if (!content) continue;
        filesScanned++;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            matches.push({
              file: source,
              scriptId: script.scriptId,
              line: i + 1,
              snippet: lines[i].trim().slice(0, 160),
            });
          }
        }
      }
    }
    const files = [...new Set(matches.map((m) => m.file))];
    return {
      result: {
        query,
        matches: matches.map(({ file, line, snippet }) => ({ file, line, snippet })),
        filesScanned,
      },
      finding:
        matches.length > 0
          ? `${matches.length} match(es) in ${files.length} file(s), e.g. ${prettySourcePath(files[0])}`
          : `no matches in your sources (${filesScanned} files scanned)`,
      link:
        matches.length > 0
          ? { scriptId: matches[0].scriptId, source: matches[0].file, line: matches[0].line }
          : undefined,
    };
  }

  async get_source(args: Record<string, unknown>): Promise<ToolOutcome> {
    const file = String(args.file ?? "");
    let lineFrom = Math.max(1, Number(args.lineFrom) || 1);
    let lineTo = Number(args.lineTo) || lineFrom + 40;
    if (lineTo - lineFrom > MAX_SOURCE_LINES) lineTo = lineFrom + MAX_SOURCE_LINES;
    const scriptId = await this.findScriptForSource(file);
    if (!scriptId) {
      throw new Error(
        `"${file}" is not an exact source path from a previous tool result — use search_sources or get_stack output verbatim`,
      );
    }
    const content = await getOriginalSourceContent(scriptId, file);
    if (!content) throw new Error(`No embedded sourcesContent for "${file}"`);
    const lines = content.split("\n");
    lineFrom = Math.min(lineFrom, lines.length);
    lineTo = Math.min(lineTo, lines.length);
    const numbered = lines
      .slice(lineFrom - 1, lineTo)
      .map((l, i) => `${lineFrom + i}: ${l}`)
      .join("\n");
    return {
      result: { file, lineFrom, lineTo, content: numbered },
      finding: `read ${prettySourcePath(file)} lines ${lineFrom}–${lineTo}`,
      link: { scriptId, source: file, line: lineFrom },
    };
  }

  async get_request(): Promise<ToolOutcome> {
    const { reason, detail } = this.deps.paused;
    const requests = this.deps.requests;
    let match: CapturedRequest | undefined;
    if (reason === "GraphQLOperation" && detail) {
      const names = detail.split(",").map((s) => s.trim());
      match = [...requests]
        .reverse()
        .find((r) =>
          r.graphql?.operations.some((op) => names.includes(op.operationName ?? "")),
        );
    } else if (reason === "XHR" && detail) {
      match = [...requests].reverse().find((r) => r.url.includes(detail));
    }
    match ??= requests[requests.length - 1];
    if (!match) {
      return {
        result: { pauseReason: reason, pauseDetail: detail, note: "no captured request matched" },
        finding: "no captured request matched this pause",
      };
    }
    const gql = match.graphql?.operations.map((op) => ({
      operationName: op.operationName,
      operationType: op.operationType,
      query: op.query?.slice(0, 1200),
      variables: JSON.stringify(op.variables ?? null)?.slice(0, 600),
    }));
    const finding = gql?.length
      ? `GraphQL ${gql[0].operationType} ${gql[0].operationName ?? "(anonymous)"}`
      : `${match.method} ${match.url.slice(0, 120)}`;
    return {
      result: {
        pauseReason: reason,
        pauseDetail: detail,
        url: match.url,
        method: match.method,
        status: match.status,
        graphql: gql,
      },
      finding,
    };
  }

  async get_framework(): Promise<ToolOutcome> {
    return {
      result: {
        framework: this.deps.framework?.framework ?? "unknown",
        confidence: this.deps.framework?.confidence,
        ignorePatterns: this.deps.ignorePatterns,
      },
      finding: `framework: ${this.deps.framework?.framework ?? "unknown"}`,
    };
  }
}

// ---- Friendly progress phrasing (generic — derived from tool + args) ----

function describeToolCall(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "get_stack":
      return "Checking the call stack…";
    case "get_scope":
      return `Inspecting frame ${Number(args.frameIndex)} scopes for developer objects…`;
    case "inspect_object":
      return "Expanding an object found in the paused scopes…";
    case "search_sources":
      return `Searching your sources for "${String(args.query ?? "").slice(0, 60)}"…`;
    case "get_source":
      return `Reading ${prettySourcePath(String(args.file ?? ""))}…`;
    case "get_request":
      return "Identifying the request that triggered this pause…";
    case "get_framework":
      return "Checking the detected framework and ignore rules…";
    default:
      return `Running ${tool}…`;
  }
}

// ---- Finish-payload parsing ----

interface FinishPayload {
  outcome?: string;
  summary?: string;
  entryPoint?: { label?: string; file?: string; line?: number } | null;
  candidates?: { label?: string; file?: string; line?: number; evidence?: string }[];
  evidence?: (string | { text?: string; file?: string; line?: number })[];
}

async function buildCandidate(
  box: ToolBox,
  raw: { label?: string; file?: string; line?: number; evidence?: string },
): Promise<EntryCandidate | null> {
  if (!raw.file || !raw.line || !Number.isFinite(raw.line)) return null;
  const scriptId = await box.findScriptForSource(raw.file);
  // A file the tools never returned is a hallucination — drop it.
  if (!scriptId) return null;
  return {
    label: raw.label || "(function)",
    file: raw.file,
    prettyFile: prettySourcePath(raw.file),
    line: raw.line,
    scriptId,
    evidence: raw.evidence ?? "",
  };
}

// ---- The loop ----

async function complete(
  profile: ModelProfile,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<string> {
  const provider = getProvider(profile.transport);
  let text = "";
  await provider.streamChat(profile, messages, (delta) => (text += delta), signal);
  return text;
}

export async function runEntryPointAgent(
  deps: AgentDeps,
  onSteps: (steps: AgentStep[]) => void,
  signal: AbortSignal,
): Promise<AgentResult> {
  const box = new ToolBox(deps);
  const steps: AgentStep[] = [];
  let stepId = 0;
  const pushSteps = () => onSteps(steps.slice());

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Execution is paused (reason: ${deps.paused.reason}` +
        `${deps.paused.detail ? `, detail: ${deps.paused.detail}` : ""}). ` +
        `Framework: ${deps.framework?.framework ?? "unknown"}. ` +
        `Find the entry point in the developer's own code that originated this request.`,
    },
  ];

  let toolCalls = 0;
  let parseFailures = 0;
  let budgetWarned = false;

  const finalize = (
    outcome: AgentResult["outcome"],
    summary: string,
    extras: Partial<AgentResult> = {},
  ): AgentResult => ({
    outcome,
    summary,
    candidates: [],
    evidence: [],
    steps,
    toolCalls,
    ...extras,
  });

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (signal.aborted) return finalize("cancelled", "Cancelled — the pause is preserved.");
      let text: string;
      try {
        text = await complete(deps.profile, messages, signal);
      } catch (e) {
        if (signal.aborted) return finalize("cancelled", "Cancelled — the pause is preserved.");
        throw e;
      }
      const parsed = extractJson(text);
      if (!parsed) {
        if (++parseFailures >= 3) {
          return finalize("error", "The model kept replying outside the JSON contract.", {
            error: `Unparseable reply: ${text.slice(0, 200)}`,
          });
        }
        messages.push(
          { role: "assistant", content: text },
          {
            role: "user",
            content:
              "Your reply was not a single valid JSON object. Reply again following the response contract exactly.",
          },
        );
        continue;
      }
      parseFailures = 0;

      // ---- finish ----
      if (parsed.finish && typeof parsed.finish === "object") {
        const fin = parsed.finish as FinishPayload;
        const entryPoint = fin.entryPoint
          ? await buildCandidate(box, fin.entryPoint)
          : null;
        const candidates = (
          await Promise.all((fin.candidates ?? []).map((c) => buildCandidate(box, c)))
        ).filter((c): c is EntryCandidate => c !== null);
        const evidence = await Promise.all(
          (fin.evidence ?? []).map(async (ev) => {
            const item = typeof ev === "string" ? { text: ev } : ev;
            let link: EvidenceLink | undefined;
            if (item.file && item.line && Number.isFinite(item.line)) {
              const scriptId = await box.findScriptForSource(item.file);
              if (scriptId) link = { scriptId, source: item.file, line: item.line };
            }
            return { text: item.text ?? "", link };
          }),
        );
        const found = fin.outcome === "found" && entryPoint !== null;
        return finalize(
          found ? "found" : "partial",
          fin.summary ??
            (found ? "Entry point identified." : "Could not fully close the chain."),
          {
            entryPoint: entryPoint ?? undefined,
            candidates,
            evidence: evidence.filter((e) => e.text),
          },
        );
      }

      // ---- tool call ----
      const toolName = typeof parsed.tool === "string" ? parsed.tool : null;
      if (!toolName) {
        messages.push(
          { role: "assistant", content: text },
          {
            role: "user",
            content: 'Reply with either {"tool": ...} or {"finish": ...} — nothing else.',
          },
        );
        continue;
      }
      if (toolCalls >= MAX_TOOL_CALLS) {
        if (budgetWarned) {
          return finalize(
            "partial",
            "Tool budget exhausted before the chain was closed.",
          );
        }
        budgetWarned = true;
        messages.push(
          { role: "assistant", content: text },
          {
            role: "user",
            content:
              "Tool budget exhausted. You MUST now reply with a finish object summarizing your best findings so far (outcome \"partial\" if unconfirmed).",
          },
        );
        continue;
      }

      const args = (parsed.args ?? {}) as Record<string, unknown>;
      const step: AgentStep = {
        id: ++stepId,
        label: describeToolCall(toolName, args),
        state: "running",
      };
      steps.push(step);
      pushSteps();
      toolCalls++;

      // Explicit allowlist — the model can only reach these seven read-only
      // tools, never other methods or anything evaluate-shaped.
      const TOOLS: Record<string, (a: Record<string, unknown>) => Promise<ToolOutcome>> = {
        get_stack: () => box.get_stack(),
        get_scope: (a) => box.get_scope(a),
        inspect_object: (a) => box.inspect_object(a),
        search_sources: (a) => box.search_sources(a),
        get_source: (a) => box.get_source(a),
        get_request: () => box.get_request(),
        get_framework: () => box.get_framework(),
      };
      const impl = TOOLS[toolName];
      let resultText: string;
      if (!impl) {
        step.state = "failed";
        step.finding = `unknown tool "${toolName}"`;
        resultText = `ERROR: unknown tool "${toolName}". Available: get_stack, get_scope, inspect_object, search_sources, get_source, get_request, get_framework.`;
      } else {
        try {
          const outcome = await impl(args);
          step.state = "done";
          step.finding = outcome.finding;
          step.link = outcome.link;
          resultText = truncate(JSON.stringify(outcome.result), TOOL_RESULT_CAP);
        } catch (e) {
          step.state = "failed";
          step.finding = e instanceof Error ? e.message : String(e);
          resultText = `ERROR: ${step.finding}`;
        }
      }
      pushSteps();
      if (signal.aborted) return finalize("cancelled", "Cancelled — the pause is preserved.");
      messages.push(
        { role: "assistant", content: text },
        {
          role: "user",
          content: `TOOL RESULT ${toolName} (${toolCalls}/${MAX_TOOL_CALLS} used):\n${resultText}`,
        },
      );
    }
    return finalize("partial", "Stopped at the iteration cap before the chain was closed.");
  } catch (e) {
    if (signal.aborted) return finalize("cancelled", "Cancelled — the pause is preserved.");
    return finalize("error", "The investigation hit an error.", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Run with caching per (origin + request/operation). */
export async function runOrGetCached(
  deps: AgentDeps,
  onSteps: (steps: AgentStep[]) => void,
  signal: AbortSignal,
  force = false,
): Promise<AgentResult> {
  const key = agentCacheKey(deps);
  if (!force) {
    const cached = resultCache.get(key);
    if (cached) return { ...cached, fromCache: true };
  }
  const result = await runEntryPointAgent(deps, onSteps, signal);
  // Only conclusive investigations are worth reusing; partials/errors re-run.
  if (result.outcome === "found") resultCache.set(key, result);
  return result;
}

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type {
  BreakpointInfo,
  EventBreakpointInfo,
  ExtractedHandler,
  FrameworkId,
  FrameworkResolution,
  FunctionBreakpointInfo,
  GqlOpBreakpointInfo,
  PanelToBg,
  PausedFrame,
  PausedSnapshot,
  RemoteProperty,
  ScriptInfo,
} from "../shared/messages";
import {
  describeSourceMapStatus,
  getSourceMapStatuses,
  resolveOriginalLocation,
  subscribeSourceMapStatuses,
  type OriginalLocation,
} from "./sourceMapResolver";
import {
  classifyFrame,
  compileIgnorePatterns,
  findEntryPointIndex,
  type FrameClass,
} from "./codeClassifier";
import LifecyclePanel from "./LifecyclePanel";

export const DEFAULT_PAUSE_QUESTION =
  "Execution paused here. Explain what this code is doing and what the current variable values suggest. Point out anything that looks like the cause of a bug.";

export type DisplayHandler = ExtractedHandler & { resolvedLocation?: string };

/** Result of "Break on this element's handler": handlers found for a pick. */
export interface HandlerCandidates {
  eventType: string;
  selector: string;
  framework: string;
  candidates: DisplayHandler[];
  error?: string;
}

interface DebuggerProps {
  breakpoints: BreakpointInfo[];
  xhrBreakpoints: string[];
  eventBreakpoints: EventBreakpointInfo[];
  functionBreakpoints: FunctionBreakpointInfo[];
  gqlOpBreakpoints: GqlOpBreakpointInfo[];
  handlerCandidates: HandlerCandidates | null;
  framework: FrameworkResolution | null;
  askFramework: boolean;
  paused: PausedSnapshot | null;
  breakpointError: string | null;
  // ---- M7: lifecycle & load-time discovery ----
  scripts: ScriptInfo[];
  refreshScripts: () => void;
  getScriptSource: (scriptId: string) => Promise<string>;
  asyncDepth?: number;
  send: (msg: PanelToBg) => void;
  fetchProperties: (objectId: string) => Promise<RemoteProperty[]>;
  onOpenSource: (scriptId: string, source: string, line: number) => void;
  onExplain: (prefillText: string) => void;
  onPickForHandler: (eventType: string) => void;
  onDismissCandidates: () => void;
  onChooseFramework: (framework: FrameworkId | "auto") => void;
  onAiFallback: (eventType: string) => void;
}

const COMMON_EVENTS = ["click", "submit", "input", "keydown", "change"];

const FRAMEWORK_OPTIONS: { value: FrameworkId; label: string }[] = [
  { value: "react", label: "React" },
  { value: "angular", label: "Angular" },
  { value: "vue", label: "Vue" },
  { value: "vanilla", label: "Vanilla JS" },
];

// Sensible per-framework stepping blackbox defaults; user-editable below.
export const DEFAULT_BLACKBOX: Record<string, string[]> = {
  react: ["react-dom", "react\\.production", "scheduler", "node_modules"],
  angular: ["zone\\.js", "@angular", "node_modules"],
  vue: ["vue\\.runtime", "@vue", "node_modules"],
  vanilla: [],
  unknown: [],
};

const btnClass =
  "rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-800 hover:bg-gray-300 disabled:opacity-50";

function frameName(frame: PausedFrame, loc: OriginalLocation | null): string {
  return loc?.name || frame.functionName || "(anonymous)";
}

function frameLocationText(frame: PausedFrame, loc: OriginalLocation | null): string {
  if (loc) return `${loc.source}:${loc.line}`;
  if (frame.url) return `${frame.url}:${frame.lineNumber}:${frame.columnNumber}`;
  if (frame.scriptId) {
    return `scriptId ${frame.scriptId}:${frame.lineNumber}:${frame.columnNumber}`;
  }
  return "(unknown script)";
}

/** Plain-text frame line for AI prompts — name and location space-separated. */
function frameLabel(frame: PausedFrame, loc: OriginalLocation | null): string {
  return `${frameName(frame, loc)}  ${frameLocationText(frame, loc)}`;
}

function PropertyRow({
  prop,
  fetchProperties,
  depth,
}: {
  prop: RemoteProperty;
  fetchProperties: (objectId: string) => Promise<RemoteProperty[]>;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<RemoteProperty[] | null>(null);
  const [failed, setFailed] = useState(false);
  const expandable = !!prop.objectId;

  const toggle = async () => {
    if (!expandable) return;
    const next = !expanded;
    setExpanded(next);
    if (next && children === null && prop.objectId) {
      try {
        setChildren(await fetchProperties(prop.objectId));
      } catch {
        setFailed(true);
      }
    }
  };

  return (
    <li style={{ paddingLeft: depth * 12 }}>
      <button
        className={`flex w-full items-baseline gap-1 text-left ${
          expandable ? "cursor-pointer hover:bg-gray-100" : "cursor-default"
        }`}
        onClick={() => void toggle()}
      >
        <span className="w-3 shrink-0 text-[10px] text-gray-400">
          {expandable ? (expanded ? "▾" : "▸") : ""}
        </span>
        <span className="shrink-0 font-mono text-xs font-medium">{prop.name}</span>
        <span className="break-all font-mono text-xs text-gray-500">
          {prop.description ?? prop.type}
        </span>
      </button>
      {expanded && (
        <ul>
          {failed && (
            <li className="pl-4 text-xs text-red-600">(failed to load)</li>
          )}
          {children?.map((c, i) => (
            <PropertyRow
              key={`${c.name}-${i}`}
              prop={c}
              fetchProperties={fetchProperties}
              depth={depth + 1}
            />
          ))}
          {children?.length === 0 && !failed && (
            <li className="pl-4 text-xs text-gray-400">(no properties)</li>
          )}
        </ul>
      )}
    </li>
  );
}

function ScopeSection({
  scopeType,
  objectId,
  autoExpand,
  fetchProperties,
}: {
  scopeType: string;
  objectId?: string;
  autoExpand: boolean;
  fetchProperties: (objectId: string) => Promise<RemoteProperty[]>;
}) {
  const [expanded, setExpanded] = useState(autoExpand);
  const [props, setProps] = useState<RemoteProperty[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (expanded && props === null && objectId) {
      fetchProperties(objectId)
        .then(setProps)
        .catch(() => setFailed(true));
    }
  }, [expanded, props, objectId, fetchProperties]);

  return (
    <div className="mt-1">
      <button
        className="text-xs font-semibold text-gray-700 hover:underline"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? "▾" : "▸"} {scopeType}
      </button>
      {expanded && (
        <ul className="mt-0.5">
          {failed && <li className="pl-4 text-xs text-red-600">(failed to load)</li>}
          {props === null && !failed && (
            <li className="pl-4 text-xs italic text-gray-400">loading…</li>
          )}
          {props?.map((p, i) => (
            <PropertyRow
              key={`${p.name}-${i}`}
              prop={p}
              fetchProperties={fetchProperties}
              depth={1}
            />
          ))}
          {props?.length === 0 && (
            <li className="pl-4 text-xs text-gray-400">(empty)</li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function Debugger({
  breakpoints,
  xhrBreakpoints,
  eventBreakpoints,
  functionBreakpoints,
  gqlOpBreakpoints,
  handlerCandidates,
  framework,
  askFramework,
  paused,
  breakpointError,
  scripts,
  refreshScripts,
  getScriptSource,
  asyncDepth,
  send,
  fetchProperties,
  onOpenSource,
  onExplain,
  onPickForHandler,
  onDismissCandidates,
  onChooseFramework,
  onAiFallback,
}: DebuggerProps) {
  const [selectedFrame, setSelectedFrame] = useState(0);
  const [frameLocations, setFrameLocations] = useState<(OriginalLocation | null)[]>([]);
  const [xhrInput, setXhrInput] = useState("");
  const [rawUrl, setRawUrl] = useState("");
  const [rawLine, setRawLine] = useState("");
  const [eventName, setEventName] = useState("click");
  const [eventOneShot, setEventOneShot] = useState(true);
  const [handlerEventType, setHandlerEventType] = useState("click");
  const [blackboxText, setBlackboxText] = useState("");
  const [explaining, setExplaining] = useState(false);

  // Track defaults for the resolved framework; the user can edit before Apply.
  useEffect(() => {
    setBlackboxText((DEFAULT_BLACKBOX[framework?.framework ?? "unknown"] ?? []).join("\n"));
  }, [framework?.framework]);

  // Per-script source-map statuses — hover reasons for unmapped frames (Fix 4).
  const mapStatuses = useSyncExternalStore(
    subscribeSourceMapStatuses,
    getSourceMapStatuses,
  );

  // Re-resolve the stack (via the M2 consumer cache) whenever a pause lands.
  // Keyed by scriptId, so eval'd/webpack:// frames resolve too.
  useEffect(() => {
    setSelectedFrame(0);
    if (!paused) {
      setFrameLocations([]);
      return;
    }
    let cancelled = false;
    void Promise.all(
      paused.callFrames.map((f) =>
        resolveOriginalLocation(f.scriptId, f.lineNumber, f.columnNumber),
      ),
    ).then((locations) => {
      if (!cancelled) setFrameLocations(locations);
    });
    return () => {
      cancelled = true;
    };
  }, [paused]);

  // ---- M7: shared discovery pipeline (classifier → entry point → arm) ----
  // The classifier runs on EVERY pause's stack; only the trigger differs
  // (interaction breakpoints step in early, request breakpoints — XHR/GraphQL
  // — already have the whole chain on the stack, async parents included).
  const ignoreList = useMemo(
    () => blackboxText.split(/[\n,]/).map((p) => p.trim()).filter(Boolean),
    [blackboxText],
  );
  const compiledIgnore = useMemo(() => compileIgnorePatterns(ignoreList), [ignoreList]);
  // Classification uses resolved original paths when available; hold off on
  // entry-point/guidance verdicts until the whole stack resolved.
  const chainResolved =
    paused !== null && frameLocations.length === paused.callFrames.length;
  const frameClasses: FrameClass[] = useMemo(
    () =>
      paused
        ? paused.callFrames.map((f, i) =>
            classifyFrame(f, frameLocations[i]?.source ?? null, compiledIgnore),
          )
        : [],
    [paused, frameLocations, compiledIgnore],
  );
  // Entry point = OUTERMOST user-code frame (walk from the deepest async
  // parent inward): the function in the developer's code that started the
  // chain — for init-time requests, typically the lifecycle hook.
  const entryIdx = chainResolved ? findEntryPointIndex(frameClasses) : -1;
  const isRequestPause =
    paused?.reason === "XHR" || paused?.reason === "GraphQLOperation";
  const chainBroken = chainResolved && isRequestPause && entryIdx === -1;

  // Part 5: narrow AI assist — offered ONLY when the classifier found no user
  // frame; presented as a heuristic suggestion, answered by the active model.
  const askAiForEntryPoint = () => {
    if (!paused) return;
    const stackLines = paused.callFrames.map(
      (f, i) => `  ${frameLabel(f, frameLocations[i] ?? null)}`,
    );
    onExplain(
      `[Heuristic — AI suggestion, please verify] Execution paused on a request ` +
        `(${paused.reason}${paused.detail ? `: ${paused.detail}` : ""}), but no frame in the ` +
        `stack classifies as my own code (framework: ${framework?.framework ?? "unknown"}). ` +
        `From the call chain below (innermost first; "[async: …]" rows are async boundaries), ` +
        `which frame is most likely MY application's entry point — the function in my code ` +
        `that started this chain — rather than framework internals? Name the function and ` +
        `file:line so I can set a breakpoint there (⏸ button in the Debug tab).\n\n` +
        `Call chain:\n${stackLines.join("\n")}`,
    );
  };

  const addXhrBreakpoint = () => {
    const url = xhrInput.trim();
    if (
      url === "" &&
      !confirm("Empty pattern pauses on EVERY request. Set it anyway?")
    ) {
      return;
    }
    send({ type: "set-xhr-breakpoint", url });
    setXhrInput("");
  };

  const addRawBreakpoint = () => {
    const line = Number(rawLine);
    if (!rawUrl.trim() || !Number.isInteger(line) || line < 0) return;
    send({ type: "set-breakpoint", url: rawUrl.trim(), lineNumber: line });
    setRawUrl("");
    setRawLine("");
  };

  const explainPause = async () => {
    if (!paused || explaining) return;
    setExplaining(true);
    try {
      const lines: string[] = ["[Paused state]"];
      if (paused.reason === "XHR") {
        lines.push(
          `Paused by XHR/fetch breakpoint${paused.detail ? ` matching "${paused.detail}"` : ""}.`,
        );
      } else if (paused.reason === "GraphQLOperation") {
        lines.push(
          `Paused by a GraphQL operation breakpoint${
            paused.detail ? ` (operation: ${paused.detail})` : ""
          } — execution stopped in the app code that issued the GraphQL request (the instrumentation wrapper frames are trimmed from the stack).`,
        );
      } else if (paused.reason === "EventListener") {
        lines.push(
          `Paused by an event-listener breakpoint${
            paused.detail ? ` (${paused.detail})` : ""
          } — execution stopped at the top of the event handler.`,
        );
      } else {
        const hitLabels = paused.hitBreakpoints
          .map((id) => {
            const bp = breakpoints.find((b) => b.breakpointId === id);
            if (bp) return bp.originalLabel ?? `${bp.url}:${bp.lineNumber}`;
            return functionBreakpoints.find((f) => f.id === id)?.label;
          })
          .filter((label): label is string => !!label);
        lines.push(
          `Paused (reason: ${paused.reason})${
            hitLabels.length > 0 ? ` at breakpoint ${hitLabels.join(", ")}` : ""
          }.`,
        );
      }
      lines.push("", "Call stack (innermost first):");
      paused.callFrames.forEach((f, i) => {
        lines.push(`  ${frameLabel(f, frameLocations[i] ?? null)}`);
      });
      if (entryIdx >= 0) {
        lines.push(
          "",
          `Entry point in my own code (outermost non-framework frame): ${frameLabel(
            paused.callFrames[entryIdx],
            frameLocations[entryIdx] ?? null,
          )}`,
        );
      }

      const frame = paused.callFrames[selectedFrame];
      const localScope =
        frame?.scopeChain.find((s) => s.type === "local") ?? frame?.scopeChain[0];
      if (localScope?.objectId) {
        try {
          const props = await fetchProperties(localScope.objectId);
          lines.push("", `Variables in the selected frame (${localScope.type} scope):`);
          for (const p of props.slice(0, 30)) {
            lines.push(`  ${p.name} = ${p.description ?? p.type}`);
          }
          if (props.length > 30) lines.push(`  … ${props.length - 30} more`);
        } catch {
          lines.push("", "(variables unavailable)");
        }
      }
      onExplain(`${DEFAULT_PAUSE_QUESTION}\n\n${lines.join("\n")}`);
    } finally {
      setExplaining(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
      {paused && (
        <section className="rounded border border-amber-300 bg-amber-50 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-amber-800">
              ⏸ Paused ({paused.reason}
              {paused.detail ? `: ${paused.detail}` : ""})
            </span>
            <button className={btnClass} onClick={() => send({ type: "resume" })}>
              Resume
            </button>
            <button className={btnClass} onClick={() => send({ type: "step-over" })}>
              Step over
            </button>
            <button className={btnClass} onClick={() => send({ type: "step-into" })}>
              Step into
            </button>
            <button className={btnClass} onClick={() => send({ type: "step-out" })}>
              Step out
            </button>
            <button
              className="rounded bg-violet-600 px-2 py-1 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
              onClick={() => void explainPause()}
              disabled={explaining}
            >
              {explaining ? "Preparing…" : "Explain this pause"}
            </button>
          </div>

          <h3 className="mt-2 text-xs font-semibold text-gray-700">
            Call chain{" "}
            <span className="font-normal text-gray-500">
              (framework dimmed{entryIdx >= 0 ? ", ▶ = entry point in your code" : ""})
            </span>
          </h3>
          <ul className="mt-0.5">
            {paused.callFrames.map((f, i) => {
              const loc = frameLocations[i] ?? null;
              const cls = frameClasses[i];
              // Async boundary rows are dividers, not selectable frames.
              if (cls === "separator") {
                return (
                  <li
                    key={i}
                    className="border-t border-dashed border-gray-300 py-0.5 pl-1 font-mono text-[11px] italic text-gray-400"
                  >
                    {f.functionName}
                  </li>
                );
              }
              const isEntry = chainResolved && i === entryIdx;
              // Fix 7: badges, function name, and location are separate,
              // explicitly-spaced spans — never concatenated text (the old
              // rendering glued them into "your codeNn" / "entryen").
              const unmappedReason =
                !loc && f.scriptId
                  ? mapStatuses[f.scriptId]?.state === "resolved"
                    ? "map resolved, but this exact position has no original mapping"
                    : describeSourceMapStatus(mapStatuses[f.scriptId])
                  : null;
              return (
                <li
                  key={i}
                  className={`flex items-center gap-1 ${isEntry ? "rounded bg-emerald-50" : ""}`}
                >
                  <button
                    className={`min-w-0 flex-1 px-1 py-0.5 text-left font-mono text-xs ${
                      i === selectedFrame ? "bg-blue-100" : "hover:bg-gray-100"
                    } ${cls === "framework" ? "text-gray-400" : ""}`}
                    title={
                      cls === "framework"
                        ? "framework / ignored code"
                        : "your code — click to inspect, ⏸ to break here instead"
                    }
                    onClick={() => setSelectedFrame(i)}
                  >
                    <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                      {isEntry && (
                        <span className="shrink-0 rounded bg-emerald-600 px-1 py-px text-[10px] font-semibold text-white">
                          ▶ entry
                        </span>
                      )}
                      {chainResolved && cls === "user" && !isEntry && (
                        <span className="shrink-0 rounded bg-emerald-100 px-1 py-px text-[10px] font-semibold text-emerald-700">
                          your code
                        </span>
                      )}
                      <span className="font-medium">{frameName(f, loc)}</span>
                      <span className="break-all text-gray-500">
                        {frameLocationText(f, loc)}
                      </span>
                      {unmappedReason && (
                        <span
                          className="shrink-0 cursor-help rounded bg-amber-100 px-1 py-px text-[10px] font-semibold text-amber-700"
                          title={unmappedReason}
                        >
                          ⚠ unmapped
                        </span>
                      )}
                    </span>
                  </button>
                  {loc && (
                    <button
                      className="shrink-0 rounded bg-gray-200 px-1 text-[10px] hover:bg-gray-300"
                      title="Open the original file at this line (Sources tab)"
                      onClick={() => onOpenSource(f.scriptId, loc.source, loc.line)}
                    >
                      ↗
                    </button>
                  )}
                  {(f.url || f.scriptId) && (
                    <button
                      className="shrink-0 rounded bg-gray-200 px-1 text-[10px] hover:bg-gray-300"
                      title="Set a permanent breakpoint at this frame — subsequent loads pause directly here"
                      onClick={() =>
                        send({
                          type: "set-breakpoint",
                          url: f.url,
                          scriptId: f.scriptId,
                          lineNumber: f.lineNumber,
                          columnNumber: f.columnNumber,
                          originalLabel: loc ? `${loc.source}:${loc.line}` : undefined,
                        })
                      }
                    >
                      ⏸
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          {chainBroken && (
            <div className="mt-2 rounded border border-amber-400 bg-amber-100/70 p-2 text-xs">
              <p className="font-medium text-amber-900">
                The async chain didn't reach your code — the request was
                scheduled across boundaries the debugger couldn't trace (zone.js
                and long RxJS pipelines are common causes). Try increasing async
                stack depth, or use "Break on lifecycle" to break at the hook
                directly.
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-gray-700">
                  Async depth:
                  <select
                    className="rounded border border-gray-300 px-1 py-0.5 text-xs"
                    value={String(asyncDepth ?? 64)}
                    onChange={(e) =>
                      send({ type: "set-async-depth", maxDepth: Number(e.target.value) })
                    }
                  >
                    {[...new Set([32, 64, 128, asyncDepth ?? 64])]
                      .sort((a, b) => a - b)
                      .map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  className={btnClass}
                  onClick={() =>
                    document
                      .getElementById("lifecycle-panel")
                      ?.scrollIntoView({ behavior: "smooth" })
                  }
                >
                  Break on lifecycle ↓
                </button>
                <button
                  className="rounded bg-violet-600 px-2 py-1 text-xs font-medium text-white hover:bg-violet-700"
                  title="Heuristic: asks your active model which frame is your entry point — confirm before trusting"
                  onClick={askAiForEntryPoint}
                >
                  Ask AI to find my entry point
                </button>
              </div>
            </div>
          )}

          <h3 className="mt-2 text-xs font-semibold text-gray-700">Scope</h3>
          {paused.callFrames[selectedFrame]?.scopeChain
            .filter((s) => s.type !== "global") // global is huge and rarely useful
            .map((s, i) => (
              <ScopeSection
                // Key by frame + scope so switching frames refetches.
                key={`${selectedFrame}-${i}`}
                scopeType={s.type}
                objectId={s.objectId}
                autoExpand={s.type === "local"}
                fetchProperties={fetchProperties}
              />
            ))}
        </section>
      )}

      <section>
        <h2 className="font-semibold">Breakpoints</h2>
        {breakpointError && (
          <p className="mt-1 text-xs text-red-600">{breakpointError}</p>
        )}
        {breakpoints.length === 0 && (
          <p className="mt-1 text-xs text-gray-500">
            None set. Use "break" on a stack frame in the request detail pane, or
            add a raw location below.
          </p>
        )}
        <ul className="mt-1 space-y-1">
          {breakpoints.map((b) => (
            <li key={b.breakpointId} className="flex items-center gap-2 text-xs">
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  b.bound
                    ? "bg-green-100 text-green-700"
                    : "bg-amber-100 text-amber-700"
                }`}
              >
                {b.bound ? "bound" : "pending"}
              </span>
              {b.tag === "lifecycle" && (
                <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                  lifecycle
                </span>
              )}
              <span className="min-w-0 flex-1 break-all font-mono">
                {b.originalLabel ?? `${b.url}:${b.lineNumber}`}
                {b.originalLabel && (
                  <span className="text-gray-400"> → {b.url}:{b.lineNumber}</span>
                )}
              </span>
              <button
                className="shrink-0 rounded bg-red-100 px-2 py-0.5 text-red-700 hover:bg-red-200"
                onClick={() => send({ type: "remove-breakpoint", breakpointId: b.breakpointId })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex gap-1">
          <input
            className="min-w-0 flex-[2] rounded border border-gray-300 px-2 py-1 text-xs"
            placeholder="Script URL (minified)"
            value={rawUrl}
            onChange={(e) => setRawUrl(e.target.value)}
          />
          <input
            className="w-16 rounded border border-gray-300 px-2 py-1 text-xs"
            placeholder="Line (0-based)"
            value={rawLine}
            onChange={(e) => setRawLine(e.target.value)}
          />
          <button className={btnClass} onClick={addRawBreakpoint}>
            Add raw
          </button>
        </div>
        {breakpoints.some((b) => b.tag === "lifecycle") && (
          <button
            className="mt-2 rounded bg-red-100 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-200"
            onClick={() =>
              breakpoints
                .filter((b) => b.tag === "lifecycle")
                .forEach((b) =>
                  send({ type: "remove-breakpoint", breakpointId: b.breakpointId }),
                )
            }
          >
            Clear lifecycle breakpoints
          </button>
        )}
        <div className="mt-2 flex items-center gap-2 text-xs text-gray-600">
          <span>Async stack depth:</span>
          <select
            className="rounded border border-gray-300 px-1 py-0.5 text-xs"
            title="How far Debugger.paused stacks reach back across async boundaries — deeper chains reconstruct lifecycle→request paths but cost page performance"
            value={String(asyncDepth ?? 64)}
            onChange={(e) =>
              send({ type: "set-async-depth", maxDepth: Number(e.target.value) })
            }
          >
            {[...new Set([32, 64, 128, asyncDepth ?? 64])]
              .sort((a, b) => a - b)
              .map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
          </select>
          <span className="text-[11px] text-gray-400">
            deeper chains, slower page
          </span>
        </div>
      </section>

      <section>
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">Break on interaction</h2>
          <select
            className="rounded border border-gray-300 px-1 py-0.5 text-xs"
            title="Framework used for handler extraction (auto-detected per site; override any time)"
            value={framework?.source === "override" ? framework.framework : "auto"}
            onChange={(e) => onChooseFramework(e.target.value as FrameworkId | "auto")}
          >
            <option value="auto">
              Auto-detect
              {framework && framework.source === "detected"
                ? `: ${framework.framework}${framework.confidence === "low" ? "?" : ""}`
                : ""}
            </option>
            {FRAMEWORK_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        {askFramework && (
          <div className="mt-1 rounded border border-amber-300 bg-amber-50 p-2">
            <p className="text-xs font-medium text-amber-800">
              Couldn't confidently detect this site's framework — which does it
              use? (Remembered for this site.)
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {FRAMEWORK_OPTIONS.map((f) => (
                <button
                  key={f.value}
                  className="rounded bg-amber-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-amber-700"
                  onClick={() => onChooseFramework(f.value)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button
            className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
            onClick={() => send({ type: "set-event-breakpoint", eventName: "click", oneShot: true })}
          >
            Break on next click
          </button>
          <select
            className="rounded border border-gray-300 px-1 py-0.5 text-xs"
            value={eventName}
            onChange={(e) => setEventName(e.target.value)}
          >
            {COMMON_EVENTS.map((ev) => (
              <option key={ev} value={ev}>
                {ev}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={eventOneShot}
              onChange={(e) => setEventOneShot(e.target.checked)}
            />
            one-shot
          </label>
          <button
            className={btnClass}
            onClick={() =>
              send({ type: "set-event-breakpoint", eventName, oneShot: eventOneShot })
            }
          >
            Add event breakpoint
          </button>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          Broad mode pauses on the FIRST matching event <em>anywhere</em> on the
          page — possibly a different element than you meant. For one specific
          button use "Break on this element's handler" below. (On React apps the
          broad mode is often the reliable one, because React delegates events.)
        </p>
        {eventBreakpoints.length > 0 && (
          <ul className="mt-1 space-y-1">
            {eventBreakpoints.map((eb) => (
              <li key={eb.eventName} className="flex items-center gap-2 text-xs">
                <span className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">
                  event
                </span>
                <span className="min-w-0 flex-1 font-mono">
                  {eb.eventName}
                  {eb.oneShot && <span className="text-gray-400"> (one-shot)</span>}
                </span>
                <button
                  className="shrink-0 rounded bg-red-100 px-2 py-0.5 text-red-700 hover:bg-red-200"
                  onClick={() =>
                    send({ type: "remove-event-breakpoint", eventName: eb.eventName })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            className="rounded border border-gray-300 px-1 py-0.5 text-xs"
            value={handlerEventType}
            onChange={(e) => setHandlerEventType(e.target.value)}
          >
            {COMMON_EVENTS.map((ev) => (
              <option key={ev} value={ev}>
                {ev}
              </option>
            ))}
          </select>
          <button
            className={btnClass}
            title="Pick an element on the page, then break on its attached handler"
            onClick={() => onPickForHandler(handlerEventType)}
          >
            🎯 Break on this element's handler…
          </button>
        </div>
        {functionBreakpoints.length > 0 && (
          <ul className="mt-1 space-y-1">
            {functionBreakpoints.map((fb) => (
              <li key={fb.id} className="flex items-center gap-2 text-xs">
                <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">
                  handler
                </span>
                <span className="min-w-0 flex-1 break-all font-mono">{fb.label}</span>
                <button
                  className="shrink-0 rounded bg-red-100 px-2 py-0.5 text-red-700 hover:bg-red-200"
                  onClick={() => send({ type: "remove-function-breakpoint", id: fb.id })}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {handlerCandidates && (
          <div className="mt-2 rounded border border-blue-200 bg-blue-50 p-2">
            <p className="text-xs font-medium">
              {handlerCandidates.eventType} handler on{" "}
              <span className="break-all font-mono">{handlerCandidates.selector}</span>{" "}
              <span className="text-gray-500">
                (via {handlerCandidates.framework} adapter)
              </span>
            </p>
            {handlerCandidates.error && (
              <p className="mt-1 text-xs text-red-600">{handlerCandidates.error}</p>
            )}
            {!handlerCandidates.error && handlerCandidates.candidates.length === 0 && (
              <div className="mt-1 text-xs text-gray-600">
                <p>
                  Couldn't extract a handler function — typical for production
                  builds where framework debug hooks are stripped. Fallback
                  (heuristic): pause on the next {handlerCandidates.eventType}{" "}
                  anywhere, then ask your AI model to identify your handler frame
                  in the paused stack.
                </p>
                <button
                  className="mt-1 rounded bg-blue-600 px-2 py-1 font-medium text-white hover:bg-blue-700"
                  onClick={() => {
                    onAiFallback(handlerCandidates.eventType);
                    onDismissCandidates();
                  }}
                >
                  Arm AI fallback (break on next {handlerCandidates.eventType})
                </button>
              </div>
            )}
            {handlerCandidates.candidates.length > 0 && (
              <ul className="mt-1 space-y-1">
                {handlerCandidates.candidates.map((c, i) => (
                  <li key={i} className="rounded border border-gray-200 bg-white p-1.5">
                    <p className="break-all font-mono text-[11px] text-gray-500">
                      {c.via}
                    </p>
                    {c.resolvedLocation ? (
                      <p className="break-all font-mono text-[11px]">
                        <span className="rounded bg-emerald-100 px-1 text-[10px] font-semibold text-emerald-700">
                          mapped
                        </span>{" "}
                        {c.resolvedLocation}
                      </p>
                    ) : (
                      c.url && (
                        <p className="break-all font-mono text-[11px] text-gray-500">
                          {c.url}:{c.lineNumber}:{c.columnNumber}
                        </p>
                      )
                    )}
                    <p className="max-h-16 overflow-hidden break-all font-mono text-[11px] text-gray-400">
                      {c.description}
                    </p>
                    <button
                      className="mt-1 rounded bg-violet-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-violet-700"
                      title="Pause whenever this exact function runs"
                      onClick={() => {
                        send({
                          type: "set-function-breakpoint",
                          handlerObjectId: c.handlerObjectId,
                          label: `${handlerCandidates.eventType} → ${
                            c.resolvedLocation ?? c.description.slice(0, 60)
                          }`,
                        });
                        onDismissCandidates();
                      }}
                    >
                      Arm breakpoint on this handler
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              className="mt-1 rounded bg-gray-200 px-2 py-0.5 text-xs hover:bg-gray-300"
              onClick={onDismissCandidates}
            >
              Dismiss
            </button>
          </div>
        )}

        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-gray-500">
            Stepping blackbox patterns (skip framework internals)
          </summary>
          <textarea
            className="mt-1 h-16 w-full rounded border border-gray-300 p-1 font-mono text-[11px]"
            placeholder="One regex per line, e.g. react-dom"
            value={blackboxText}
            onChange={(e) => setBlackboxText(e.target.value)}
          />
          <button
            className={btnClass}
            onClick={() =>
              send({
                type: "set-blackbox-patterns",
                patterns: blackboxText
                  .split(/[\n,]/)
                  .map((p) => p.trim())
                  .filter(Boolean),
              })
            }
          >
            Apply blackbox
          </button>
        </details>
      </section>

      <LifecyclePanel
        scripts={scripts}
        refreshScripts={refreshScripts}
        getScriptSource={getScriptSource}
        framework={framework}
        ignorePatterns={ignoreList}
        send={send}
      />

      <section>
        <h2 className="font-semibold">XHR / fetch / GraphQL breakpoints</h2>
        {gqlOpBreakpoints.length > 0 && (
          <>
            <ul className="mt-1 space-y-1">
              {gqlOpBreakpoints.map((g) => (
                <li key={g.target} className="flex items-center gap-2 text-xs">
                  <span className="shrink-0 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                    GraphQL op
                  </span>
                  <span className="min-w-0 flex-1 break-all font-mono">{g.label}</span>
                  <button
                    className="shrink-0 rounded bg-red-100 px-2 py-0.5 text-red-700 hover:bg-red-200"
                    onClick={() =>
                      send({ type: "remove-gql-op-breakpoint", target: g.target })
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-gray-500">
              If an armed operation doesn't pause, reload the page — some GraphQL
              clients capture <code>fetch</code> before the hook was installed;
              after a reload the hook is guaranteed to be in place first.
            </p>
          </>
        )}
        {xhrBreakpoints.length === 0 && gqlOpBreakpoints.length === 0 && (
          <p className="mt-1 text-xs text-gray-500">
            None set. Use "Break when this URL fires" on a request (or "Break
            when operation … fires" on a GraphQL request), or add a URL
            substring below.
          </p>
        )}
        <ul className="mt-1 space-y-1">
          {xhrBreakpoints.map((url) => (
            <li key={url} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 break-all font-mono">
                {url === "" ? "(all requests)" : url}
              </span>
              <button
                className="shrink-0 rounded bg-red-100 px-2 py-0.5 text-red-700 hover:bg-red-200"
                onClick={() => send({ type: "remove-xhr-breakpoint", url })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex gap-1">
          <input
            className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-xs"
            placeholder="URL substring (empty = all requests)"
            value={xhrInput}
            onChange={(e) => setXhrInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addXhrBreakpoint()}
          />
          <button className={btnClass} onClick={addXhrBreakpoint}>
            Add
          </button>
        </div>
      </section>
    </div>
  );
}

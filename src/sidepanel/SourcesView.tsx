import { useEffect, useRef, useState, type RefObject } from "react";
import { js as beautifyJs } from "js-beautify";
import type { ScriptInfo } from "../shared/messages";
import {
  fetchOriginalSourceOverNetwork,
  getOriginalSources,
  getOriginalSourceContent,
  type SourceMapStatus,
} from "./sourceMapResolver";
import SourceMapDiagnostics from "./SourceMapDiagnostics";

const ATTACH_CAP = 8000; // chars — keep source context token-sane
// Above this, skip the per-line gutter rendering (original sources are
// normally a few hundred lines; this only guards pathological files).
const MAX_GUTTER_LINES = 20_000;

/** A "jump to source" request (clicked frame → file at line). */
export type SourcesNavTarget =
  | {
      kind: "original";
      scriptId: string;
      source: string; // exact map `sources` entry
      line: number; // 1-based original line
      nonce: number;
    }
  | {
      kind: "generated"; // unresolved frame → pretty-printed minified script
      scriptId: string;
      lineNumber: number; // 0-based generated (CDP convention)
      columnNumber: number;
      nonce: number;
    };

// ---- Generated-position → beautified-line mapping. js-beautify only moves
// whitespace, so the count of non-whitespace characters before a position is
// invariant: count them in the raw text up to (line, col), then find the
// beautified line holding the same count. ----

function rawOffsetOf(text: string, line0: number, col0: number): number {
  let offset = 0;
  for (let l = 0; l < line0; l++) {
    const next = text.indexOf("\n", offset);
    if (next === -1) break;
    offset = next + 1;
  }
  return Math.min(offset + col0, text.length);
}

function mapToBeautifiedLine(
  raw: string,
  beautified: string,
  line0: number,
  col0: number,
): number {
  const limit = rawOffsetOf(raw, line0, col0);
  let target = 0;
  for (let i = 0; i < limit; i++) {
    const c = raw.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) target++;
  }
  let count = 0;
  let line = 1;
  for (let i = 0; i < beautified.length; i++) {
    const c = beautified.charCodeAt(i);
    if (c === 10) line++;
    else if (c !== 32 && c !== 9 && c !== 13) {
      count++;
      if (count > target) return line;
    }
  }
  return line;
}

interface SourcesViewProps {
  scripts: ScriptInfo[];
  statuses: Record<string, SourceMapStatus>;
  navigate: SourcesNavTarget | null;
  refreshScripts: () => void;
  getScriptSource: (scriptId: string) => Promise<string>;
  onAttach: (label: string, code: string) => void;
  // Reverse-maps (original -> generated) and arms the breakpoint; resolves to
  // an error message, or null on success.
  onBreakOnOriginalLine: (
    script: ScriptInfo,
    source: string,
    line: number,
  ) => Promise<string | null>;
}

function looksMinified(source: string): boolean {
  const lines = source.split("\n");
  return source.length / lines.length > 300;
}

export default function SourcesView({
  scripts,
  statuses,
  navigate,
  refreshScripts,
  getScriptSource,
  onAttach,
  onBreakOnOriginalLine,
}: SourcesViewProps) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<ScriptInfo | null>(null);
  const [originalSources, setOriginalSources] = useState<string[]>([]);
  const [viewingOriginal, setViewingOriginal] = useState<string | "">("");
  const [content, setContent] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [highlightLine, setHighlightLine] = useState<number | null>(null);
  const highlightRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    refreshScripts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openScript = async (
    script: ScriptInfo,
    genLoc?: { lineNumber: number; columnNumber: number },
  ) => {
    setSelected(script);
    setViewingOriginal("");
    setOriginalSources([]);
    setContent(null);
    setNote(null);
    setHighlightLine(null);
    setLoading(true);
    try {
      const [source, origList] = await Promise.all([
        getScriptSource(script.scriptId),
        // Resolution is keyed by scriptId — works for eval'd/webpack:// scripts.
        getOriginalSources(script.scriptId),
      ]);
      setOriginalSources(origList ?? []);
      if (source.length > 2_000_000) {
        setContent(source.slice(0, 2_000_000));
        setNote("Very large script — shown raw and truncated.");
        if (genLoc) setHighlightLine(genLoc.lineNumber + 1);
      } else if (looksMinified(source)) {
        const pretty = beautifyJs(source, { indent_size: 2 });
        setContent(pretty);
        setNote(
          "Minified — pretty-printed for reading. Line numbers here do NOT match the shipped bundle (breakpoints still use real generated lines).",
        );
        // Beautification only moves whitespace, so the frame's generated
        // position maps into the pretty text by non-whitespace offset.
        if (genLoc) {
          setHighlightLine(
            mapToBeautifiedLine(source, pretty, genLoc.lineNumber, genLoc.columnNumber),
          );
        }
      } else {
        setContent(source);
        if (genLoc) setHighlightLine(genLoc.lineNumber + 1);
      }
      return origList ?? [];
    } catch (e) {
      setContent(null);
      setNote(`Failed to load: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    } finally {
      setLoading(false);
    }
  };

  const openOriginal = async (
    script: ScriptInfo,
    source: string,
    highlight: number | null = null,
  ) => {
    setViewingOriginal(source);
    setContent(null);
    setNote(null);
    setHighlightLine(highlight);
    setLoading(true);
    // Preferred: sourcesContent embedded in the map (webpack embeds the real
    // TS/JS — zero network, zero auth). Fallback: page-context fetch.
    const embedded = await getOriginalSourceContent(script.scriptId, source);
    if (embedded !== null) {
      setContent(embedded);
      setNote(
        "Original source (embedded sourcesContent — no network fetch). Click a line number to set a breakpoint on that original line.",
      );
    } else {
      const fetched = await fetchOriginalSourceOverNetwork(script.scriptId, source);
      if (fetched !== null) {
        setContent(fetched);
        setNote(
          "Original source (fetched in the page's network context — the map has no sourcesContent). Click a line number to set a breakpoint.",
        );
      } else {
        setNote(
          "This map has no embedded sourcesContent for that file, and its source path isn't a fetchable URL — the original text is unavailable. Switch back to the generated source.",
        );
      }
    }
    setLoading(false);
  };

  // External navigation — a clicked frame lands here: resolved frames at the
  // original file + line, unresolved frames in the pretty-printed generated
  // script at the mapped position (both highlighted).
  useEffect(() => {
    if (!navigate) return;
    const script = scripts.find((s) => s.scriptId === navigate.scriptId);
    if (!script) {
      setNote("That frame's script is no longer loaded (page navigated?).");
      return;
    }
    void (async () => {
      if (navigate.kind === "generated") {
        await openScript(script, {
          lineNumber: navigate.lineNumber,
          columnNumber: navigate.columnNumber,
        });
        return;
      }
      if (selected?.scriptId !== script.scriptId) await openScript(script);
      await openOriginal(script, navigate.source, navigate.line);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate?.nonce]);

  // Scroll the highlighted line into view once the content rendered.
  useEffect(() => {
    if (highlightLine !== null && content !== null) {
      highlightRef.current?.scrollIntoView({ block: "center" });
    }
  }, [highlightLine, content]);

  const breakOnLine = async (line: number) => {
    if (!selected || !viewingOriginal) return;
    const error = await onBreakOnOriginalLine(selected, viewingOriginal, line);
    setNote(
      error ??
        `Breakpoint set at ${viewingOriginal}:${line} (reverse-mapped into the bundle — see the Debug tab).`,
    );
  };

  const attach = () => {
    if (!selected || content === null) return;
    const selection = window.getSelection()?.toString() ?? "";
    const snippet = selection.trim() ? selection : content;
    const truncated = snippet.length > ATTACH_CAP;
    const code = truncated ? `${snippet.slice(0, ATTACH_CAP)}\n… (truncated)` : snippet;
    const file = viewingOriginal || selected.url || "(anonymous script)";
    const label = `${file}${selection.trim() ? " (snippet)" : truncated ? " (truncated)" : ""}`;
    onAttach(label, code);
  };

  const visible = scripts.filter((s) =>
    (s.url || "(anonymous)").toLowerCase().includes(filter.toLowerCase()),
  );

  const allLines = content !== null ? content.split("\n") : null;
  const gutterLines = allLines && allLines.length <= MAX_GUTTER_LINES ? allLines : null;
  // Breakpoints arm only from ORIGINAL lines (reverse mapping needs the exact
  // map source); pretty-printed generated line numbers don't match the bundle.
  const canBreakOnLines = !!viewingOriginal;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SourceMapDiagnostics scripts={scripts} statuses={statuses} />
      <div className="flex gap-2 border-b border-gray-200 p-2">
        <input
          className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-xs"
          placeholder="Filter scripts by URL…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="shrink-0 rounded bg-gray-200 px-2 py-1 text-xs hover:bg-gray-300"
          onClick={refreshScripts}
        >
          Refresh
        </button>
      </div>

      <ul className="max-h-40 shrink-0 divide-y divide-gray-100 overflow-y-auto border-b border-gray-200">
        {visible.length === 0 && (
          <li className="p-2 text-xs text-gray-500">
            No scripts{filter ? " match the filter" : " parsed yet — attach and load a page"}.
          </li>
        )}
        {visible.map((s) => {
          const status = statuses[s.scriptId];
          return (
            <li key={s.scriptId}>
              <button
                className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-gray-50 ${
                  selected?.scriptId === s.scriptId ? "bg-blue-50" : ""
                }`}
                onClick={() => void openScript(s)}
              >
                <span
                  className="min-w-0 flex-1 truncate font-mono"
                  title={s.url || "(anonymous eval'd script)"}
                >
                  {s.url || "(anonymous eval'd script)"}
                </span>
                {s.sourceMapURL && (
                  <span
                    className={`shrink-0 rounded px-1 py-px text-[10px] font-semibold ${
                      status?.state === "fetch-failed" || status?.state === "parse-failed"
                        ? "bg-red-100 text-red-700"
                        : "bg-emerald-100 text-emerald-700"
                    }`}
                  >
                    map
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {selected && (
        <div className="flex items-center gap-2 border-b border-gray-200 p-2">
          {originalSources.length > 0 && (
            <select
              className="min-w-0 flex-1 rounded border border-gray-300 px-1 py-0.5 text-xs"
              value={viewingOriginal}
              onChange={(e) => {
                if (e.target.value === "") void openScript(selected);
                else void openOriginal(selected, e.target.value);
              }}
            >
              <option value="">
                (generated) {selected.url || "(anonymous eval'd script)"}
              </option>
              {originalSources.map((src) => (
                <option key={src} value={src}>
                  {src}
                </option>
              ))}
            </select>
          )}
          <button
            className="shrink-0 rounded bg-violet-600 px-2 py-1 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            disabled={content === null}
            title="Attaches the selected text, or the whole file (capped) if nothing is selected"
            onClick={attach}
          >
            Attach selection / file
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto bg-gray-50">
        {note && <p className="px-2 pt-1 text-[11px] italic text-amber-700">{note}</p>}
        {loading && <p className="p-2 text-xs text-gray-500">Loading…</p>}
        {!loading && content !== null && gutterLines !== null && (
          <div className="select-text py-1 font-mono text-[11px] leading-4">
            {gutterLines.map((line, i) => {
              const lineNo = i + 1;
              const isTarget = lineNo === highlightLine;
              return (
                <div
                  key={i}
                  ref={isTarget ? (highlightRef as RefObject<HTMLDivElement | null>) : undefined}
                  className={`flex ${isTarget ? "bg-amber-200/70" : ""}`}
                >
                  <button
                    className={`w-12 shrink-0 select-none border-r border-gray-200 pr-2 text-right ${
                      canBreakOnLines
                        ? "text-gray-400 hover:bg-blue-100 hover:text-blue-700"
                        : "cursor-help text-gray-300"
                    }`}
                    title={
                      canBreakOnLines
                        ? "Set a breakpoint on this original line (reverse-mapped into the shipped bundle)"
                        : "Line numbers in the pretty-printed generated view don't match the shipped bundle — set breakpoints from original sources or stack frames"
                    }
                    disabled={!canBreakOnLines}
                    onClick={() => void breakOnLine(lineNo)}
                  >
                    {lineNo}
                  </button>
                  <pre className="m-0 min-w-0 flex-1 whitespace-pre pl-2">
                    {line || " "}
                  </pre>
                </div>
              );
            })}
          </div>
        )}
        {!loading && allLines !== null && gutterLines === null && (
          // Too many lines for per-row rendering: plain <pre>, with the target
          // line wrapped in a highlighted span so navigation still lands.
          <pre className="select-text whitespace-pre p-2 font-mono text-[11px] leading-4">
            {highlightLine !== null && highlightLine <= allLines.length ? (
              <>
                {allLines.slice(0, highlightLine - 1).join("\n")}
                {highlightLine > 1 ? "\n" : ""}
                <span
                  ref={highlightRef as RefObject<HTMLSpanElement | null>}
                  className="bg-amber-200/70"
                >
                  {allLines[highlightLine - 1] || " "}
                </span>
                {highlightLine < allLines.length ? "\n" : ""}
                {allLines.slice(highlightLine).join("\n")}
              </>
            ) : (
              content
            )}
          </pre>
        )}
        {!loading && content === null && !selected && (
          <p className="p-3 text-gray-500">Select a script to view its source.</p>
        )}
      </div>
    </div>
  );
}

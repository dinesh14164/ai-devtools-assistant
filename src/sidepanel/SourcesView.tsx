import { useEffect, useRef, useState } from "react";
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

/** A "jump to original source" request (clicked frame → file at line). */
export interface SourcesNavTarget {
  scriptId: string;
  source: string; // exact map `sources` entry
  line: number; // 1-based original line
  nonce: number;
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
  const highlightRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    refreshScripts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openScript = async (script: ScriptInfo) => {
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
      } else if (looksMinified(source)) {
        setContent(beautifyJs(source, { indent_size: 2 }));
        setNote(
          "Minified — pretty-printed for reading. Line numbers here do NOT match the shipped bundle (breakpoints still use real generated lines).",
        );
      } else {
        setContent(source);
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

  // Fix 6: external navigation — a clicked resolved frame lands here at the
  // original file + line, with the line highlighted.
  useEffect(() => {
    if (!navigate) return;
    const script = scripts.find((s) => s.scriptId === navigate.scriptId);
    if (!script) {
      setNote("That frame's script is no longer loaded (page navigated?).");
      return;
    }
    void (async () => {
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

  const gutterLines =
    viewingOriginal && content !== null && content.split("\n").length <= MAX_GUTTER_LINES
      ? content.split("\n")
      : null;

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
                  ref={isTarget ? highlightRef : undefined}
                  className={`flex ${isTarget ? "bg-amber-200/70" : ""}`}
                >
                  <button
                    className="w-12 shrink-0 select-none border-r border-gray-200 pr-2 text-right text-gray-400 hover:bg-blue-100 hover:text-blue-700"
                    title="Set a breakpoint on this original line (reverse-mapped into the shipped bundle)"
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
        {!loading && content !== null && gutterLines === null && (
          <pre className="select-text whitespace-pre p-2 font-mono text-[11px] leading-4">
            {content}
          </pre>
        )}
        {!loading && content === null && !selected && (
          <p className="p-3 text-gray-500">Select a script to view its source.</p>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { js as beautifyJs } from "js-beautify";
import type { ScriptInfo } from "../shared/messages";
import { getOriginalSources, getOriginalSourceContent } from "./sourceMapResolver";

const ATTACH_CAP = 8000; // chars — keep source context token-sane

interface SourcesViewProps {
  scripts: ScriptInfo[];
  refreshScripts: () => void;
  getScriptSource: (scriptId: string) => Promise<string>;
  onAttach: (label: string, code: string) => void;
}

function looksMinified(source: string): boolean {
  const lines = source.split("\n");
  return source.length / lines.length > 300;
}

export default function SourcesView({
  scripts,
  refreshScripts,
  getScriptSource,
  onAttach,
}: SourcesViewProps) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<ScriptInfo | null>(null);
  const [originalSources, setOriginalSources] = useState<string[]>([]);
  const [viewingOriginal, setViewingOriginal] = useState<string | "">("");
  const [content, setContent] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const preRef = useRef<HTMLPreElement | null>(null);

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
    setLoading(true);
    try {
      const [source, origList] = await Promise.all([
        getScriptSource(script.scriptId),
        script.hasSourceMap ? getOriginalSources(script.url) : Promise.resolve(null),
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
    } catch (e) {
      setContent(null);
      setNote(`Failed to load: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const openOriginal = async (source: string) => {
    if (!selected) return;
    setViewingOriginal(source);
    setContent(null);
    setNote(null);
    setLoading(true);
    const original = await getOriginalSourceContent(selected.url, source);
    if (original !== null) {
      setContent(original);
      setNote("Original source (embedded in the source map).");
    } else {
      setNote(
        "This map doesn't embed sourcesContent for that file — showing nothing. Switch back to the generated source.",
      );
    }
    setLoading(false);
  };

  const attach = () => {
    if (!selected || content === null) return;
    const selection = window.getSelection()?.toString() ?? "";
    const snippet = selection.trim() ? selection : content;
    const truncated = snippet.length > ATTACH_CAP;
    const code = truncated ? `${snippet.slice(0, ATTACH_CAP)}\n… (truncated)` : snippet;
    const file = viewingOriginal || selected.url;
    const label = `${file}${selection.trim() ? " (snippet)" : truncated ? " (truncated)" : ""}`;
    onAttach(label, code);
  };

  const visible = scripts.filter((s) =>
    s.url.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
        {visible.map((s) => (
          <li key={s.scriptId}>
            <button
              className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-gray-50 ${
                selected?.scriptId === s.scriptId ? "bg-blue-50" : ""
              }`}
              onClick={() => void openScript(s)}
            >
              <span className="min-w-0 flex-1 truncate font-mono" title={s.url}>
                {s.url}
              </span>
              {s.hasSourceMap && (
                <span className="shrink-0 rounded bg-emerald-100 px-1 py-px text-[10px] font-semibold text-emerald-700">
                  map
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <div className="flex items-center gap-2 border-b border-gray-200 p-2">
          {originalSources.length > 0 && (
            <select
              className="min-w-0 flex-1 rounded border border-gray-300 px-1 py-0.5 text-xs"
              value={viewingOriginal}
              onChange={(e) => {
                if (e.target.value === "") void openScript(selected);
                else void openOriginal(e.target.value);
              }}
            >
              <option value="">(generated) {selected.url}</option>
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
        {!loading && content !== null && (
          <pre
            ref={preRef}
            className="select-text whitespace-pre p-2 font-mono text-[11px] leading-4"
          >
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

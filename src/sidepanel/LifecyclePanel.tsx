import { useEffect, useRef, useState } from "react";
import type { FrameworkResolution, PanelToBg, ScriptInfo } from "../shared/messages";
import {
  getOriginalSources,
  getOriginalSourceContent,
  resolveGeneratedPosition,
} from "./sourceMapResolver";
import { classifyPath, compileIgnorePatterns } from "./codeClassifier";
import {
  DEFAULT_LIFECYCLE_HOOKS,
  parseHookList,
  scanSourceForHooks,
  type LifecycleHit,
} from "./lifecycleScan";

// M7 Part 3: "Break on lifecycle". Scans the user's OWN sources (files that
// classify as user code — not node_modules / ignore-list matches) for
// lifecycle hook occurrences and arms ordinary source-line breakpoints on
// them, via the M2 reverse mapping when a source map exists. Deterministic
// and immune to async-chain breakage: it breaks at the definition instead of
// tracing back from the request. Combine with "Reload & capture" so the hook
// is caught on the next load.

const HOOKS_STORE_KEY = "lifecycleHooksByFramework";
const MAX_SCRIPTS_SCANNED = 40;
const MAX_FILES_WITH_HITS = 50;

interface FileHits {
  file: string; // original source path, or generated URL when unmapped
  scriptId: string; // resolution key (reverse mapping is per-script)
  scriptUrl: string; // generated script URL (display; "" for eval'd scripts)
  mapped: boolean; // true = `file` is an original source needing reverse mapping
  hits: LifecycleHit[];
}

interface LifecyclePanelProps {
  scripts: ScriptInfo[];
  refreshScripts: () => void;
  getScriptSource: (scriptId: string) => Promise<string>;
  framework: FrameworkResolution | null;
  ignorePatterns: string[]; // the user's blackbox/ignore list (classifier input)
  send: (msg: PanelToBg) => void;
}

export default function LifecyclePanel({
  scripts,
  refreshScripts,
  getScriptSource,
  framework,
  ignorePatterns,
  send,
}: LifecyclePanelProps) {
  const fw = framework?.framework ?? "unknown";
  const [hookText, setHookText] = useState("");
  const [results, setResults] = useState<FileHits[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Scan waits for the fresh scripts snapshot requested by refreshScripts().
  const pendingScanRef = useRef(false);

  // Hook lists are per-framework and user-editable; persist edits so they
  // survive panel reloads.
  useEffect(() => {
    let cancelled = false;
    void chrome.storage.local.get(HOOKS_STORE_KEY).then((stored) => {
      if (cancelled) return;
      const byFw = (stored[HOOKS_STORE_KEY] ?? {}) as Record<string, string>;
      setHookText(byFw[fw] ?? (DEFAULT_LIFECYCLE_HOOKS[fw] ?? []).join(", "));
    });
    return () => {
      cancelled = true;
    };
  }, [fw]);

  const saveHookText = (text: string) => {
    setHookText(text);
    void chrome.storage.local.get(HOOKS_STORE_KEY).then((stored) => {
      const byFw = (stored[HOOKS_STORE_KEY] ?? {}) as Record<string, string>;
      byFw[fw] = text;
      void chrome.storage.local.set({ [HOOKS_STORE_KEY]: byFw });
    });
  };

  const doScan = async () => {
    const hooks = parseHookList(hookText);
    if (hooks.length === 0) {
      setNote("No hook names to scan for — add some above (comma-separated).");
      return;
    }
    setScanning(true);
    setNote(null);
    const compiled = compileIgnorePatterns(ignorePatterns);
    const isUserPath = (url: string) => classifyPath(url, compiled) === "user";
    const found: FileHits[] = [];
    try {
      const candidates = scripts.filter((s) => s.url && isUserPath(s.url));
      for (const script of candidates.slice(0, MAX_SCRIPTS_SCANNED)) {
        if (found.length >= MAX_FILES_WITH_HITS) break;
        let scannedOriginals = false;
        if (script.sourceMapURL) {
          const sources = await getOriginalSources(script.scriptId);
          if (sources) {
            scannedOriginals = true;
            for (const source of sources) {
              if (found.length >= MAX_FILES_WITH_HITS) break;
              if (!isUserPath(source)) continue; // skip node_modules inside the map
              const content = await getOriginalSourceContent(script.scriptId, source);
              if (!content) continue;
              const hits = scanSourceForHooks(content, hooks);
              if (hits.length > 0) {
                found.push({
                  file: source,
                  scriptId: script.scriptId,
                  scriptUrl: script.url,
                  mapped: true,
                  hits,
                });
              }
            }
          }
        }
        if (!scannedOriginals) {
          // No usable map: scan the generated text directly. Hits arm at the
          // raw generated line — coarser, but still functional.
          try {
            const content = await getScriptSource(script.scriptId);
            if (content.length <= 2_000_000) {
              const hits = scanSourceForHooks(content, hooks);
              if (hits.length > 0) {
                found.push({
                  file: script.url,
                  scriptId: script.scriptId,
                  scriptUrl: script.url,
                  mapped: false,
                  hits,
                });
              }
            }
          } catch {
            // script gone (navigation) — skip
          }
        }
      }
      setResults(found);
      if (found.length === 0) {
        setNote(
          "No lifecycle hooks found in your sources. Check the hook names above, and make sure scripts are loaded (Reload & capture repopulates them).",
        );
      }
    } finally {
      setScanning(false);
    }
  };

  // Refresh the script list first, then scan when the snapshot arrives.
  useEffect(() => {
    if (pendingScanRef.current) {
      pendingScanRef.current = false;
      void doScan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scripts]);

  const startScan = () => {
    pendingScanRef.current = true;
    refreshScripts();
  };

  const armHit = async (fileHits: FileHits, hit: LifecycleHit) => {
    setNote(null);
    if (fileHits.mapped) {
      const gen = await resolveGeneratedPosition(
        fileHits.scriptId,
        fileHits.file,
        hit.line,
      );
      if (!gen) {
        setNote(
          `${fileHits.file}:${hit.line} has no mapping in the shipped bundle (dead code or inlined) — can't arm it.`,
        );
        return;
      }
      send({
        type: "set-breakpoint",
        url: fileHits.scriptUrl,
        scriptId: fileHits.scriptId,
        lineNumber: gen.lineNumber,
        columnNumber: gen.columnNumber,
        originalLabel: `${fileHits.file}:${hit.line} (${hit.name})`,
        tag: "lifecycle",
      });
    } else {
      send({
        type: "set-breakpoint",
        url: fileHits.scriptUrl,
        scriptId: fileHits.scriptId,
        lineNumber: hit.line - 1, // scan lines are 1-based; CDP wants 0-based
        originalLabel: `${hit.name} @ line ${hit.line}`,
        tag: "lifecycle",
      });
    }
  };

  const armAllOf = async (name: string) => {
    const all = (results ?? []).flatMap((f) =>
      f.hits.filter((h) => h.name === name).map((h) => ({ f, h })),
    );
    if (all.length === 0) return;
    if (
      !confirm(
        `Arm ${all.length} breakpoint(s) — every "${name}" found in your code? This can pause frequently; clear them with "Clear lifecycle breakpoints" in the Breakpoints list.`,
      )
    ) {
      return;
    }
    for (const { f, h } of all) await armHit(f, h);
  };

  const hookNamesWithHits = [
    ...new Set((results ?? []).flatMap((f) => f.hits.map((h) => h.name))),
  ];
  const visible = (results ?? []).filter(
    (f) =>
      !filter ||
      f.file.toLowerCase().includes(filter.toLowerCase()) ||
      f.hits.some((h) => h.name.toLowerCase().includes(filter.toLowerCase())),
  );

  return (
    <section id="lifecycle-panel">
      <h2 className="font-semibold">Break on lifecycle</h2>
      <p className="mt-1 text-[11px] text-gray-500">
        Scans your own sources (ignore-list files excluded) for lifecycle hooks
        and arms source-line breakpoints on them — deterministic even when async
        chains break. Arm before "Reload &amp; capture" to catch init-time code.
      </p>
      <textarea
        className="mt-1 h-10 w-full rounded border border-gray-300 p-1 font-mono text-[11px]"
        title="Hook names to scan for (comma or newline separated) — editable, saved per framework"
        placeholder="Hook names, e.g. ngOnInit, useEffect, mounted"
        value={hookText}
        onChange={(e) => saveHookText(e.target.value)}
      />
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          disabled={scanning}
          onClick={startScan}
        >
          {scanning ? "Scanning…" : "Scan my sources"}
        </button>
        {results && results.length > 0 && (
          <input
            className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-xs"
            placeholder="Filter by file or hook…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
      </div>
      {note && <p className="mt-1 text-xs text-amber-700">{note}</p>}

      {hookNamesWithHits.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-gray-500">Break on ALL:</span>
          {hookNamesWithHits.map((name) => (
            <button
              key={name}
              className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[11px] text-amber-800 hover:bg-amber-200"
              title={`Arm a breakpoint on every "${name}" found in your code (pauses frequently)`}
              onClick={() => void armAllOf(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {visible.length > 0 && (
        <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
          {visible.map((f) => (
            <li key={`${f.scriptId}|${f.file}`}>
              <p className="break-all font-mono text-[11px] font-semibold text-gray-700">
                {f.file}
                {!f.mapped && (
                  <span className="ml-1 rounded bg-gray-200 px-1 text-[10px] font-normal text-gray-600">
                    no map — raw lines
                  </span>
                )}
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {f.hits.map((h, i) => (
                  <li key={i} className="flex items-center gap-2 pl-2 text-xs">
                    <span className="min-w-0 flex-1 truncate font-mono text-gray-600">
                      <span className="font-semibold text-gray-800">{h.name}</span>
                      :{h.line}{" "}
                      <span className="text-gray-400">{h.snippet}</span>
                    </span>
                    <button
                      className="shrink-0 rounded bg-gray-200 px-1.5 py-px text-[10px] font-medium text-gray-700 hover:bg-gray-300"
                      title="Arm a source-line breakpoint here (pending until the script loads)"
                      onClick={() => void armHit(f, h)}
                    >
                      ⏸ break
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

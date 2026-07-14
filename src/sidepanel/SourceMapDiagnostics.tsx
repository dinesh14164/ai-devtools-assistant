import { useState } from "react";
import type { ScriptInfo } from "../shared/messages";
import {
  describeSourceMapStatus,
  retrySourceMap,
  type SourceMapStatus,
} from "./sourceMapResolver";

// Fix 4: the "why isn't it using the real files?" panel. Lists every parsed
// script (the scriptParsed registry) with its per-script map status, grouped
// by origin so MFE remotes (localhost) and the container host are visually
// separated. Updates live as lazy MFE chunks parse.

interface SourceMapDiagnosticsProps {
  scripts: ScriptInfo[];
  statuses: Record<string, SourceMapStatus>;
}

function originOf(script: ScriptInfo): string {
  if (!script.url) return "(eval'd / anonymous scripts)";
  try {
    const u = new URL(script.url);
    if (u.origin && u.origin !== "null") return u.origin;
    return `${u.protocol}//${u.host || "(no host)"}`; // webpack:// etc.
  } catch {
    return "(unparseable URL)";
  }
}

const STATE_BADGE: Record<string, string> = {
  resolved: "bg-emerald-100 text-emerald-700",
  "no-map": "bg-gray-200 text-gray-600",
  "fetch-failed": "bg-red-100 text-red-700",
  "parse-failed": "bg-red-100 text-red-700",
  pending: "bg-amber-100 text-amber-700",
  "not-loaded": "bg-sky-100 text-sky-700",
};

function ScriptRow({
  script,
  status,
}: {
  script: ScriptInfo;
  status: SourceMapStatus | undefined;
}) {
  const [busy, setBusy] = useState(false);
  // A script never referenced by a frame hasn't been resolved yet (resolution
  // is lazy); derive its display state instead of pretending failure.
  const displayState = status
    ? status.state
    : script.sourceMapURL
      ? "not-loaded"
      : "no-map";
  const detail = status
    ? describeSourceMapStatus(status)
    : script.sourceMapURL
      ? "not loaded yet (maps resolve lazily, when frames reference the script)"
      : "no source map (scriptParsed carried no sourceMapURL)";
  const canLoad = !!script.sourceMapURL && displayState !== "resolved";
  return (
    <li className="flex items-start gap-2 py-0.5 text-xs">
      <span
        className={`mt-px shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${STATE_BADGE[displayState] ?? "bg-gray-100 text-gray-600"}`}
      >
        {displayState === "not-loaded" ? "not loaded" : displayState}
      </span>
      <span className="min-w-0 flex-1">
        <span className="break-all font-mono" title={`scriptId ${script.scriptId}`}>
          {script.url || "(anonymous eval'd script)"}
        </span>
        <span className="block break-all text-[10px] text-gray-500" title={detail}>
          {detail}
        </span>
      </span>
      {canLoad && (
        <button
          className="shrink-0 rounded bg-gray-200 px-1.5 py-px text-[10px] font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50"
          disabled={busy}
          title="Re-attempt map discovery + fetch for this script"
          onClick={() => {
            setBusy(true);
            void retrySourceMap(script.scriptId).finally(() => setBusy(false));
          }}
        >
          {busy ? "…" : displayState === "not-loaded" ? "Load" : "Retry"}
        </button>
      )}
    </li>
  );
}

export default function SourceMapDiagnostics({
  scripts,
  statuses,
}: SourceMapDiagnosticsProps) {
  const groups = new Map<string, ScriptInfo[]>();
  for (const s of scripts) {
    const key = originOf(s);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const authFailures = Object.values(statuses).filter(
    (s) => s.state === "fetch-failed" && (s.httpStatus === 401 || s.httpStatus === 403),
  ).length;

  return (
    <details className="border-b border-gray-200 px-2 py-1">
      <summary className="cursor-pointer text-xs font-semibold text-gray-700">
        Source maps{" "}
        <span className="font-normal text-gray-500">
          ({scripts.length} scripts — status per script, grouped by origin)
        </span>
      </summary>
      {authFailures >= 2 && (
        <p className="mt-1 rounded border border-amber-300 bg-amber-50 p-1.5 text-[11px] text-amber-800">
          Source maps couldn't be fetched (authentication — HTTP 401/403 on{" "}
          {authFailures} scripts). They're being requested in the page's context
          with its credentials — if this persists, check that the .map files are
          actually deployed and accessible on the server.
        </p>
      )}
      {groups.size === 0 && (
        <p className="mt-1 text-xs text-gray-500">
          No scripts parsed yet — attach and load a page.
        </p>
      )}
      {[...groups.entries()].map(([origin, group]) => (
        <div key={origin} className="mt-1.5">
          <p className="break-all font-mono text-[11px] font-semibold text-gray-600">
            {origin}
          </p>
          <ul className="mt-0.5 divide-y divide-gray-50 pl-1">
            {group.map((s) => (
              <ScriptRow key={s.scriptId} script={s} status={statuses[s.scriptId]} />
            ))}
          </ul>
        </div>
      ))}
    </details>
  );
}

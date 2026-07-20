import { useState } from "react";
import type { ScriptInfo } from "../shared/messages";
import {
  describeSourceMapStatus,
  retrySourceMap,
  type SourceMapStatus,
} from "./sourceMapResolver";
import { computeIndexStatus, originOf } from "./sourceIndex";

// The "why isn't it using the real files?" panel. Lists every parsed script
// (the scriptParsed registry) with its per-script map status, grouped by
// origin so MFE remotes (localhost) and the container host are visually
// separated — plus an INDEX summary at the top: this is "the number that
// should have made the failure obvious immediately" (0 files indexed), and a
// per-origin summary row (e.g. "localhost:4202 — 0/14 resolved (TLS error)")
// so a single failing remote among many working ones stands out. Updates
// live as lazy MFE chunks parse.

interface SourceMapDiagnosticsProps {
  scripts: ScriptInfo[];
  statuses: Record<string, SourceMapStatus>;
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
          {status?.state === "resolved" && (
            <span className="ml-1 text-emerald-700">
              — {status.sourcesCount} file{status.sourcesCount === 1 ? "" : "s"} indexed
            </span>
          )}
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

function OriginGroup({
  origin,
  group,
  statuses,
}: {
  origin: string;
  group: ScriptInfo[];
  statuses: Record<string, SourceMapStatus>;
}) {
  const [retrying, setRetrying] = useState(false);
  const candidates = group.filter((s) => s.sourceMapURL);
  const resolved = candidates.filter((s) => statuses[s.scriptId]?.state === "resolved");
  const files = resolved.reduce(
    (sum, s) => sum + (statuses[s.scriptId] as Extract<SourceMapStatus, { state: "resolved" }>).sourcesCount,
    0,
  );
  // A representative failure reason when this origin has candidates but none
  // resolved — this is what turns "0/14" into "0/14 (TLS error)".
  const failureReason =
    candidates.length > 0 && resolved.length === 0
      ? candidates
          .map((s) => statuses[s.scriptId])
          .find((st): st is SourceMapStatus => !!st && st.state !== "pending")
      : undefined;

  const retryAll = async () => {
    setRetrying(true);
    try {
      await Promise.all(
        candidates
          .filter((s) => statuses[s.scriptId]?.state !== "resolved")
          .map((s) => retrySourceMap(s.scriptId)),
      );
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 break-all font-mono text-[11px] font-semibold text-gray-600">
          {origin}
        </p>
        {candidates.length > 0 && (
          <span
            className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${
              resolved.length === candidates.length
                ? "bg-emerald-100 text-emerald-700"
                : resolved.length === 0
                  ? "bg-red-100 text-red-700"
                  : "bg-amber-100 text-amber-700"
            }`}
            title={failureReason ? describeSourceMapStatus(failureReason) : undefined}
          >
            {resolved.length}/{candidates.length} resolved
            {failureReason ? ` (${describeSourceMapStatus(failureReason)})` : ""}
          </span>
        )}
        {candidates.length > 0 && resolved.length < candidates.length && (
          <button
            className="shrink-0 rounded bg-gray-200 px-1.5 py-px text-[10px] font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50"
            disabled={retrying}
            title="Retry every unresolved script from this origin"
            onClick={() => void retryAll()}
          >
            {retrying ? "…" : "Retry origin"}
          </button>
        )}
      </div>
      {candidates.length > 0 && (
        <p className="text-[10px] text-gray-400">{files} file{files === 1 ? "" : "s"} indexed</p>
      )}
      <ul className="mt-0.5 divide-y divide-gray-50 pl-1">
        {group.map((s) => (
          <ScriptRow key={s.scriptId} script={s} status={statuses[s.scriptId]} />
        ))}
      </ul>
    </div>
  );
}

export default function SourceMapDiagnostics({
  scripts,
  statuses,
}: SourceMapDiagnosticsProps) {
  const groups = new Map<string, ScriptInfo[]>();
  for (const s of scripts) {
    const key = originOf(s.url);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const index = computeIndexStatus(scripts);
  const authFailures = Object.values(statuses).filter(
    (s) => s.state === "fetch-failed" && (s.httpStatus === 401 || s.httpStatus === 403),
  ).length;

  return (
    <details className="border-b border-gray-200 px-2 py-1" open={index.isEmpty}>
      <summary className="cursor-pointer text-xs font-semibold text-gray-700">
        Source maps{" "}
        <span
          className={`font-normal ${index.isEmpty ? "text-red-700" : index.isPartial ? "text-amber-700" : "text-gray-500"}`}
        >
          — indexed {index.totalFiles} original file{index.totalFiles === 1 ? "" : "s"} from{" "}
          {index.resolvedScripts}/{index.totalScripts} scripts
        </span>
      </summary>
      {index.isEmpty && index.totalScripts > 0 && (
        <p className="mt-1 rounded border border-red-300 bg-red-50 p-1.5 text-[11px] text-red-800">
          No original sources are indexed — every script's source map failed
          to load. "Find entry point" and source search can't work until this
          is fixed. Check the per-origin reasons below.
        </p>
      )}
      {index.isPartial && (
        <p className="mt-1 rounded border border-amber-300 bg-amber-50 p-1.5 text-[11px] text-amber-800">
          Some origins are fully indexed, but at least one isn't — the
          origins below with 0 resolved are missing from any source search.
        </p>
      )}
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
        <OriginGroup key={origin} origin={origin} group={group} statuses={statuses} />
      ))}
    </details>
  );
}

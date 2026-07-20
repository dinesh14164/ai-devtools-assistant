import type { ScriptInfo } from "../shared/messages";
import {
  describeSourceMapStatus,
  getOriginalSources,
  getSourceMapStatuses,
  type SourceMapStatus,
} from "./sourceMapResolver";

// The "source index" is what search_sources and get_source actually search —
// the union of every original file successfully resolved through a source
// map, across every script in the registry. In an MFE app it's built from
// MANY independent scripts across MANY origins (container + remotes), and
// resolution is per-script and can fail independently per origin. This
// module makes that index OBSERVABLE (so "0 files scanned" is diagnosable
// before it wastes an agent run) and PROACTIVE (so the index actually gets
// built ahead of the agent needing it, rather than only ever growing lazily
// as frames happen to reference a script).

export interface OriginIndexSummary {
  origin: string;
  totalScripts: number; // scripts with a sourceMapURL (candidates)
  resolvedScripts: number;
  totalFiles: number; // sum of sourcesCount across this origin's resolved scripts
  // A representative failure reason, when at least one script was attempted
  // and none resolved — this is what makes "localhost:4202 — TLS error"
  // immediately visible instead of a bare "0/14 resolved".
  failureReason?: string;
}

export interface IndexStatus {
  totalScripts: number; // scripts with a sourceMapURL, across all origins
  resolvedScripts: number;
  totalFiles: number; // sum of sourcesCount across ALL resolved scripts
  origins: OriginIndexSummary[];
  isEmpty: boolean; // totalFiles === 0 — the agent must refuse to run
  isPartial: boolean; // some origins resolved, at least one did not
}

export function originOf(url: string): string {
  if (!url) return "(eval'd / anonymous scripts)";
  try {
    const u = new URL(url);
    return u.origin && u.origin !== "null" ? u.origin : `${u.protocol}//${u.host || "(no host)"}`;
  } catch {
    return "(unparseable URL)";
  }
}

/**
 * Derive index status from CURRENTLY KNOWN per-script statuses. Cheap and
 * synchronous — call `ensureIndexed` first if scripts haven't been attempted
 * yet, or this will under-report (a script nobody has asked about yet has no
 * status, and reads as neither resolved nor failed).
 */
export function computeIndexStatus(scripts: ScriptInfo[]): IndexStatus {
  const statuses = getSourceMapStatuses();
  const byOrigin = new Map<string, OriginIndexSummary>();
  let totalScripts = 0;
  let resolvedScripts = 0;
  let totalFiles = 0;

  for (const s of scripts) {
    if (!s.sourceMapURL) continue; // not a map candidate at all — not part of the index
    totalScripts++;
    const origin = originOf(s.url);
    let entry = byOrigin.get(origin);
    if (!entry) {
      entry = { origin, totalScripts: 0, resolvedScripts: 0, totalFiles: 0 };
      byOrigin.set(origin, entry);
    }
    entry.totalScripts++;
    const status: SourceMapStatus | undefined = statuses[s.scriptId];
    if (status?.state === "resolved") {
      resolvedScripts++;
      totalFiles += status.sourcesCount;
      entry.resolvedScripts++;
      entry.totalFiles += status.sourcesCount;
    } else if (status && status.state !== "pending" && !entry.failureReason) {
      entry.failureReason = describeSourceMapStatus(status);
    }
  }

  const origins = [...byOrigin.values()].sort((a, b) => a.origin.localeCompare(b.origin));
  const anyFullyFailed = origins.some((o) => o.totalScripts > 0 && o.resolvedScripts === 0);
  const anyResolved = origins.some((o) => o.resolvedScripts > 0);

  return {
    totalScripts,
    resolvedScripts,
    totalFiles,
    origins,
    isEmpty: totalFiles === 0,
    isPartial: anyFullyFailed && anyResolved,
  };
}

/**
 * Proactively attempt to resolve every candidate script's map — not just the
 * ones a stack frame happens to reference. This is what actually BUILDS the
 * index ahead of gating the agent on it; `computeIndexStatus` only reads
 * whatever's already been attempted. Safe to call repeatedly: resolution is
 * cached (successes and genuine "no-map" negatives permanently; transient
 * failures are retried automatically — see sourceMapResolver.ts).
 */
export async function ensureIndexed(scripts: ScriptInfo[]): Promise<void> {
  await Promise.all(
    scripts
      .filter((s) => s.sourceMapURL)
      .map((s) => getOriginalSources(s.scriptId).catch(() => null)),
  );
}

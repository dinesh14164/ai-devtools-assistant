import { useEffect, useRef, useState } from "react";
import type {
  CapturedRequest,
  FrameworkResolution,
  PausedSnapshot,
  RemoteProperty,
  ScriptInfo,
} from "../shared/messages";
import type { ModelConfigState } from "./modelConfig";
import {
  runOrGetCached,
  type AgentResult,
  type AgentStep,
  type EntryCandidate,
  type EvidenceLink,
} from "./entryPointAgent";

// The "Find entry point" panel: live-appending investigation log (plain
// language + findings, never raw tool names), which BECOMES the evidence
// trail on completion — one component, not two. Runs only on explicit click
// from a live pause; cancellation aborts the loop and preserves the pause.
//
// Visibility fixes (this revision): the button-adjacent box appears on the
// SAME render as the click (no waiting on this component's own effect), the
// step log auto-follows the latest step unless the user scrolled up, a
// sticky top-of-view status line (rendered by the PARENT via
// onStatusChange — see AgentRunStatus below) stays visible regardless of
// scroll position, a slow tool call surfaces an interim "still working"
// line, and the log collapses into the result on completion with the result
// scrolled into view.

const STILL_WORKING_MS = 2000;

interface EntryPointPanelProps {
  paused: PausedSnapshot;
  scripts: ScriptInfo[];
  requests: CapturedRequest[];
  framework: FrameworkResolution | null;
  ignorePatterns: string[];
  config: ModelConfigState;
  fetchProperties: (objectId: string) => Promise<RemoteProperty[]>;
  startNonce: number | null; // bumped by the "Find entry point" buttons
  onOpenSource: (scriptId: string, source: string, line: number) => void;
  // Arms a source-line breakpoint (reverse-mapped). Resolves to an error
  // message or null on success. Caller-side confirmation happens HERE.
  onBreakAt: (candidate: EntryCandidate) => Promise<string | null>;
  onOpenSettings: () => void;
  onOpenSourcesTab: () => void;
  // Reports live run status so the PARENT can render a sticky bar spanning
  // the whole Debug view — a bar sticky-positioned inside this component
  // would only stay pinned within this component's own (short) height, not
  // while the user has scrolled down to Breakpoints/Lifecycle/etc.
  onStatusChange: (status: AgentRunStatus | null) => void;
}

export interface AgentRunStatus {
  currentStepLabel: string;
  elapsedSec: number;
  onCancel: () => void;
}

type Phase = "idle" | "no-profile" | "running" | "done";

const STATE_ICON: Record<AgentStep["state"], string> = {
  running: "⟳",
  done: "✓",
  failed: "✗",
};

function StepLine({
  step,
  stillWorking,
  onOpenSource,
}: {
  step: AgentStep;
  stillWorking: boolean;
  onOpenSource: (link: EvidenceLink) => void;
}) {
  return (
    <li className="flex items-start gap-1.5 text-xs">
      <span
        className={`w-3 shrink-0 text-center ${
          step.state === "running"
            ? "animate-pulse text-blue-600"
            : step.state === "failed"
              ? "text-red-600"
              : "text-emerald-600"
        }`}
      >
        {STATE_ICON[step.state]}
      </span>
      <span className="min-w-0 flex-1">
        <span className={step.state === "failed" ? "text-red-700" : "text-gray-800"}>
          {step.label}
          {step.state === "running" && stillWorking && (
            <span className="italic text-gray-400"> — still working…</span>
          )}
        </span>
        {step.finding && (
          <span className="block break-all text-[11px] text-gray-500">
            → {step.finding}
            {step.link && (
              <button
                className="ml-1 text-blue-700 underline decoration-dotted hover:text-blue-900"
                title="Open in Sources"
                onClick={() => onOpenSource(step.link!)}
              >
                open
              </button>
            )}
          </span>
        )}
      </span>
    </li>
  );
}

function CandidateCard({
  candidate,
  isPrimary,
  onOpenSource,
  onBreakAt,
}: {
  candidate: EntryCandidate;
  isPrimary: boolean;
  onOpenSource: (link: EvidenceLink) => void;
  onBreakAt: (candidate: EntryCandidate) => void;
}) {
  return (
    <div
      className={`rounded border p-2 ${
        isPrimary ? "border-emerald-300 bg-emerald-50" : "border-gray-200 bg-white"
      }`}
    >
      <p className="flex flex-wrap items-baseline gap-x-1.5 font-mono text-xs">
        <span className="font-semibold">{candidate.label}</span>
        <button
          className="break-all text-blue-700 underline decoration-dotted hover:text-blue-900"
          title={candidate.file}
          onClick={() =>
            candidate.scriptId &&
            onOpenSource({
              scriptId: candidate.scriptId,
              source: candidate.file,
              line: candidate.line,
            })
          }
        >
          {candidate.prettyFile}:{candidate.line}
        </button>
      </p>
      {candidate.evidence && (
        <p className="mt-0.5 text-[11px] text-gray-600">{candidate.evidence}</p>
      )}
      <div className="mt-1 flex flex-wrap gap-1">
        <button
          className="rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700"
          title="Arms a permanent source-line breakpoint here (asks first)"
          onClick={() => onBreakAt(candidate)}
        >
          Break at {isPrimary ? "entry point" : "this candidate"}
        </button>
        <button
          className="rounded bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-800 hover:bg-gray-300"
          onClick={() =>
            candidate.scriptId &&
            onOpenSource({
              scriptId: candidate.scriptId,
              source: candidate.file,
              line: candidate.line,
            })
          }
        >
          Open in Sources
        </button>
      </div>
    </div>
  );
}

export default function EntryPointPanel({
  paused,
  scripts,
  requests,
  framework,
  ignorePatterns,
  config,
  fetchProperties,
  startNonce,
  onOpenSource,
  onBreakAt,
  onOpenSettings,
  onOpenSourcesTab,
  onStatusChange,
}: EntryPointPanelProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [armNote, setArmNote] = useState<string | null>(null);
  const [stepsExpanded, setStepsExpanded] = useState(true);
  const [autoFollow, setAutoFollow] = useState(true);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const startedNonceRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  // Seeded to "now", not 0: `running` (below) goes true synchronously the
  // instant hasStarted flips — before start() gets to set this for real —
  // so elapsed must never compute against epoch zero (a multi-billion-second
  // flash) during that transient window.
  const runStartRef = useRef(Date.now());
  const stepStartRef = useRef<{ id: number; since: number } | null>(null);
  const prevRunningRef = useRef(false);
  const logRef = useRef<HTMLUListElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);

  // A click has happened this pause the instant startNonce is non-null —
  // render SOMETHING from the very next paint, without waiting for the
  // effect below to actually invoke start(). "No frame may look unchanged
  // after the click."
  const hasStarted = startNonce !== null;
  const displayPhase: Phase = phase === "idle" && hasStarted ? "running" : phase;
  const running = displayPhase === "running";

  // A NEW pause is a new investigation context: reset the panel (the
  // cross-pause result cache in the agent module is unaffected). This
  // component only exists while `paused` is truthy (parent unmounts it on
  // resume), so this effectively fires on mount for each fresh pause.
  useEffect(() => {
    abortRef.current?.abort();
    setPhase("idle");
    setSteps([]);
    setResult(null);
    setArmNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused.pauseId]);

  // Clear the parent's sticky-bar status on unmount (e.g. resumed mid-run).
  useEffect(() => () => onStatusChange(null), [onStatusChange]);

  // Tick while running — drives elapsed time and the "still working" hints.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  const start = async (force: boolean) => {
    if (runningRef.current) return;
    const profile = config.profiles.find((p) => p.id === config.activeProfileId) ?? null;
    if (!profile) {
      setPhase("no-profile");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    runningRef.current = true;
    runStartRef.current = Date.now();
    stepStartRef.current = null;
    setPhase("running");
    setSteps([]);
    setResult(null);
    setArmNote(null);
    setStepsExpanded(true);
    setAutoFollow(true);
    setNowTick(Date.now());
    try {
      const res = await runOrGetCached(
        { profile, paused, scripts, requests, framework, ignorePatterns, fetchProperties },
        setSteps,
        controller.signal,
        force,
      );
      if (res.fromCache) setSteps(res.steps);
      setResult(res);
    } finally {
      runningRef.current = false;
      setPhase("done");
    }
  };

  // External trigger (the "Find entry point" buttons bump startNonce).
  useEffect(() => {
    if (startNonce === null || startNonce === startedNonceRef.current) return;
    startedNonceRef.current = startNonce;
    void start(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startNonce]);

  // Auto-follow the log to the latest step, UNLESS the user scrolled up —
  // scrolling back to the bottom resumes following.
  useEffect(() => {
    if (autoFollow && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [steps, autoFollow]);

  const handleLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    setAutoFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  // On completion (running -> not running), collapse the step log and
  // scroll the RESULT into view — the answer is what the user should land
  // on, for every outcome (found/partial/cancelled/error), not just success.
  useEffect(() => {
    if (prevRunningRef.current && !running) {
      setStepsExpanded(false);
      resultRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    prevRunningRef.current = running;
  }, [running]);

  // Track when the CURRENT running step started, to surface "still working"
  // once a single tool call runs past ~2s — the log must never look frozen.
  const runningStep = steps.find((s) => s.state === "running");
  useEffect(() => {
    if (runningStep) {
      if (stepStartRef.current?.id !== runningStep.id) {
        stepStartRef.current = { id: runningStep.id, since: Date.now() };
      }
    } else {
      stepStartRef.current = null;
    }
  }, [runningStep?.id]);
  const stillWorking =
    running && !!stepStartRef.current && nowTick - stepStartRef.current.since > STILL_WORKING_MS;

  const elapsedSec = running ? Math.max(0, Math.floor((nowTick - runStartRef.current) / 1000)) : 0;
  // Between tool calls there's no "running" step yet (waiting on the next
  // model turn) — say so instead of going quiet.
  const currentStepLabel = !running
    ? ""
    : !steps.length
      ? "Starting investigation…"
      : runningStep
        ? `${runningStep.label}${stillWorking ? " — still working…" : ""}`
        : "Deciding next step…";

  // Report status up for the parent's sticky bar (spans the whole Debug
  // view — a locally-sticky bar here would only stay pinned within this
  // component's own short height).
  useEffect(() => {
    if (!running) {
      onStatusChange(null);
      return;
    }
    onStatusChange({
      currentStepLabel,
      elapsedSec,
      onCancel: () => abortRef.current?.abort(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, currentStepLabel, elapsedSec]);

  const breakAt = async (candidate: EntryCandidate) => {
    // Never auto-arm: explicit confirmation gates every breakpoint.
    if (
      !confirm(
        `Arm a permanent breakpoint at ${candidate.prettyFile}:${candidate.line} (${candidate.label})? The next run will pause there.`,
      )
    ) {
      return;
    }
    const error = await onBreakAt(candidate);
    setArmNote(
      error ??
        `Breakpoint armed at ${candidate.prettyFile}:${candidate.line} — see the Breakpoints list.`,
    );
  };

  const openLink = (link: EvidenceLink) =>
    onOpenSource(link.scriptId, link.source, link.line);

  const showRawFrames = () =>
    document
      .getElementById("paused-call-chain")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });

  if (!hasStarted) return null;

  if (displayPhase === "no-profile") {
    return (
      <div className="mt-2 rounded border border-gray-300 bg-white p-2 text-xs">
        <p className="text-gray-700">
          "Find entry point" needs a configured model — it routes through your
          active model profile, none is set up yet.
        </p>
        <button
          className="mt-1 rounded bg-blue-600 px-2 py-1 font-medium text-white hover:bg-blue-700"
          onClick={onOpenSettings}
        >
          Open Settings
        </button>
      </div>
    );
  }

  // Ranked secondary candidates, minus the primary (dedupe by file:line —
  // models often repeat the entry point in the candidates list).
  const secondary = (result?.candidates ?? []).filter(
    (c) =>
      !(
        result?.entryPoint &&
        c.file === result.entryPoint.file &&
        c.line === result.entryPoint.line
      ),
  );
  const showLog = running || stepsExpanded;
  const totalSteps = steps.length;

  return (
    <div className="mt-2 rounded border border-blue-200 bg-blue-50/50 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-gray-800">
          {running
            ? `Finding entry point… (${elapsedSec}s)`
            : result?.outcome === "found"
              ? "Entry point found"
              : result?.outcome === "cancelled"
                ? "Investigation cancelled"
                : result?.outcome === "error"
                  ? "Investigation failed"
                  : "Entry point — partial findings"}
        </span>
        {result?.fromCache && (
          <span className="rounded bg-gray-200 px-1.5 py-px text-[10px] font-semibold text-gray-600">
            cached
          </span>
        )}
        {running ? (
          <button
            className="rounded bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-800 hover:bg-gray-300"
            title="Aborts the investigation — the pause is preserved"
            onClick={() => abortRef.current?.abort()}
          >
            Cancel
          </button>
        ) : (
          <button
            className="rounded bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-800 hover:bg-gray-300"
            onClick={() => void start(true)}
          >
            Re-run
          </button>
        )}
      </div>

      {/* Entry point verdict first, when there is one — and the scroll
          target on completion, for every outcome. */}
      <div ref={resultRef}>
        {result?.entryPoint && (
          <div className="mt-2">
            <CandidateCard
              candidate={result.entryPoint}
              isPrimary
              onOpenSource={openLink}
              onBreakAt={(c) => void breakAt(c)}
            />
          </div>
        )}
        {result && !result.entryPoint && result.summary && (
          <p className="mt-1 text-xs text-gray-700">{result.summary}</p>
        )}
        {result?.error && (
          <p className="mt-1 break-all text-xs text-red-600">{result.error}</p>
        )}
        {armNote && <p className="mt-1 text-xs text-emerald-700">{armNote}</p>}
      </div>

      {/* The live log IS the evidence trail — steps append live while
          running (auto-following the bottom unless the user scrolled up),
          then collapse into "How this was found" behind a toggle once done. */}
      {(totalSteps > 0 || (result?.evidence.length ?? 0) > 0) && (
        <div className="mt-2">
          {!running && (
            <button
              className="text-[11px] font-semibold text-gray-600 hover:underline"
              onClick={() => setStepsExpanded((v) => !v)}
            >
              {stepsExpanded ? "▾" : "▸"} How this was found
              {!stepsExpanded && totalSteps > 0 ? ` (${totalSteps} steps)` : ""}
            </button>
          )}
          {showLog && (
            <ul
              ref={logRef}
              onScroll={running ? handleLogScroll : undefined}
              className={`mt-0.5 space-y-0.5 ${running ? "max-h-48 overflow-y-auto" : ""}`}
            >
              {steps.map((s) => (
                <StepLine
                  key={s.id}
                  step={s}
                  stillWorking={s.id === runningStep?.id && stillWorking}
                  onOpenSource={openLink}
                />
              ))}
              {!running &&
                result?.evidence.map((ev, i) => (
                  <li key={`ev-${i}`} className="flex items-start gap-1.5 text-xs">
                    <span className="w-3 shrink-0 text-center text-emerald-600">✓</span>
                    <span className="min-w-0 flex-1 break-words text-gray-800">
                      {ev.text}
                      {ev.link && (
                        <button
                          className="ml-1 text-blue-700 underline decoration-dotted hover:text-blue-900"
                          title="Open in Sources"
                          onClick={() => openLink(ev.link!)}
                        >
                          open
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              {running && !autoFollow && (
                <li className="sticky bottom-0 -mx-2 mt-1 bg-blue-50 px-2 py-0.5 text-center text-[10px] text-blue-700">
                  <button className="hover:underline" onClick={() => setAutoFollow(true)}>
                    ↓ New steps below — jump to latest
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {/* Ranked secondary candidates (the user picks). */}
      {!running && secondary.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-semibold text-gray-600">
            {result?.entryPoint ? "Other candidates" : "Strongest candidates found"}
          </p>
          <div className="mt-1 space-y-1">
            {secondary.map((c, i) => (
              <CandidateCard
                key={`${c.file}:${c.line}:${i}`}
                candidate={c}
                isPrimary={false}
                onOpenSource={openLink}
                onBreakAt={(cand) => void breakAt(cand)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Fallbacks + raw frames — always reachable, loud on failure. */}
      {!running && result && (
        <div className="mt-2 flex flex-wrap gap-1">
          <button
            className="rounded bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-800 hover:bg-gray-300"
            onClick={showRawFrames}
          >
            Show raw frames
          </button>
          {result.outcome !== "found" && (
            <>
              <button
                className="rounded bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-800 hover:bg-gray-300"
                title="Deterministic fallback: scan your sources for lifecycle hooks and break at the definition"
                onClick={() =>
                  document
                    .getElementById("lifecycle-panel")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
              >
                Break on lifecycle
              </button>
              <button
                className="rounded bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-800 hover:bg-gray-300"
                onClick={onOpenSourcesTab}
              >
                Search sources manually
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

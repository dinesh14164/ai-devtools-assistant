import type { CapturedRequest } from "../shared/messages";
import type { ResolvedFrame } from "./sourceMapResolver";

export const DEFAULT_QUESTION =
  "Why was this network request triggered? Explain the call chain in plain language.";

// Only these headers carry debugging signal; everything else is noise or
// (cookies, auth) must never leave the browser toward a model endpoint.
const CONTEXT_HEADERS = new Set([
  "content-type",
  "accept",
  "origin",
  "referer",
  "x-requested-with",
]);

function frameName(frame: ResolvedFrame): string {
  return frame.resolved?.name || frame.raw.functionName || "(anonymous)";
}

function frameLocation(frame: ResolvedFrame): string {
  if (frame.resolved) return `${frame.resolved.source}:${frame.resolved.line}`;
  if (!frame.raw.url) return "";
  return `${frame.raw.url}:${frame.raw.lineNumber}:${frame.raw.columnNumber}`;
}

export function formatRequestContext(
  request: CapturedRequest,
  frames: ResolvedFrame[],
): string {
  const lines = [
    "[Attached network request]",
    `${request.method} ${request.url}`,
    `Status: ${request.status ?? "pending"} · Type: ${
      request.mimeType ?? request.type ?? "unknown"
    }`,
  ];

  const headers = Object.entries(request.headers ?? {}).filter(([name]) =>
    CONTEXT_HEADERS.has(name.toLowerCase()),
  );
  if (headers.length > 0) {
    lines.push("Request headers:");
    for (const [name, value] of headers) lines.push(`  ${name}: ${value}`);
  }

  if (frames.length === 0) {
    lines.push("Initiator: none (parser or browser-initiated)");
    return lines.join("\n");
  }

  const anyResolved = frames.some((f) => f.resolved);
  lines.push(`Initiator stack (${anyResolved ? "resolved" : "raw"}, innermost first):`);
  const nameWidth = Math.min(
    28,
    Math.max(...frames.filter((f) => !f.isAsyncSeparator).map((f) => frameName(f).length)),
  );
  let firstRealFrame = true;
  for (const frame of frames) {
    if (frame.isAsyncSeparator) {
      lines.push(`  ${frame.raw.functionName}`);
      continue;
    }
    const marker = firstRealFrame ? "   ← request sent here" : "";
    firstRealFrame = false;
    lines.push(`  ${frameName(frame).padEnd(nameWidth)}  ${frameLocation(frame)}${marker}`);
  }
  return lines.join("\n");
}

# Release 5 — v1.4.0 (2026-07-15)

## "Find entry point" (agentic) + call-stack display & navigation

### Find entry point — an evidence-grounded agent for broken async chains

When a request breakpoint pauses in 100% framework code (zone.js, RxJS, the Apollo link chain), the stack can't be walked back — the developer's frames are gone. But the **heap is not**: framework closures still hold the component/service instances that started the chain. The new **"Find entry point"** button (paused view) runs a bounded tool loop against your **active model profile** that inspects live scopes, recognizes user classes by constructor name, and verifies the originating method in your **original sources**.

- **Seven fixed, read-only tools** (`get_stack`, `get_scope`, `inspect_object`, `search_sources`, `get_source`, `get_request`, `get_framework`) implemented on existing plumbing (M2 maps, M4 scopes, M5 sources, the "my code" classifier). **No evaluate-style tool exists** — the model can never run JS in the page, resume, step, or mutate anything; the pause survives the whole run (and cancellation).
- **Live investigation log in plain language** ("Inspecting frame 12 scopes… → 34 variables across 2 scopes", "Searching your sources for \"TicketsListComponent\"… → 3 matches"), with elapsed time and Cancel. The same log becomes the **"How this was found"** evidence trail — every line links to its frame or file:line for verification.
- Results are **never a bare verdict**: entry point + checkable evidence chain; multiple candidates are ranked for the user to pick. Files/lines the tools never returned are dropped (anti-hallucination guard).
- **"Break at entry point"** asks for confirmation, then arms a reverse-mapped source-line breakpoint. **Never automatic.**
- **Loud failure path:** on cap/exhaustion, the partial log + strongest candidates + fallbacks (Break on lifecycle, search manually, raw frames) are shown.
- Bounded (12 tool calls), cached per origin + request/operation, provider-agnostic via a strict JSON tool protocol over the plain chat API (no native tool-calling required), and gated on a configured model profile (same empty-state as chat).

### Call stack display (all frame lists: paused, initiator, evidence)

- **Hosts and bundler prefixes stripped**: resolved frames show project-relative paths (`src/app/tickets/tickets.component.ts:42`, not `webpack:///./src/…`); unresolved frames show the bare filename (`main.<hash>.js:0:877240`). Full URL/path on hover.
- **Origin chips** appear only when a frame's origin differs from the previous frame's — MFE container↔remote boundaries stay visible without repeating the host on every row.

### Click a frame → open it in Sources

- Every frame with a known location is clickable (underline + hover affordance): **resolved** frames open the original file (embedded `sourcesContent` first, page-context fetch fallback) at the highlighted line; **unresolved** frames open the pretty-printed generated script **at the mapped position** (generated→beautified positions mapped by whitespace-invariant offset).
- Breakpoints arm directly from original-source lines (existing reverse mapping); pretty-printed generated line numbers are clearly marked non-armable.
- Frames with no reachable source are non-clickable and explain why on hover (source-map status reasons).

---

# Release 4 — v1.3.0 (2026-07-14)

## Source-map resolution fixed for micro-frontends, eval builds, and authenticated hosts

Frames used to stay minified (`main.<hash>.js:0:877240`, mangled names) — and breakpoints landed in the bundle — even when DevTools' own Sources tab showed the real code. Resolution now works the way DevTools does, and when it can't, it says exactly why.

### Discovery: `Debugger.scriptParsed` is the source of truth

- The worker keeps a **script registry keyed by `scriptId`**, populated from `scriptParsed` — including `sourceMapURL` straight off the event. The old approach (fetch the script text, regex for a trailing `//# sourceMappingURL=`) is gone; it completely broke on webpack's `eval-source-map` / `eval-cheap-module-source-map` (standard in Module Federation dev builds), where the map is an inline `data:` URI inside each `eval()`. Inline maps now decode locally with **zero network**.
- **Frames carry `scriptId` everywhere** (initiator stacks, paused frames, async parents, extracted handlers) and resolution keys off it — scripts with empty or `webpack://` pseudo-URLs resolve fine. URLs are display-only.
- Breakpoints on URL-less (eval'd) scripts bind via `Debugger.setBreakpoint(scriptId)` automatically.

### Fetching: the page's network context, with the page's credentials

- Source maps (and non-embedded original sources) are fetched via **CDP `Network.loadNetworkResource`** (+ `IO.read`) in the page's context, `includeCredentials: true` — exactly like DevTools. Maps on authenticated internal hosts no longer silently 401. A credentialed extension fetch remains as fallback only when the CDP path is unavailable.
- **Per-script, per-origin:** each MFE bundle/remote (container host, `http://localhost` remotes, lazy chunks) resolves independently. Explicit localhost host permissions added; HTTPS-page-loading-HTTP-map failures are diagnosed as **mixed content** rather than a generic error.

### Transparency: no silent failures

- New **"Source maps" diagnostics panel** (Sources tab) lists every parsed script grouped by origin with a live status — `resolved` (source count), `no-map`, `fetch-failed` (HTTP code / net error), `parse-failed`, `pending` — plus per-script **Retry/Load**. Lazily-parsed MFE chunks appear as they arrive.
- Every unmapped frame shows a **⚠ badge with the exact reason on hover** ("map fetch failed: 401", "no source map", "map parse error: …").
- An aggregate hint appears when several maps fail with 401/403 (deployment/auth guidance).

### Reaching the real code

- **Resolved frame locations are clickable** → the Sources tab opens the original file at that line, highlighted. Content comes from the map's embedded `sourcesContent` (no network, no auth) or, failing that, a page-context fetch.
- In the original-file view, **click a line number to set a breakpoint on that original line** — reverse-mapped into the shipped bundle.
- Cosmetic: frame rows render badges / function name / location as separately spaced elements (no more `your codeNn`, `entryen`).

---

# Release 3 — v1.2.0 (2026-07-13)

## Lifecycle & load-time request debugging

Two fixes for requests that fire with **no interaction at all** — app bootstrap, route resolvers, and component lifecycle hooks (`ngOnInit`, `useEffect`, `mounted`, …).

### Reload & capture (the debugger was attaching too late)

The panel used to attach after the page had loaded, so init-time requests were uncatchable. Now:

- **"⟳ Reload & capture"** re-arms everything *before* the app bootstraps — persisted breakpoints, in-page hooks (GraphQL), async depth, blackbox — then reloads, capturing from the very first request. Pre-load breakpoints show as *pending* until their scripts parse.
- **Breakpoint definitions persist per-origin** (source-line, XHR, GraphQL-operation) and are re-armed automatically.
- **"Auto-capture on reload"** toggle (saved per site) re-arms on every navigation so you never have to click again.
- Attaching to an **already-loaded** page shows an explicit hint ("init-time requests were missed — use Reload & capture") instead of a baffling empty list.

### Request-triggered discovery (find the code that started the chain)

The paused view is now a **reasoning panel**: every frame is classified as *your code* vs *framework* (driven by the ignore/blackbox list — nothing app-specific), framework frames are dimmed, async boundaries render as dividers, and the **entry point** — the outermost user-code frame, e.g. the lifecycle hook that started the chain — is marked with ▶. Arm an XHR or GraphQL-operation breakpoint on an init-time request (plus Reload & capture) and the pause shows the whole chain back to your component; any frame is individually breakable ("break here instead"), so the next load pauses directly in your code.

- `Debugger.paused` stacks now include **async parent frames** (they were dropped before), flattened like the M1 initiator stacks.
- **Async stack depth is configurable** (32 / 64 / 128, default 64, persisted) — deep lifecycle→service→RxJS→fetch chains need it; higher values cost page performance.
- **Broken chains fail loudly:** when no frame classifies as your code (zone.js and long RxJS pipelines are the usual culprits), the panel explains why and links the fixes inline — raise async depth, use Break on lifecycle, or ask the active model (clearly-labeled heuristic, only offered when classification fails).

### Break on lifecycle (deterministic fallback)

A **"Break on lifecycle"** panel scans *your own* sources (ignore-list files excluded; original files via source maps, generated text when unmapped) for lifecycle hook occurrences — framework-aware default name lists (Angular/React/Vue), user-editable and saved — and arms ordinary source-line breakpoints on them, including a bulk **"Break on ALL `<hook>`"** option with a one-click "Clear lifecycle breakpoints". Immune to async-chain breakage: it breaks at the definition instead of tracing back from the request.

Interaction-triggered discovery (element handler picking, event breakpoints, AI fallback) is unchanged — this adds the request-triggered path alongside it.

---

# Release 2 — v1.1.0 (2026-07-13)

## GraphQL operation-scoped breakpoints

GraphQL sends every operation to the same endpoint, so the URL-based "Break when this URL fires" paused on **all** operations. GraphQL requests now get **"Break when operation `GetUser` fires"** instead — a breakpoint that pauses only when the selected operation is sent.

- Per-operation break buttons in the GraphQL request detail pane (each operation in a batch is independently targetable; anonymous operations use the derived name; persisted queries use the name or `persisted:<hash>` label).
- Implemented via a main-world fetch/XHR instrumentation hook that inspects outgoing request bodies and triggers a conditional `debugger;` pause — no native CDP support exists for body-conditional XHR breakpoints. Installed both live (`Runtime.evaluate`) and pre-load (`Page.addScriptToEvaluateOnNewDocument`), so a reload guarantees coverage even for clients that captured `fetch` early.
- Pauses land in the existing paused view (resolved stack, scope, stepping, "Explain this pause") with the hook's own wrapper frames trimmed, so the stack starts at the app code that issued the operation. The pause detail names the matched operation(s).
- Armed operations are listed in the Debug tab with a "GraphQL op" badge and remove buttons; the hook is fully disarmed/uninstalled on remove/detach.
- The old URL-substring behavior remains available as a clearly-labeled secondary option, "Break on ALL operations to this endpoint"; non-GraphQL "Break when this URL fires" is unchanged.

**Limitations:** only string request bodies can be matched — FormData/Blob/stream bodies (and raw `application/graphql` text) are skipped. If arming on the live page doesn't catch the operation, reload once (the panel hints at this).

---

# Release 1 — v1.0.0 (2026-07-05)

First release of **AI DevTools Assistant**: an AI-powered Chrome extension that debugs web apps through raw CDP — network initiator tracing, breakpoints in minified code, pause/scope inspection, element picking, screenshots, source reading — with every "explain this" routed to **your own** configured model. No provider is hardcoded.

## Highlights

- **Ask AI about anything you captured.** Network requests, paused call stacks with live variables, picked DOM elements, screenshots, and source snippets all become chat attachments answered by your active model.
- **Break inside the real handler.** Pick a button and the extension finds the developer's actual handler behind React/Angular/Vue event delegation and pauses *inside it* — not in `dispatchEvent` internals.
- **Minified code is not a wall.** Source maps are resolved both directions: initiator stacks and paused frames display as original `file:line`, and breakpoints set on original locations reverse-map onto the shipped bundle.

## Features

### Network initiator tracing
- Live request capture via CDP (`Network.requestWillBeSent` / `responseReceived`) with method, status, type, and headers.
- Full **async-aware initiator stacks** — `await` / `.then()` / `setTimeout` boundaries shown as separators, parser-initiated requests pointed at their HTML line.
- Stacks resolve through source maps (external and inline data-URI maps; cached consumers; graceful raw fallback).
- "Ask AI about this request" pre-fills chat with the request + resolved call chain.

### Debugger
- Line breakpoints from resolved stack frames (**original → generated** reverse mapping), raw minified locations, or any paused-stack frame.
- **XHR/fetch breakpoints** on a URL substring; **event-listener breakpoints** (click/submit/input/keydown/change), one-shot by default.
- **Framework-aware handler breakpoints**: per-origin framework auto-detection (React / Angular / Vue / vanilla, overridable), main-world extraction adapters, bound-function unwrapping, and `[[FunctionLocation]]` shown (source-mapped) before arming.
- Paused view with resolved call stack, lazy scope/variable inspection, step over/into/out, resume, and per-framework **blackbox patterns** so stepping skips framework internals.
- "Explain this pause" sends the pause reason, stack, and local variables to the active model.
- AI-stack fallback for production builds where extraction fails: broad one-shot event break + model-assisted identification of the developer's frame.

### Context sources
- Screenshots: viewport, full page, and element clip — auto-downscaled above ~1500px before reaching the model.
- Element picker (injected only on demand, fully cleaned up after): selector, attributes, curated computed styles, truncated outerHTML.
- Sources view: loaded-script list, pretty-printed minified source, original files from embedded `sourcesContent`, snippet attachment.
- Attachment tray: stack multiple attachments per question, remove before sending.

### Bring-your-own-model
- Model profiles (label, base URL, key, model ID, temperature/max-tokens/headers) over one **OpenAI-compatible** transport — Kimi/Moonshot, OpenAI, OpenRouter, Together, Groq, local Ollama/LM Studio, etc.
- Streaming responses with Stop, per-profile "Test connection", editable system prompt, active-model switching mid-session.
- **Vision as a per-profile capability**: image attachments ride along for multimodal models; text-only models get a clear degradation notice (image omitted, text context still sent) and a one-click switch to a vision profile.

## Security notes

- API keys live in `chrome.storage.local` only — never synced, never logged, masked in the UI.
- `Authorization` / `Cookie` request headers are never included in AI context.
- The content script is inert until the picker is activated and removes all listeners/DOM afterwards.

## Known limitations

- The MV3 service worker is ephemeral: captured requests, breakpoint bindings, and paused state are lost if it's killed while idle.
- Source-map features need reachable maps; third-party bundles without them fall back to raw minified locations.
- Handler extraction is most reliable in dev builds; stripped production builds route to the AI fallback.
- Function-call (handler) breakpoints bind to the function object — page reloads and hot-reloads orphan them; re-pick after reloading.
- One debugger client per tab: native DevTools' Sources debugger can't attach while the extension is.

## Install

1. `npm install && npm run build`
2. `chrome://extensions` → Developer mode → **Load unpacked** → select `dist/`
3. Click the toolbar icon to attach to the active tab, then add a model profile in **Settings**.

Requires Chrome with Manifest V3 support. Uses the `debugger` permission — expect the "extension is debugging this browser" banner while attached.

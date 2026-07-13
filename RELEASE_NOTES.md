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

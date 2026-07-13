# AI DevTools Assistant

An AI-powered Chrome extension for debugging web applications directly in the browser. Capture network requests with full initiator stacks, set breakpoints in minified code (mapped back to your original source), inspect paused scope and variables, pick UI elements, take screenshots, read loaded sources — and ask **your own** configured AI model about any of it.

The tool is **provider-agnostic**: you connect any OpenAI-compatible model (Kimi/Moonshot, OpenAI, OpenRouter, Together, Groq, local LM Studio / Ollama, etc.) by adding a model profile. No provider is hardcoded.

---

## Key features

- **Network initiator tracing** — capture live requests via CDP and see the full (async-aware) call chain that triggered each one, resolved to your original source files.
- **Breakpoints in minified code** — set a breakpoint on an original source location; the tool reverse-maps it through source maps to the shipped bundle. Inspect the paused call stack, scope, and variables.
- **Framework-aware handler breakpoints** — pick a button (or any element) and the tool finds the *real* handler behind React/Angular/Vue event delegation and breaks inside it — not in framework internals.
- **XHR / event breakpoints** — pause when a request matching a URL fires, or on a specific element's handler.
- **GraphQL operation-scoped breakpoints** — GraphQL operations share one endpoint, so URL breakpoints pause on everything; instead, arm "Break when operation `GetUser` fires" and only that operation pauses (main-world fetch/XHR instrumentation with a conditional `debugger;`). Batched and persisted queries supported.
- **Reload & capture** — the panel normally attaches after the page loaded, missing init-time requests; "⟳ Reload & capture" re-arms persisted breakpoints and hooks *before* the app bootstraps, then reloads. Per-site "auto-capture on reload" re-arms on every navigation.
- **Request-triggered discovery** — pause on an init-time request (XHR or GraphQL breakpoint) and the paused view classifies the whole chain — async parents included — dimming framework frames and marking the **entry point**: the outermost frame in *your* code (e.g. the lifecycle hook that started the chain). Break on any frame in the chain.
- **Break on lifecycle** — scan your own sources for lifecycle hooks (`ngOnInit`, `useEffect`, `mounted`, … — editable lists) and arm breakpoints on them directly; deterministic even when async chains break.
- **AI explanations** — send any captured context (request, paused state, element, screenshot, source snippet) to your active model and get a plain-language explanation.
- **Context sources** — screenshots (viewport / full page / element clip), an element picker with computed styles, and a source viewer with pretty-printing.

---

## Architecture

The extension is split across three surfaces. Understanding the split matters because CDP access and framework internals each require a specific one.

| Surface | Responsibility |
|---|---|
| **Background service worker** | Owns the single `chrome.debugger` (CDP) attachment. Issues all CDP commands (network capture, breakpoints, pause/resume, screenshots, source reading). Holds session state (captured requests, breakpoints, paused state). Also home to framework detection and the handler-extraction adapters, which run in the page's main world via `Runtime.evaluate`. |
| **Side panel** (React UI) | All user-facing UI: request list, paused view, chat, settings. Owns source-map resolution (M2) and the AI provider layer (M3). Talks to the worker over a long-lived `chrome.runtime.connect` port. |
| **Content script** | Only for the element picker — injected on demand to highlight/select DOM elements. Framework handler *extraction* does **not** run here (isolated world can't see `__reactProps$` etc.); that runs via `Runtime.evaluate` in the page's main world. |

**Why `chrome.debugger` (not the `chrome.devtools.*` APIs):** the flagship features — breakpoints in minified code, full network initiator stacks, pause/scope inspection — require raw CDP, which only the debugger API exposes. The trade-off is the "extension is debugging this browser" banner and that the native Sources-tab debugger can't be used on the same tab simultaneously.

---

## Tech stack

- React + TypeScript
- Vite + CRXJS (`@crxjs/vite-plugin`)
- Tailwind CSS v4 (via `@tailwindcss/vite`, no config file)
- `source-map` — reverse/forward source-map resolution
- Chrome DevTools Protocol via `chrome.debugger`

---

## Setup

```bash
# install dependencies
npm install

# development build (watch mode)
npm run dev

# production build
npm run build
```

### Load the unpacked extension

1. Run `npm run dev` (or `npm run build`).
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the generated `dist/` folder.
5. Pin the extension and click its icon to open the side panel.

When the panel opens it attaches the debugger to the active tab — you'll see the "extension is debugging this browser" banner, and the panel shows **Attached**.

---

## Configure a model (required before AI features work)

The AI features do nothing until you add at least one model profile.

1. Open the extension's **Settings** view.
2. Click **Add model** and fill in:
   - **Label** — any name, e.g. "OpenAI GPT-5.4 mini".
   - **Base URL** — the API base, e.g. `https://api.openai.com/v1` (do **not** include `/chat/completions`).
   - **API key** — your key. Leave empty for local models that need none.
   - **Model ID** — e.g. `gpt-5.4-mini`, `kimi-k2`, `qwen2.5`.
   - **Supports vision** — leave on for multimodal models; turn off for text-only (screenshots then degrade gracefully).
3. Click **Test connection** to verify.
4. Set it active. The chat and all "Ask AI" actions now route to this model.

Keys are stored in `chrome.storage.local` (never synced, never logged).

---

## Usage

- **Trace a request:** open the panel, load/interact with the page, select a request → view its resolved initiator stack → "Ask AI about this request".
- **Break inside a handler:** Debug tab → "Break on this element's handler" → pick the button. The tool detects the framework (or asks) and breaks inside the real handler on the next click.
- **Break at a source location:** click "⏸ break" on any resolved initiator-stack frame (reverse-mapped through source maps to the shipped bundle), on any paused-stack frame, or add a raw minified location in the Debug tab. Note: the Sources viewer's pretty-printed line numbers do **not** map to breakpoints.
- **Inspect a pause:** when execution pauses, view the resolved stack + scope, step through, and "Explain this pause".
- **Attach context:** screenshots, picked elements, and source snippets all stack into the chat composer's attachment tray before sending.

---

## Project structure

```
src/
├── shared/         # message contract + shared types (worker <-> panel)
│   └── messages.ts
├── background/     # service worker: chrome.debugger / CDP, session state,
│   ├── index.ts    # framework detection + handler-extraction adapters
│   ├── graphql.ts  # GraphQL request detection + operation parsing
│   └── gqlHook.ts  # in-page fetch/XHR hook for operation-scoped breakpoints
├── content/        # element picker (injected on demand via executeScript)
│   └── picker.ts
└── sidepanel/      # React UI
    ├── App.tsx               # view shell, port wiring, attachment flows
    ├── Chat.tsx              # streaming chat + attachment tray
    ├── Debugger.tsx          # breakpoints, paused view / reasoning panel
    ├── LifecyclePanel.tsx    # lifecycle-hook scan + breakpoints
    ├── codeClassifier.ts     # shared "my code" frame classifier
    ├── lifecycleScan.ts      # lifecycle-hook source scanning helpers
    ├── Settings.tsx          # model profiles + system prompt
    ├── SourcesView.tsx       # script list + source viewer (pretty-print)
    ├── sourceMapResolver.ts  # source-map resolution + consumer cache
    ├── modelConfig.ts        # profile storage (chrome.storage.local)
    ├── attachments.ts        # chat attachment types + formatters
    ├── requestContext.ts     # network-request context formatting
    └── providers/            # AI provider abstraction (OpenAI-compatible)
```

---

## Known limitations

- The MV3 service worker is ephemeral and can be killed while idle; in-memory session state (captured requests, breakpoint bindings) may be lost on restart.
- Breakpoints and initiator resolution depend on **source maps** being reachable. Third-party/cross-origin bundles without accessible maps fall back to raw minified locations.
- Framework handler extraction is reliable in dev builds (React best, everywhere); production builds that strip framework debug hooks fall back to broad break-on-click + AI stack identification.
- Handler (function-call) breakpoints bind to the function *object* — a page reload or hot-reload silently orphans them; re-pick after reloads.
- Only one debugger client per tab — the native Sources-tab debugger can't run on the same tab while the extension is attached.
- GraphQL operation breakpoints match **string** request bodies only (FormData/Blob/stream bodies and raw `application/graphql` text are skipped). If a client captured `fetch` before the hook was armed, reload the page once — the pre-load registration then guarantees coverage.
- Request-triggered discovery depends on the **async parent chain** reaching back to your code; `zone.js` (Angular) and long RxJS pipelines can break it. The panel detects this and points at the fixes (higher async stack depth, "Break on lifecycle").
- The lifecycle scan is a line-based identifier search over your sources, not a parser — expect occasional false positives (e.g. a string containing a hook name) alongside real definitions and call sites.

---

## Permissions

- `debugger` — CDP access for all core features (the primary permission; draws extra review scrutiny on the Web Store).
- `sidePanel` — the UI surface.
- `tabs` — resolve the active/attached tab.
- `storage` — persist model profiles and per-origin settings.
- `scripting` — inject the element picker on demand.
- `host_permissions: <all_urls>` — attach to whichever tab the developer is debugging.

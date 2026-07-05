import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "AI DevTools Assistant",
  version: "0.0.1",
  // "scripting" powers the element picker: the picker function is injected
  // on demand via chrome.scripting.executeScript — no always-on content script.
  permissions: ["debugger", "sidePanel", "tabs", "storage", "scripting"],
  host_permissions: ["<all_urls>"],
  // MV3 blocks WebAssembly on extension pages by default; the source-map
  // library's mapping engine is WASM, so the panel needs wasm-unsafe-eval.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  // No default_popup, and no setPanelBehavior({ openPanelOnActionClick }) in the
  // worker — either one would stop chrome.action.onClicked from firing, and the
  // click handler is where attach() must run.
  action: {
    default_title: "AI DevTools Assistant",
  },
});

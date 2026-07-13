// M6 patch: GraphQL operation-scoped breakpoints.
//
// DOMDebugger.setXHRBreakpoint matches on URL substring only, and every
// GraphQL operation goes to the same endpoint — so a URL breakpoint pauses on
// ALL operations. There is no native CDP way to condition an XHR breakpoint on
// the request body. Instead we install a main-world hook that wraps
// window.fetch and XMLHttpRequest.prototype.send, inspects outgoing string
// bodies, and executes a `debugger;` statement only when the body contains an
// armed operation. The extension is attached with Debugger.enable, so the
// statement raises Debugger.paused (reason "other") into the existing M4 pause
// plumbing.
//
// The hook is installed two ways for reliability:
// - Page.addScriptToEvaluateOnNewDocument: runs before page scripts on the
//   next load — catches clients that capture a `fetch` reference early.
// - An immediate Runtime.evaluate of the same source: patches the current page
//   live — works for clients that call window.fetch at request time.

/**
 * The pause helper's function name. The worker recognizes a GraphQL-operation
 * pause by this name on the top frame of Debugger.paused, and reads the
 * matched operation names from the frame's `matched` local.
 */
export const GQL_PAUSE_SENTINEL = "__aiDevtoolsGqlPause";

// String.raw: the regex sources below must reach the page verbatim (\b, \s).
const GQL_HOOK_SOURCE = String.raw`(function () {
  if (window.__aiDevtoolsGqlHook) return; // idempotent: never double-wrap
  var hook = { targets: new Set() };
  window.__aiDevtoolsGqlHook = hook;
  hook.setTargets = function (names) { hook.targets = new Set(names); };

  // Operation-name derivation — KEEP IN SYNC with graphql.ts
  // (NAMED_OPERATION_RE / FIRST_SELECTION_RE / "persisted:<hash8>" naming).
  // This runs in the page main world and cannot import extension code.
  var NAMED_OPERATION_RE = /\b(query|mutation|subscription)\s+([A-Za-z0-9_]+)\s*[({]/i;
  var FIRST_SELECTION_RE = /\{\s*([A-Za-z0-9_]+)/;

  function opNames(bodyStr) {
    try {
      var parsed = JSON.parse(bodyStr);
      var ops = Array.isArray(parsed) ? parsed : [parsed];
      var names = [];
      for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        if (!op || typeof op !== "object") continue;
        var name = op.operationName;
        if (!name && typeof op.query === "string") {
          var m = NAMED_OPERATION_RE.exec(op.query);
          if (m) name = m[2];
          else {
            var f = FIRST_SELECTION_RE.exec(op.query);
            if (f) name = f[1];
          }
        }
        if (!name && op.extensions && op.extensions.persistedQuery &&
            op.extensions.persistedQuery.sha256Hash) {
          name = "persisted:" +
            String(op.extensions.persistedQuery.sha256Hash).slice(0, 8);
        }
        if (name) names.push(name);
      }
      return names;
    } catch (e) {
      // Non-JSON (application/graphql SDL) and unparseable bodies never match.
      return [];
    }
  }

  // Batched requests match if ANY operation in the batch is armed.
  function matchedOps(bodyStr) {
    if (hook.targets.size === 0 || typeof bodyStr !== "string") return [];
    return opNames(bodyStr).filter(function (n) { return hook.targets.has(n); });
  }

  // Named so the worker can recognize this frame in Debugger.paused; the
  // "matched" local is read back via Debugger.evaluateOnCallFrame while paused.
  function __aiDevtoolsGqlPause(matched) {
    hook.lastMatch = matched;
    debugger; // only reached for armed, matching operations
    return matched;
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      // Only string bodies are matchable; FormData/Blob/Request streams are a
      // documented limitation (can't be parsed cheaply and synchronously).
      var body = (init && init.body) || (input && typeof input === "object" && input.body);
      if (typeof body === "string") {
        var matched = matchedOps(body);
        if (matched.length > 0) __aiDevtoolsGqlPause(matched);
      }
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };

  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (typeof body === "string") {
        var matched = matchedOps(body);
        if (matched.length > 0) __aiDevtoolsGqlPause(matched);
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

  hook.uninstall = function () {
    try { window.fetch = origFetch; } catch (e) {}
    try { XMLHttpRequest.prototype.send = origSend; } catch (e) {}
    try { delete window.__aiDevtoolsGqlHook; } catch (e) {}
  };
})();`;

/**
 * Hook source with the armed targets baked in. The trailing setTargets call
 * runs even when the IIFE no-ops (hook already installed), so re-evaluating
 * this on an already-patched page just syncs the target set.
 */
export function buildGqlHookSource(targets: string[]): string {
  return `${GQL_HOOK_SOURCE}\nwindow.__aiDevtoolsGqlHook && window.__aiDevtoolsGqlHook.setTargets(${JSON.stringify(targets)});`;
}

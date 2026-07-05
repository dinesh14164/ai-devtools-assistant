import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

// source-map@0.7 picks its browser vs node code path with a sloppy-mode
// `this === window` check inside lib/read-wasm.js. Vite converts the CJS
// module to strict-mode ESM, where `this` is undefined, so the check fails and
// the node branch (fs/path) gets bundled — which throws at runtime in the
// panel. Replace the module with the browser implementation outright.
const READ_WASM_BROWSER = `
let mappingsWasm = null;
module.exports = function readWasm() {
  if (typeof mappingsWasm === "string") {
    return fetch(mappingsWasm).then((response) => response.arrayBuffer());
  }
  if (mappingsWasm instanceof ArrayBuffer) {
    return Promise.resolve(mappingsWasm);
  }
  throw new Error(
    "You must provide the string URL or ArrayBuffer contents of " +
      "lib/mappings.wasm by calling SourceMapConsumer.initialize({ " +
      "'lib/mappings.wasm': ... }) before using SourceMapConsumer"
  );
};
module.exports.initialize = (input) => {
  mappingsWasm = input;
};
`;

const READ_WASM_ID = /source-map[\\/]lib[\\/]read-wasm\.js$/;

function sourceMapBrowserShim(): Plugin {
  return {
    name: "source-map-read-wasm-browser",
    enforce: "pre",
    transform(_code, id) {
      if (READ_WASM_ID.test(id)) return { code: READ_WASM_BROWSER, map: null };
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest }), sourceMapBrowserShim()],
  optimizeDeps: {
    // Same shim for the dev server's esbuild pre-bundling pass.
    esbuildOptions: {
      plugins: [
        {
          name: "source-map-read-wasm-browser",
          setup(build) {
            build.onLoad({ filter: /read-wasm\.js$/ }, (args) =>
              READ_WASM_ID.test(args.path)
                ? { contents: READ_WASM_BROWSER, loader: "js" }
                : null,
            );
          },
        },
      ],
    },
  },
});

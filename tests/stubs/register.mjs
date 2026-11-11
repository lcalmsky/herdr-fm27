import { registerHooks } from "node:module";
const map = { "gpui-kit": "ui.mjs", "gpui-base": "ui.mjs", herdr: "herdr.mjs" };
registerHooks({
  resolve(specifier, context, next) {
    if (map[specifier]) return { url: new URL(map[specifier], import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
  },
});
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };

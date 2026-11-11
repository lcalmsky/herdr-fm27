// The live data the tests set: globalThis.herdrState = { agents, terminals, panes, spaces }.
const state = () => globalThis.herdrState ?? {};
export const agents = () => state().agents ?? [];
export const terminals = () => state().terminals ?? [];
export const panes = () => state().panes ?? [];
export const spaces = () => state().spaces ?? [];
export const props = () => state().props ?? {};
export const shared = (name) => state().shared?.[name] ?? null;
export const setShared = (name, value) => { const s = state(); s.shared = { ...(s.shared ?? {}), [name]: value }; globalThis.herdrShared?.push([name, value]); return null; };
export const run = (...args) => { globalThis.herdrRuns?.push(args); };
export const exec = async (...args) => {
  globalThis.herdrExec?.push(args);
  return { code: 0, stdout: "", stderr: "" };
};
export const appHome = () => "/tmp";
export const settings = () => state().settings ?? { zoom: 1 };
export const readTextFile = async (path) => globalThis.herdrFiles?.[path] ?? null;
export const writeTextFile = async (path, text) => { if (globalThis.herdrWriteError) throw new Error(globalThis.herdrWriteError); if (globalThis.herdrFiles) globalThis.herdrFiles[path] = text; return null; };
export const nextCommand = () => new Promise(() => {});
export const openOverlay = (spec) => { globalThis.herdrOverlays?.push(spec); return "o1"; };
export const closeOverlay = (id) => { globalThis.herdrClosed?.push(id); return null; };
export const focused = () => state().focused ?? null;
export const knownAgents = async () => state().knownAgents ?? [];
export const theme = () => state().theme ?? {};
export const layout = () => state().layout ?? null;
export const window = () => state().window ?? null;
export const home = () => state().home ?? "/Users/test";
export const setAgentOrder = (list) => { globalThis.herdrAgentOrder = list; return null; };

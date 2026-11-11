// Tests for the fm-live fork: the tab bar's key map, its role split, and the files it ships. Run:
// node --import ./tests/stubs/register.mjs --test tests/live.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Live, { tabsKey, letterOf, windowButtons } from "../mods/fm-live/main.js";

const source = readFileSync(new URL("../mods/fm-live/main.js", import.meta.url), "utf8");
const sourceOf = (name) => readFileSync(new URL(`../mods/fm-live/${name}`, import.meta.url));

const tab = (id, index, over = {}) => ({
  id, index, name: String(index), named: false, active: false, status: null, zoomed: false, panes: 1, ...over,
});
const pane = (over = {}) => ({
  pane: "p1", terminal: "t1", tab: "t1", title: "WEB-930 regression", cwd: "/Users/ana/git/repo",
  branch: "feat/WEB-930", status: "working", focused: true, zoomed: false,
  program: { key: "claude", name: "Claude Code", agent: true, shell: false }, ...over,
});

function renderRole(role, extra = {}) {
  globalThis.herdrState = {
    ...extra,
    props: { role, pane: "p1" },
    home: "/Users/ana",
    spaces: [{ id: "s1", name: "api", active: true, tabs: [
      tab("t1", 1, { active: true, status: "working" }),
      tab("t2", 2, { status: "blocked" }),
    ] }],
    panes: [pane(), pane({ pane: "p2", terminal: "t2", tab: "t2", title: "tb2", status: null, branch: null,
      program: { key: "shell", name: "zsh", agent: false, shell: true } })],
  };
  const view = new Live();
  view.init({}, { focus_handle: () => ({ is_focused: () => false }), timer: { every() {} } });
  view.render();
  return view;
}

test("the tab-bar keys move with a wrap and select only on enter or space", () => {
  assert.deepEqual(tabsKey("right", 0, 2), { at: 1, select: false });
  assert.deepEqual(tabsKey("right", 1, 2), { at: 0, select: false }, "→ wraps to the first tab");
  assert.deepEqual(tabsKey("left", 0, 2), { at: 1, select: false }, "← wraps to the last tab");
  assert.deepEqual(tabsKey("enter", 1, 2), { at: 1, select: true });
  assert.deepEqual(tabsKey("space", 0, 2), { at: 0, select: true });
  assert.equal(tabsKey("right", 0, 0), null);
  assert.equal(tabsKey("down", 0, 2), null);
});

test("the agent square letters Claude, Codex, Gemini, a shell and an unknown program", () => {
  assert.equal(letterOf({ program: { key: "claude", name: "Claude Code" } }), "C");
  assert.equal(letterOf({ program: { key: "codex", name: "Codex" } }), "X");
  assert.equal(letterOf({ program: { key: "gemini", name: "Gemini" } }), "G");
  assert.equal(letterOf({ program: { key: "shell", name: "zsh", shell: true } }), "$");
  assert.equal(letterOf({ program: { key: "nvim", name: "nvim" } }), "N");
  assert.equal(letterOf(null), "$");
});

test("both roles render, and a pane header without its pane falls back to an empty element", () => {
  assert.doesNotThrow(() => renderRole("tabs"));
  assert.doesNotThrow(() => renderRole("pane"));
  globalThis.herdrState = { props: { role: "pane", pane: "missing" }, panes: [] };
  const view = new Live();
  view.init({}, {});
  assert.doesNotThrow(() => view.render());
});

test("the tab role keeps select, reorder, rename, close, wheel, new tab and the panel toggles", () => {
  for (const fragment of [
    'run("tab.select"', 'run("tab.move"', 'run("tab.rename"', 'run("tab.close"',
    'openOverlay({ mod: "new-menu"', '"tab.prev"', '"tab.next"',
    'shared("workspace.panels")', 'run("layout.select"', 'run("layout.show"', 'run("layout.hide"',
  ]) assert.ok(source.includes(fragment), fragment);
  assert.equal(source.includes("fm.notice"), false, "the sub bar owns the notice pill now");
  assert.equal(source.includes("notice-act"), false, "the sub bar owns the notice action now");
});

test("the pane role keeps focus, split, zoom and close on its own icons and adds the branch", () => {
  for (const fragment of ["pane.focus", "pane.split", "pane.zoom", "pane.close", "mods/fm-live/${icon}.svg", "p.branch", "branch.svg"]) {
    assert.ok(source.includes(fragment), fragment);
  }
  assert.equal(source.includes("mods/pane/"), false, "the fork does not load the upstream pane's icons");
});

test("the tabs bar carries the window buttons only where the system draws no title bar", () => {
  assert.deepEqual(windowButtons(), [], "macOS keeps its own title bar");
  try {
    globalThis.herdrState = { window: { platform: "windows", buttons: true, maximized: false } };
    assert.deepEqual(windowButtons().map((b) => [b.id, b.icon, b.command]), [
      ["minimize", "win-min", "window.minimize"],
      ["maximize", "win-max", "window.maximize"],
      ["close-window", "win-close", "window.close"],
    ]);
    globalThis.herdrState.window.maximized = true;
    assert.equal(windowButtons().find((b) => b.id === "maximize").icon, "win-restore", "a maximized window offers Restore");
    globalThis.herdrState.window.platform = "linux";
    assert.deepEqual(windowButtons().map((b) => [b.icon, b.glyph]).slice(0, 2), [[null, "−"], [null, "□"]]);
    assert.equal(windowButtons().at(-1).icon, "close", "the Linux close keeps the FM icon");
    globalThis.herdrState.window.buttons = false;
    assert.deepEqual(windowButtons(), []);
    assert.doesNotThrow(() => renderRole("tabs", { window: { platform: "windows", buttons: true, maximized: false } }));
  } finally {
    globalThis.herdrState = undefined;
  }
});

test("the manifest records the tabs fork, and every file the mod loads ships beside it", () => {
  const manifest = JSON.parse(readFileSync(new URL("../mods/fm-live/mod.json", import.meta.url), "utf8"));
  assert.equal(manifest.title, "FM27 live");
  assert.deepEqual(manifest.cloned_from, { name: "tabs", version: "0.1.12" });
  for (const name of [
    "LICENSE", "close.svg", "split-down.svg", "split-right.svg", "unzoom.svg", "zoom.svg",
    "branch.svg", "files.svg", "diff.svg", "plus.svg",
    "win-min.svg", "win-max.svg", "win-restore.svg", "win-close.svg",
    "fonts/Barlow-Regular.ttf", "fonts/OFL.txt",
  ]) assert.ok(sourceOf(name).length > 0, name);
  assert.equal(sourceOf("tokens.js").toString(), readFileSync(new URL("../shared/tokens.js", import.meta.url), "utf8"),
    "tokens.js is a byte copy of the shared contract");
});

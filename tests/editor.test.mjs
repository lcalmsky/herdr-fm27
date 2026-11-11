// Tests for the fm-editor mod's helpers and its shell launchers. Run:
// node --import ./tests/stubs/register.mjs --test tests/editor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EditorView, { languageOf, isBinary, fileLabel, ownPane } from "../mods/fm-editor/main.js";

const MOD = fileURLToPath(new URL("../mods/fm-editor", import.meta.url));
const HV = join(MOD, "hv"), HV_OPEN = join(MOD, "hv-open");

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "fm-editor-"));
  const app = join(dir, "herdr-app"), open = join(dir, "open");
  const record = join(dir, "herdr-record.txt"), openRecord = join(dir, "open-record.txt");
  writeFileSync(app, [
    "#!/bin/sh", 'printf "%s\\n" "$@" >> "$RECORD"',
    'if [ "$1" = "ls" ]; then',
    `  echo '{"spaces":[{"tabs":[{"terminals":[{"terminal":"t1d6","pane":"pTEST"}]}]}]}'`,
    "  exit 0",
    "fi",
    'exit "${STUB_EXIT:-0}"', "",
  ].join("\n"));
  writeFileSync(open, ["#!/bin/sh", 'printf "%s\\n" "$@" >> "$OPEN_RECORD"', 'exit "${OPEN_EXIT:-0}"', ""].join("\n"));
  chmodSync(app, 0o755);
  chmodSync(open, 0o755);
  return { dir, app, open, record, openRecord };
}

function env(sandbox, extra = {}) {
  return {
    ...process.env, PWD: sandbox.dir, HOME: sandbox.dir, HC_TERMINAL_ID: "",
    HERDR_APP: sandbox.app, RECORD: sandbox.record, OPEN: sandbox.open, OPEN_RECORD: sandbox.openRecord,
    ...extra,
  };
}

test("languageOf maps the Files mod's languages and adds the editor's own", () => {
  assert.equal(languageOf("/a/b/main.py"), "python");
  assert.equal(languageOf("run.sh"), "bash");
  assert.equal(languageOf("x.zsh"), "bash");
  assert.equal(languageOf("conf.yml"), "yaml");
  assert.equal(languageOf("README.md"), "markdown");
  assert.equal(languageOf("notes.markdown"), "markdown");
  assert.equal(languageOf("q.sql"), "sql");
  assert.equal(languageOf("lib.rs"), "rust");
  assert.equal(languageOf("app.ts"), "js");
  assert.equal(languageOf("layout.toml"), "yaml");
  assert.equal(languageOf("A.JSON"), "json");
  assert.equal(languageOf("thing.kt"), "kt");
  assert.equal(languageOf("Makefile"), "");
});

test("isBinary finds a NUL byte", () => {
  assert.equal(isBinary("a\0b"), true);
  assert.equal(isBinary("plain text\n"), false);
  assert.equal(isBinary(""), false);
});

test("fileLabel splits a path and shows the home folder as ~", () => {
  globalThis.herdrState = { home: "/Users/ana" };
  assert.deepEqual(fileLabel("/Users/ana/git/repo/notes.md"), { name: "notes.md", dir: "~/git/repo" });
  assert.deepEqual(fileLabel("/Users/ana/notes.md"), { name: "notes.md", dir: "~" });
  assert.deepEqual(fileLabel("/tmp/a.txt"), { name: "a.txt", dir: "/tmp" });
  assert.deepEqual(fileLabel("/Users/anabel/x.js"), { name: "x.js", dir: "/Users/anabel" });
});

test("hv asks herdr-app to split the focused pane with an absolute file path", () => {
  const s = sandbox();
  writeFileSync(join(s.dir, "note.md"), "hello");
  const result = spawnSync(HV, ["note.md", join(s.dir, "abs.txt")], { cwd: s.dir, env: env(s), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(s.record, "utf8").trim().split("\n");
  assert.deepEqual(calls.slice(0, 2), ["do", "pane.split"]);
  const relative = JSON.parse(calls[2]);
  assert.equal(relative.direction, "right");
  assert.equal(relative.mod, "fm-editor");
  assert.equal(relative.props.file, join(s.dir, "note.md"));
  const absolute = JSON.parse(calls[5]);
  assert.equal(absolute.props.file, join(s.dir, "abs.txt"));
});

test("hv refuses a directory and reports a failing herdr-app", () => {
  const s = sandbox();
  mkdirSync(join(s.dir, "folder"));
  const refused = spawnSync(HV, ["folder"], { cwd: s.dir, env: env(s), encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /is a directory/);
  assert.equal(existsSync(s.record), false);

  const failing = spawnSync(HV, ["note.md"], { cwd: s.dir, env: env(s, { STUB_EXIT: "1" }), encoding: "utf8" });
  assert.notEqual(failing.status, 0);
});

test("hv-open opens the editor pane when hv succeeds", () => {
  const s = sandbox();
  const state = join(s.dir, "state");
  mkdirSync(join(state, "herdr-tower"), { recursive: true });
  const file = join(s.dir, "a.ts");
  writeFileSync(file, "x");
  const result = spawnSync(HV_OPEN, [file], { env: env(s, { XDG_STATE_HOME: state }), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(s.openRecord), false);
  assert.match(readFileSync(join(state, "herdr-tower", "open.log"), "utf8"), /\teditor\n$/);
});

test("hv-open falls back to the recorded app, then to the text editor, and logs each route", () => {
  const s = sandbox();
  const state = join(s.dir, "state"), tower = join(state, "herdr-tower");
  mkdirSync(tower, { recursive: true });
  writeFileSync(join(tower, "open-previous.tsv"), "md\t/Applications/TextEdit.app\n");
  const md = join(s.dir, "note.md"), py = join(s.dir, "run.py");
  writeFileSync(md, "x");
  writeFileSync(py, "y");
  const result = spawnSync(HV_OPEN, [md, py], { env: env(s, { XDG_STATE_HOME: state, STUB_EXIT: "1" }), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(s.openRecord, "utf8").trim().split("\n");
  assert.deepEqual(calls.slice(0, 3), ["-a", "/Applications/TextEdit.app", md]);
  assert.deepEqual(calls.slice(3), ["-t", py]);
  const log = readFileSync(join(tower, "open.log"), "utf8").trim().split("\n");
  assert.equal(log.length, 2);
  assert.ok(log[0].includes(md) && log[0].includes("previous:/Applications/TextEdit.app"), log[0]);
  assert.ok(log[1].includes(py) && log[1].endsWith("\ttext"), log[1]);
});

const editorPane = { pane: "p2", mod: "fm-editor", tab: "t1" };

test("ownPane takes the focused editor pane only when its tab has another pane", () => {
  const shell = { pane: "p1", terminal: "t1a", tab: "t1" };
  assert.equal(ownPane([shell, editorPane], { pane: "p2" }), "p2");
  assert.equal(ownPane([shell, editorPane], { pane: "p1" }), null, "a terminal pane is never closed");
  assert.equal(ownPane([{ ...editorPane, tab: "t2" }], { pane: "p2" }), null, "an editor alone in its tab stays");
  assert.equal(ownPane([shell, editorPane], null), null);
});

const tabMove = ["tab.new", { name: "notes.md", mod: "fm-editor", props: { file: "/repo/notes.md", tab: true } }];

async function openAsTab({ dirty, typedDuringSave = false, writeError = null }) {
  globalThis.herdrState = { panes: [{ pane: "p1", terminal: "t1a", tab: "t1" }, editorPane], focused: { pane: "p2" } };
  globalThis.herdrRuns = [];
  globalThis.herdrFiles = {};
  globalThis.herdrWriteError = writeError;
  try {
    const view = new EditorView();
    let text = "saved text";
    view.file = "/repo/notes.md";
    view.original = "old text";
    view.dirty = dirty;
    view.editor = { value: () => text };
    const tasks = [];
    const cx = { spawn: (fn) => tasks.push(fn({ notify() {} })), notify() {} };
    const write = globalThis.herdrFiles;
    if (typedDuringSave) Object.defineProperty(globalThis, "herdrFiles", { configurable: true, get: () => { text = "typed later"; return write; } });
    view.toTab(cx);
    await Promise.all(tasks);
    return { runs: globalThis.herdrRuns, view, files: write };
  } finally {
    delete globalThis.herdrFiles;
    delete globalThis.herdrState;
    delete globalThis.herdrWriteError;
    globalThis.herdrRuns = undefined;
  }
}

test("Open as tab on a clean buffer opens the file in a new tab marked as one, then closes the editor pane", async () => {
  const { runs } = await openAsTab({ dirty: false });
  assert.deepEqual(runs, [tabMove, ["pane.close", { pane: "p2" }]]);
});

test("Open as tab saves unsaved edits first and moves only after the save", async () => {
  const { runs, files } = await openAsTab({ dirty: true });
  assert.equal(files["/repo/notes.md"], "saved text");
  assert.deepEqual(runs, [tabMove, ["pane.close", { pane: "p2" }]]);
});

test("Open as tab stays put when the save is refused", async () => {
  const { runs, view } = await openAsTab({ dirty: true, writeError: "The file changed outside Herdr. Reload before saving" });
  assert.deepEqual(runs, []);
  assert.equal(view.stale, "File changed on disk");
});

test("Open as tab stays put when text was typed while saving", async () => {
  const { runs, view } = await openAsTab({ dirty: true, typedDuringSave: true });
  assert.deepEqual(runs, []);
  assert.equal(view.dirty, true);
});

test("an editor opened as a tab hides the Open as tab button", () => {
  const source = readFileSync(new URL("../mods/fm-editor/main.js", import.meta.url), "utf8");
  assert.match(source, /this\.inTab = spec\.tab === true/);
  assert.match(source, /Boolean\(this\.file\) && !this\.inTab, \(el\) => el\.child\(div\(\)\.id\("editor-to-tab"\)/);
});

function hvSplit(extraEnv) {
  const s = sandbox();
  writeFileSync(join(s.dir, "note.md"), "hello");
  const result = spawnSync(HV, ["note.md"], { cwd: s.dir, env: env(s, extraEnv), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(s.record, "utf8").trim().split("\n");
  return { calls, split: JSON.parse(calls[calls.length - 1]) };
}

test("hv splits the pane of its own terminal and omits pane when it cannot tell", () => {
  const own = hvSplit({ HC_TERMINAL_ID: "t1d6" });
  assert.deepEqual(own.calls.slice(0, 2), ["ls", "do"]);
  assert.equal(own.split.pane, "pTEST");
  assert.equal(own.split.direction, "right");
  assert.equal(own.split.mod, "fm-editor");

  const unknown = hvSplit({ HC_TERMINAL_ID: "tZZZ" });
  assert.deepEqual(unknown.calls.slice(0, 2), ["ls", "do"]);
  assert.equal("pane" in unknown.split, false);

  const launched = hvSplit({});
  assert.deepEqual(launched.calls.slice(0, 2), ["do", "pane.split"]);
  assert.equal("pane" in launched.split, false);
});

test("the Herdr FM27 Open applet hands files to the fm-editor mod", () => {
  const build = readFileSync(new URL("../tools/herdr-open/build.sh", import.meta.url), "utf8");
  const applescript = readFileSync(new URL("../tools/herdr-open/open.applescript", import.meta.url), "utf8");
  for (const name of ["build.sh", "open.applescript", "set-default.swift"]) {
    assert.ok(existsSync(new URL(`../tools/herdr-open/${name}`, import.meta.url)), name);
  }
  assert.match(build, /APP_NAME="Herdr FM27 Open"/);
  assert.match(build, /BUNDLE_ID="dev\.herdr\.fm27-open"/);
  assert.match(build, /\$HOME\/\.config\/herdr-app\/mods\/fm-editor\/hv-open/);
  assert.match(applescript, /mods\/fm-editor\/hv-open/);
  assert.doesNotMatch(build, /chiikawa/);
  assert.doesNotMatch(applescript, /chiikawa/);
});

test("the editor is restyled on the FM tokens and carries the same shared token copy", () => {
  const source = readFileSync(new URL("../mods/fm-editor/main.js", import.meta.url), "utf8");
  assert.ok(source.includes('from "./tokens.js"'));
  assert.ok(source.includes("font_family: FONT.mono"), "the editor body is mono");
  assert.ok(source.includes("font_family(FONT.display)"), "the head is condensed");
  assert.equal(
    readFileSync(new URL("../mods/fm-editor/tokens.js", import.meta.url), "utf8"),
    readFileSync(new URL("../shared/tokens.js", import.meta.url), "utf8"),
    "tokens.js is a byte copy of the shared contract",
  );
});

// The install path: merging the layout's keys into a person's keys.json and copying the
// layout, theme and mods into a Herdr home. Every run is sandboxed in a temp folder.
// Run: node --import ./tests/stubs/register.mjs --test tests/tools.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MERGE = join(ROOT, "tools/merge-keys.py");
const INSTALL = join(ROOT, "tools/install.sh");
const SOURCE = join(ROOT, "keys/fm27.json");
const MODS = ["fm-chrome", "fm-squad", "fm-staff", "fm-club", "fm-live", "fm-editor"];

const box = () => mkdtempSync(join(tmpdir(), "fm27-tools-"));
const merge = (target, source = SOURCE) => spawnSync("python3", ["-I", MERGE, target, source], { encoding: "utf8" });
const section = (file) => JSON.parse(readFileSync(file, "utf8"))["layout:fm27"];

test("merge-keys keeps every other section and adds the layout's own", () => {
  const dir = box();
  try {
    const target = join(dir, "keys.json");
    const before = {
      "layout:other": { "cmd-k": "other.open", "cmd-shift-k": "other.close" },
      global: { "cmd-t": "app.thing" },
    };
    writeFileSync(target, `${JSON.stringify(before, null, 2)}\n`);
    const run = merge(target);
    assert.equal(run.status, 0, run.stderr);
    const after = JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(after["layout:other"], before["layout:other"]);
    assert.deepEqual(after.global, before.global);
    assert.deepEqual(after["layout:fm27"], section(SOURCE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge-keys leaves a backup of the original keys.json beside it", () => {
  const dir = box();
  try {
    const target = join(dir, "keys.json");
    const original = `${JSON.stringify({ global: { "cmd-x": "app.x" } }, null, 2)}\n`;
    writeFileSync(target, original);
    const run = merge(target);
    assert.equal(run.status, 0, run.stderr);
    const backups = readdirSync(dir).filter((name) => /^keys\.json\.bak-fm27-\d+$/.test(name));
    assert.equal(backups.length, 1, "one backup, named with the timestamp");
    assert.equal(readFileSync(join(dir, backups[0]), "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge-keys fails on an invalid keys.json and leaves its bytes alone", () => {
  const dir = box();
  try {
    const target = join(dir, "keys.json");
    const broken = "{not json";
    writeFileSync(target, broken);
    const run = merge(target);
    assert.notEqual(run.status, 0, "the merge does not pass for a file it cannot read");
    assert.equal(readFileSync(target, "utf8"), broken);
    assert.deepEqual(readdirSync(dir), ["keys.json"], "no backup is written for a file it never read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge-keys writes a fresh keys.json when none exists, with no backup", () => {
  const dir = box();
  try {
    const target = join(dir, "keys.json");
    const run = merge(target);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), JSON.parse(readFileSync(SOURCE, "utf8")));
    assert.deepEqual(readdirSync(dir), ["keys.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge-keys does not create the keys folder when it is missing", () => {
  const dir = box();
  try {
    const run = merge(join(dir, "absent", "keys.json"));
    assert.notEqual(run.status, 0);
    assert.equal(existsSync(join(dir, "absent")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install.sh copies every mod with the shared tokens, the layout, theme and keys, then checks each mod", () => {
  const dir = box();
  try {
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const log = join(dir, "check.log");
    const stub = join(bin, "herdr-app");
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
    chmodSync(stub, 0o755);
    const env = { ...process.env, HERDR_APP_HOME: home, PATH: `${bin}:${process.env.PATH}` };
    execFileSync("sh", [INSTALL], { env, encoding: "utf8" });

    const tokens = readFileSync(join(ROOT, "shared/tokens.js"));
    for (const mod of MODS) {
      const copy = join(home, "mods", mod, "tokens.js");
      assert.ok(existsSync(copy), `${mod}/tokens.js was copied`);
      assert.deepEqual(readFileSync(copy), tokens, `${mod}/tokens.js is the shared file byte for byte`);
    }
    for (const file of ["fm-staff/cca", "fm-staff/usage-tap.sh", "fm-editor/hv", "fm-editor/hv-open", "fm-squad/scan.sh"]) {
      assert.ok(statSync(join(home, "mods", file)).mode & 0o111, `${file} is executable`);
    }
    for (const file of ["layouts/fm27.json", "layouts/fm27.png", "themes/fm27.json"]) {
      assert.deepEqual(readFileSync(join(home, file)), readFileSync(join(ROOT, file)), `${file} was copied byte for byte`);
    }
    const preview = JSON.parse(readFileSync(join(home, "layouts/fm27.json"), "utf8")).preview;
    assert.ok(existsSync(join(home, preview)), `the layout's preview ${preview} exists in the Herdr home`);
    assert.deepEqual(section(join(home, "keys.json")), section(SOURCE));
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), MODS.map((mod) => `check ${join(home, "mods", mod)}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The install path: merging the layout's keys into a person's keys.json and copying the
// layout, theme and mods into a Herdr home. Every run is sandboxed in a temp folder.
// Run: node --import ./tests/stubs/register.mjs --test tests/tools.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MERGE = join(ROOT, "tools/merge-keys.py");
const INSTALL = join(ROOT, "tools/install.sh");
const SOURCE = join(ROOT, "keys/fm27.json");
const MODS = ["fm-chrome", "fm-squad", "fm-staff", "fm-club", "fm-live", "fm-editor"];
const SHARED = process.env.HERDR_SHARED || join(ROOT, "vendor", "herdr-shared");

const box = () => mkdtempSync(join(tmpdir(), "fm27-tools-"));
const merge = (target, source = SOURCE) => spawnSync("python3", ["-I", MERGE, target, source, "--backup-tag", "fm27"], { encoding: "utf8" });
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

test("merge-keys creates a missing keys folder when it has keys to add", () => {
  const dir = box();
  try {
    const target = join(dir, "absent", "keys.json");
    const run = merge(target);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(section(target), section(SOURCE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge-keys keeps a binding the person already has and adds the rest of the layout", () => {
  const dir = box();
  try {
    const target = join(dir, "keys.json");
    writeFileSync(target, `${JSON.stringify({ "layout:fm27": { "ctrl-alt-p": "fm-chrome.mine" } }, null, 2)}\n`);
    const run = merge(target);
    assert.equal(run.status, 0, run.stderr);
    const after = section(target);
    assert.equal(after["ctrl-alt-p"], "fm-chrome.mine", "the person's own binding is kept");
    assert.equal(after["cmd-0"], section(SOURCE)["cmd-0"], "the layout's other keys are added");
    assert.match(run.stdout, /kept ctrl-alt-p/);
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

const LINKED = {
  "fm-staff": ["cca", "usage-tap.sh", "usage-api.mjs", "codex-usage.mjs", "models.mjs"],
  "fm-squad": ["scan.sh"],
  "fm-editor": ["hv", "hv-open"],
};

test("a second install writes real files instead of writing through the shared links", {
  skip: existsSync(join(SHARED, "tools/install.sh")) ? false : `herdr-shared is not checked out at ${SHARED}; run git submodule update --init`,
}, () => {
  const dir = box();
  try {
    const home = join(dir, "home");
    const sharedHome = join(dir, "herdr-shared");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const stub = join(bin, "herdr-app");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    chmodSync(stub, 0o755);

    execFileSync("sh", [join(SHARED, "tools/install.sh")], {
      env: { ...process.env, HERDR_SHARED_HOME: sharedHome },
      stdio: "pipe",
    });

    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HERDR_APP_HOME: home,
      HERDR_SHARED_HOME: sharedHome,
      HERDR_SHARED: SHARED,
    };
    const install = () => execFileSync("sh", [INSTALL], { env, stdio: "pipe" });
    const assertLinked = (when) => {
      for (const [mod, names] of Object.entries(LINKED)) {
        for (const name of names) {
          const installed = join(home, "mods", mod, name);
          assert.ok(lstatSync(installed).isSymbolicLink(), `${mod}/${name} is a link ${when}`);
          assert.equal(readlinkSync(installed), join(sharedHome, name), `${mod}/${name} points at the shared home ${when}`);
        }
      }
    };

    install();
    assertLinked("after the first install");

    // The marker stands in for the shared home drifting from this repo's vendored copy: a copy
    // that wrote through the link would replace it.
    const marker = "#!/bin/sh\n# marker: a reinstall must not write through the link\n";
    const marked = join(sharedHome, "cca");
    writeFileSync(marked, marker);

    install();
    assertLinked("after the second install");
    assert.equal(readFileSync(marked, "utf8"), marker, "the second install wrote through the link into the shared home");
    for (const names of Object.values(LINKED)) {
      for (const name of names) {
        if (name === "cca") continue;
        assert.deepEqual(readFileSync(join(sharedHome, name)), readFileSync(join(SHARED, "bin", name)),
          `the shared home's ${name} still matches herdr-shared after the second install`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the layout leaves the terminal font size to settings.json, which the ⌘= / ⌘- / ⌘0 keys rewrite", () => {
  // Herdr: layout values override settings.json, so a font_size here would make those keys do nothing.
  const layout = JSON.parse(readFileSync(join(ROOT, "layouts/fm27.json"), "utf8"));
  assert.equal("font_size" in layout, false);
});

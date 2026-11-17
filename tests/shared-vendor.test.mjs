// The vendored copies come from herdr-shared: editing one here would drift from the other themes.
// The check is skipped when herdr-shared is not checked out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHARED = process.env.HERDR_SHARED || join(homedir(), "git-repo", "herdr-shared");

const GROUPS = [
  ["mods/fm-staff", "bin", ["cca", "usage-tap.sh", "usage-api.mjs", "codex-usage.mjs", "models.mjs"]],
  ["mods/fm-squad", "bin", ["scan.sh"]],
  ["mods/fm-editor", "bin", ["hv", "hv-open"]],
  ["tools", "tools", ["merge-keys.py"]],
  ["tools/herdr-open", "tools/herdr-open", ["build.sh", "open.applescript", "set-default.swift"]],
];

test("every vendored file matches its herdr-shared source and keeps the exec bit", {
  skip: !existsSync(SHARED) && `${SHARED} is not checked out; skipping the vendor drift check`,
}, () => {
  for (const [target, source, files] of GROUPS) {
    for (const name of files) {
      const vendored = join(ROOT, target, name);
      const origin = join(SHARED, source, name);
      assert.ok(existsSync(origin), `${origin} exists`);
      assert.deepEqual(readFileSync(vendored), readFileSync(origin),
        `${target}/${name} differs from ${origin}; run herdr-shared/tools/vendor.sh`);
      assert.equal(Boolean(statSync(vendored).mode & 0o111), Boolean(statSync(origin).mode & 0o111),
        `${target}/${name} has ${origin}'s exec bit`);
    }
  }
});

// The vendored copies come from herdr-shared: editing one here would drift from the other themes.
// The check is skipped when the submodule is not initialized.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHARED = process.env.HERDR_SHARED || join(ROOT, "vendor", "herdr-shared");
const CHECK = join(SHARED, "tools", "check-vendor.sh");

test("every vendored file matches herdr-shared", {
  skip: existsSync(CHECK) ? false : `herdr-shared is not checked out at ${SHARED}; run git submodule update --init`,
}, () => {
  const run = spawnSync("sh", [CHECK, ROOT], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});

// Every mod must carry a byte-identical copy of shared/tokens.js, and the layout must wire every mod and screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { SCREENS, SCREEN_STACK } from "../shared/tokens.js";

const MODS = ["fm-chrome", "fm-squad", "fm-staff", "fm-club", "fm-live", "fm-editor"];
const root = new URL("../", import.meta.url);
const shared = readFileSync(new URL("shared/tokens.js", root), "utf8");

for (const mod of MODS) {
  test(`${mod} tokens.js matches shared/tokens.js`, () => {
    const p = new URL(`mods/${mod}/tokens.js`, root);
    assert.ok(existsSync(p), `mods/${mod}/tokens.js missing`);
    assert.equal(readFileSync(p, "utf8"), shared);
  });
}

test("layout stack holds one child per screen and every mod is referenced", () => {
  const layout = readFileSync(new URL("layouts/fm27.json", root), "utf8");
  const tree = JSON.parse(layout);
  const find = (n) => (n.id === SCREEN_STACK ? n : (n.children || []).map(find).find(Boolean));
  const stack = find(tree);
  assert.equal(stack.type, "stack");
  assert.deepEqual(stack.children.map((c) => c.id), SCREENS.map((s) => s.id));
  for (const mod of MODS.filter((m) => m !== "fm-editor")) assert.ok(layout.includes(`"${mod}"`), mod);
});

test("keys file only binds commands of mods that exist", () => {
  const keys = JSON.parse(readFileSync(new URL("keys/fm27.json", root), "utf8"))["layout:fm27"];
  for (const action of Object.values(keys)) {
    if (typeof action === "string" && action.includes(".")) {
      const mod = action.split(".")[0];
      if (mod.startsWith("fm-")) assert.ok(MODS.includes(mod), action);
    }
  }
});

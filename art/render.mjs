// Renders art/shots/{squad,inbox,staff,club}.png (1680x1860 at 1.5x) from art/preview.html,
// then preview.png: the four screens side by side in a 2x2 grid (2400 px wide).
// Needs playwright-core and Google Chrome. Run from the repo root:
//   npm i --no-save --prefix /tmp/tower-render playwright-core
//   NODE_PATH=/tmp/tower-render/node_modules node art/render.mjs
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const { chromium } = createRequire(join(process.env.NODE_PATH ?? ".", "x"))("playwright-core");
const root = resolve(import.meta.dirname, "..");
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(join(root, "art/shots"), { recursive: true });

const browser = await chromium.launch({ executablePath: chrome });
const page = await browser.newPage({ viewport: { width: 1680, height: 1860 }, deviceScaleFactor: 1.5 });
await page.goto("file://" + join(root, "art/preview.html"), { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);

const win = await page.$("#win");
const shots = [
  ["squad", join(root, "art/shots/squad.png")],
  ["inbox", join(root, "art/shots/inbox.png")],
  ["staff", join(root, "art/shots/staff.png")],
  ["club", join(root, "art/shots/club.png")],
];
for (const [screen, path] of shots) {
  await page.evaluate((id) => window.setScreen(id), screen);
  await win.screenshot({ path });
}
const grid = await browser.newPage({ viewport: { width: 1200, height: 1328 }, deviceScaleFactor: 2 });
// Each cell keeps the window's top 880 of 1860 px (bars, screen, tab strip): the terminals repeat on every screen.
const cell = (name) => `<div class="c"><img src="data:image/png;base64,${readFileSync(join(root, "art/shots", name + ".png")).toString("base64")}"></div>`;
await grid.setContent(`<style>html,body{margin:0;background:#0b0714}
  #g{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px;width:1200px;box-sizing:border-box}
  .c{aspect-ratio:1680/880;overflow:hidden;border-radius:8px}
  img{width:100%;display:block}</style>
  <div id="g">${["squad", "inbox", "staff", "club"].map(cell).join("")}</div>`, { waitUntil: "load" });
await (await grid.$("#g")).screenshot({ path: join(root, "preview.png") });
await browser.close();
console.log("art/shots/*.png and preview.png written");

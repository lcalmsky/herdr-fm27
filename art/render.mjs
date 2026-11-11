// Renders art/shots/{squad,inbox,staff,club}.png (1680x1860 at 1.5x) from art/preview.html,
// then preview.png: the Squad window's top 1680x1050 (16:10, 2520x1575), the shape herdr.dev's
// gallery shows previews in (960x600 cards), so the table stays readable there.
// Needs playwright-core and Google Chrome. Run from the repo root:
//   npm i --no-save --prefix /tmp/tower-render playwright-core
//   NODE_PATH=/tmp/tower-render/node_modules node art/render.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
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
await page.evaluate(() => window.setScreen("squad"));
const box = await win.boundingBox();
await page.screenshot({ path: join(root, "preview.png"), clip: { x: box.x, y: box.y, width: 1680, height: 1050 } });
await browser.close();
console.log("art/shots/*.png and preview.png written");

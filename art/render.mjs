// Renders preview.png (Squad at 1680x1860, 1.5x) and art/shots/{inbox,staff,club}.png from art/preview.html.
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
  ["squad", join(root, "preview.png")],
  ["inbox", join(root, "art/shots/inbox.png")],
  ["staff", join(root, "art/shots/staff.png")],
  ["club", join(root, "art/shots/club.png")],
];
for (const [screen, path] of shots) {
  await page.evaluate((id) => window.setScreen(id), screen);
  await win.screenshot({ path });
}
await browser.close();
console.log("preview.png and art/shots/*.png written");

// Renders docs/social-preview.png (1280x640, GitHub's social preview size) from the app icon and
// docs/screenshot.png. Run with `npm run banner` after either changes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(path.join(root, file)).toString("base64")}`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1280px; height: 640px; overflow: hidden; display: flex; align-items: center; gap: 44px; padding: 0 0 0 72px;
    font-family: "Segoe UI Variable Display", "Segoe UI", sans-serif; color: #e8eaee;
    background: radial-gradient(circle at 85% 20%, #1d3160 0%, transparent 55%), linear-gradient(135deg, #0c0f16 0%, #141a2a 60%, #1a2544 100%);
  }
  .text { width: 470px; flex-shrink: 0; }
  .brand { display: flex; align-items: center; gap: 20px; margin-bottom: 30px; }
  .brand img { width: 84px; height: 84px; }
  h1 { font-size: 52px; font-weight: 700; line-height: 1.05; letter-spacing: -0.5px; }
  .tagline { font-size: 27px; line-height: 1.35; color: #c3c9d4; margin-bottom: 28px; }
  .platforms { font-size: 21px; font-weight: 600; color: #7ea4ff; margin-bottom: 14px; }
  .platforms span { color: #4a5670; margin: 0 8px; }
  .foot { font-size: 18px; color: #7b8494; }
  .shot { flex-shrink: 0; width: 720px; border-radius: 12px; overflow: hidden; border: 1px solid #2c3444;
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.04); }
  .shot img { display: block; width: 100%; }
</style></head><body>
  <div class="text">
    <div class="brand"><img src="${dataUrl("editor/assets/icon.png")}"><h1>GTA V Map<br>Agent</h1></div>
    <div class="tagline">Describe a scene. An AI agent builds it in the real GTA V world.</div>
    <div class="platforms">FiveM<span>·</span>alt:V<span>·</span>RAGE:MP<span>·</span>Menyoo</div>
    <div class="foot">Free &amp; open source · Windows · Claude</div>
  </div>
  <div class="shot"><img src="${dataUrl("docs/screenshot.png")}"></div>
</body></html>`;

app.whenReady().then(async () => {
  // Offscreen rendering hands over every painted frame; the last one after the images decoded is the banner.
  const win = new BrowserWindow({ width: 1280, height: 640, show: false, useContentSize: true, webPreferences: { offscreen: true } });
  let frame = null;
  win.webContents.on("paint", (_event, _dirty, image) => (frame = image));
  // A file, not a data: URL: with the screenshot inlined the page is too long for a URL.
  const page = path.join(app.getPath("temp"), "gtav-mapagent-banner.html");
  fs.writeFileSync(page, html);
  await win.loadFile(page);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  win.webContents.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!frame) throw new Error("Nothing was painted");
  const out = path.join(root, "docs", "social-preview.png");
  fs.writeFileSync(out, frame.resize({ width: 1280, height: 640, quality: "best" }).toPNG());
  console.log(`Wrote ${out}`);
  app.quit();
});

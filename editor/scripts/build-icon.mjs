// Renders assets/icon.svg to assets/icon.png and a multi-size assets/icon.ico. Run with `npm run icon`.
// Chromium rasterizes the SVG at every size separately, so small sizes stay sharp.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const PNG_SIZE = 512;

// An .ico whose entries are PNGs (supported since Windows Vista).
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry); // 0 means 256
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4); // colour planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(assetsDir, "icon.svg"), "utf8");
  const win = new BrowserWindow({ show: false });
  await win.loadURL("data:text/html,<!doctype html><body></body>");
  const dataUrls = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)};
    await img.decode();
    return ${JSON.stringify([...ICO_SIZES, PNG_SIZE])}.map((size) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      canvas.getContext("2d").drawImage(img, 0, 0, size, size);
      return canvas.toDataURL("image/png");
    });
  })()`);
  const pngs = dataUrls.map((url, i) => ({
    size: [...ICO_SIZES, PNG_SIZE][i],
    data: Buffer.from(url.slice(url.indexOf(",") + 1), "base64"),
  }));
  fs.writeFileSync(path.join(assetsDir, "icon.png"), pngs.at(-1).data);
  fs.writeFileSync(path.join(assetsDir, "icon.ico"), ico(pngs.slice(0, ICO_SIZES.length)));
  console.log(`Wrote icon.png (${PNG_SIZE}px) and icon.ico (${ICO_SIZES.join(", ")}px) to ${assetsDir}`);
  app.quit();
});

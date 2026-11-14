const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

(async () => {
  const res = process.env.RES;
  const svgPath = process.env.ICON_SVG;
  if (!res) throw new Error("Variabile RES non impostata");
  if (!svgPath || !fs.existsSync(svgPath)) throw new Error("SVG non trovato: " + svgPath);

  const svg = fs.readFileSync(svgPath);
  const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

  for (const [density, size] of Object.entries(sizes)) {
    const dir = path.join(res, "mipmap-" + density);
    fs.mkdirSync(dir, { recursive: true });
    const buf = await sharp(svg).resize(size, size).png().toBuffer();
    fs.writeFileSync(path.join(dir, "ic_launcher.png"), buf);
    fs.writeFileSync(path.join(dir, "ic_launcher_round.png"), buf);
    console.log("icona " + density + " " + size + "x" + size);
  }

  const anydpi = path.join(res, "mipmap-anydpi-v26");
  if (fs.existsSync(anydpi)) {
    fs.rmSync(anydpi, { recursive: true, force: true });
    console.log("rimosso adaptive XML: Android userà i PNG");
  }

  console.log("Icona applicata correttamente.");
})().catch((e) => {
  console.error("ERRORE icona:", e && e.message ? e.message : e);
  process.exit(1);
});

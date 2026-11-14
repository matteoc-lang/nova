const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

const TARGETS = ["ic_launcher", "ic_launcher_round"];
const IMG_EXT = /\.(webp|png|jpg|jpeg)$/i;

(async () => {
  const res = process.env.RES;
  const svgPath = process.env.ICON_SVG;
  if (!res) throw new Error("Variabile RES non impostata");
  if (!fs.existsSync(res)) throw new Error("Cartella res non trovata: " + res);
  if (!svgPath || !fs.existsSync(svgPath)) throw new Error("SVG non trovato: " + svgPath);

  const svg = fs.readFileSync(svgPath);

  // 1. PULIZIA: rimuove ogni ic_launcher / ic_launcher_round esistente,
  //    in qualunque formato, in tutte le cartelle mipmap.
  const mipmapDirs = fs.readdirSync(res).filter((n) => n.startsWith("mipmap-"));
  for (const name of mipmapDirs) {
    const dir = path.join(res, name);
    if (!fs.statSync(dir).isDirectory()) continue;

    if (name === "mipmap-anydpi-v26") {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log("rimossa cartella " + name + " (adaptive XML)");
      continue;
    }

    for (const file of fs.readdirSync(dir)) {
      if (!IMG_EXT.test(file)) continue;
      const base = file.replace(IMG_EXT, "");
      if (TARGETS.includes(base)) {
        fs.rmSync(path.join(dir, file), { force: true });
        console.log("rimosso " + name + "/" + file);
      }
    }
  }

  // 2. SCRITTURA: un solo file per nome risorsa, in PNG.
  const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [density, size] of Object.entries(sizes)) {
    const dir = path.join(res, "mipmap-" + density);
    fs.mkdirSync(dir, { recursive: true });
    const buf = await sharp(svg).resize(size, size).png().toBuffer();
    for (const t of TARGETS) {
      fs.writeFileSync(path.join(dir, t + ".png"), buf);
    }
    console.log("scritta icona " + density + " " + size + "x" + size);
  }

  // 3. VERIFICA: nessun duplicato residuo.
  let duplicates = 0;
  for (const name of fs.readdirSync(res).filter((n) => n.startsWith("mipmap-"))) {
    const dir = path.join(res, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const seen = {};
    for (const file of fs.readdirSync(dir)) {
      if (!IMG_EXT.test(file)) continue;
      const base = file.replace(IMG_EXT, "");
      if (!TARGETS.includes(base)) continue;
      if (seen[base]) {
        console.error("DUPLICATO: " + name + "/" + base);
        duplicates++;
      }
      seen[base] = true;
    }
  }
  if (duplicates > 0) throw new Error("Trovati " + duplicates + " duplicati, build interrotta");

  console.log("Icona applicata correttamente, nessun duplicato.");
})().catch((e) => {
  console.error("ERRORE icona:", e && e.message ? e.message : e);
  process.exit(1);
});

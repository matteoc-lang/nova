import sharp from "sharp";
import { readFileSync, mkdirSync } from "node:fs";

mkdirSync("assets", { recursive: true });

const icon = readFileSync("assets/icon.svg");
const fg = readFileSync("assets/icon-foreground.svg");

await sharp(icon).resize(1024, 1024).png().toFile("assets/icon.png");
await sharp(fg).resize(1024, 1024).png().toFile("assets/adaptive-icon.png");
await sharp(icon).resize(48, 48).png().toFile("assets/favicon.png");
await sharp(fg).resize(512, 512).png().toFile("assets/splash-icon.png");

console.log("Icone generate: icon.png, adaptive-icon.png, favicon.png, splash-icon.png");

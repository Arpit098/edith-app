#!/usr/bin/env node
// Generates the launcher icon layers, the splash image and the in-app logo from Arpit's logo
// (PLAN.md §4.11). Run after changing the source:  node scripts/brand-assets.js
//
//   assets/brand/edith-logo-source.jpg  (838 px, glowing rings on near-black)
//   → assets/android-icon-foreground.png  1024², transparent, rings inside the adaptive safe zone
//   → assets/android-icon-background.png  1024², the source's background ink
//   → assets/android-icon-monochrome.png  1024², white + alpha (Android 13 themed icons)
//   → assets/icon.png                     1024², opaque (legacy icon, web)
//   → assets/splash-icon.png              1024², transparent (expo-splash-screen)
//   → assets/logo.png                     512², transparent (in the app)
//
// The rings are cut out by luminance: alpha rises from just above the background's brightness to
// full at mid-grey, and colours are un-premultiplied against the background ink, so the glow keeps
// soft, clean edges on any dark surface. `expo prebuild` makes the mipmap sizes from these.

const path = require('path');
const Jimp = require('jimp-compact');

const INK = { r: 0x10, g: 0x17, b: 0x1d }; // the source's background (tokens.ts brand.ink)
const LUM_FLOOR = 0.15; // the background's brightest corner is ~0.13
const LUM_FULL = 0.55;
const SAFE_ZONE = 66 / 108; // adaptive icons: what's always visible, whatever the launcher's mask
const LOGO_DIAMETER = 695 / 838; // the rings' share of the source (measured: 695 px of 838)

const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** One source pixel → straight-alpha RGBA of the logo alone. */
function key(r, g, b) {
  const t = Math.min(1, Math.max(0, (lum(r, g, b) - LUM_FLOOR) / (LUM_FULL - LUM_FLOOR)));
  const a = t * t * (3 - 2 * t); // smoothstep: no hard edge at the floor
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const un = (c, bg) => Math.round(Math.min(255, Math.max(0, (c - (1 - a) * bg) / a)));
  return { r: un(r, INK.r), g: un(g, INK.g), b: un(b, INK.b), a: Math.round(a * 255) };
}

function keyed(src) {
  const out = src.clone();
  out.scan(0, 0, out.bitmap.width, out.bitmap.height, function (_x, _y, i) {
    const d = this.bitmap.data;
    const k = key(d[i], d[i + 1], d[i + 2]);
    d[i] = k.r;
    d[i + 1] = k.g;
    d[i + 2] = k.b;
    d[i + 3] = k.a;
  });
  return out;
}

/** The keyed logo scaled so the rings span `diameter` px, centred on a size² canvas. */
function placed(logo, size, diameter, fill) {
  const scale = diameter / (logo.bitmap.width * LOGO_DIAMETER);
  const w = Math.round(logo.bitmap.width * scale);
  const h = Math.round(logo.bitmap.height * scale);
  const canvas = new Jimp(size, size, fill === undefined ? 0x00000000 : fill);
  canvas.composite(logo.clone().resize(w, h, Jimp.RESIZE_BICUBIC), Math.round((size - w) / 2), Math.round((size - h) / 2));
  return canvas;
}

function monochrome(img) {
  const out = img.clone();
  out.scan(0, 0, out.bitmap.width, out.bitmap.height, function (_x, _y, i) {
    const d = this.bitmap.data;
    d[i] = d[i + 1] = d[i + 2] = 255;
  });
  return out;
}

const inkHex = (a = 0xff) => Jimp.rgbaToInt(INK.r, INK.g, INK.b, a);

async function generate(root = path.join(__dirname, '..'), out = path.join(root, 'assets')) {
  const src = await Jimp.read(path.join(root, 'assets', 'brand', 'edith-logo-source.jpg'));
  const logo = keyed(src);
  const ringsInSafeZone = Math.round(1024 * SAFE_ZONE * 0.94); // a little margin inside the safe circle
  const foreground = placed(logo, 1024, ringsInSafeZone);
  const files = {
    'android-icon-foreground.png': foreground,
    'android-icon-background.png': new Jimp(1024, 1024, inkHex()),
    'android-icon-monochrome.png': monochrome(foreground),
    'icon.png': placed(logo, 1024, Math.round(1024 * 0.78), inkHex()),
    'splash-icon.png': placed(logo, 1024, 1000),
    'logo.png': placed(logo, 512, 500),
  };
  for (const [name, img] of Object.entries(files)) await img.writeAsync(path.join(out, name));
  return Object.keys(files);
}

if (require.main === module) {
  generate().then(
    (names) => console.log(`wrote ${names.join(', ')}`),
    (e) => {
      console.error(`brand-assets: ${e.message}`);
      process.exit(1);
    },
  );
}

module.exports = { generate, key, INK };

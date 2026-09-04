/**
 * Genere les pastilles degradees du gabarit, en PNG.
 *
 * PowerPoint sait afficher un degrade, mais pptxgenjs n'expose aucune API pour
 * en declarer un sur une forme. On produit donc l'image exacte : chaque
 * pastille du gabarit a des dimensions FIXES, le rapport largeur/hauteur est
 * donc connu et les coins arrondis ne subissent aucune deformation.
 *
 *   node scripts/build-pills.js
 */

const fs = require("fs");
const path = require("path");
const { encoderPng } = require("./png");

const ASSETS = path.join(__dirname, "..", "public", "assets");
const DPI = 150; // suffisant pour l'impression d'une slide de 20 pouces

// Chaque entree reprend les dimensions reelles utilisees dans lib/render-pptx.
const PASTILLES = [
  { nom: "pill-violet-large", wIn: 8.62, hIn: 0.63, de: "A5199B", vers: "6E0563", angle: 12 },
  { nom: "pill-violet-etroit", wIn: 4.42, hIn: 0.63, de: "A5199B", vers: "6E0563", angle: 12 },
  { nom: "chip-orange", wIn: 2.1, hIn: 0.75, de: "FF8340", vers: "F25706", angle: 40 },
  { nom: "chip-orange2", wIn: 2.1, hIn: 0.75, de: "FFA052", vers: "FB6A03", angle: 40 },
];

const RAYON_PLEIN = 0.5; // pastille : demi-cercles aux extremites

function hex(c) {
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

function dessiner({ wIn, hIn, de, vers, angle }) {
  const W = Math.round(wIn * DPI);
  const H = Math.round(hIn * DPI);
  const r = H * RAYON_PLEIN;
  const [r1, g1, b1] = hex(de);
  const [r2, g2, b2] = hex(vers);

  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // Projection normalisee sur l'axe du degrade.
  const min = Math.min(0, W * dx) + Math.min(0, H * dy);
  const max = Math.max(0, W * dx) + Math.max(0, H * dy);

  const out = Buffer.alloc(W * H * 4);
  const SS = 3; // suréchantillonnage : des bords arrondis nets

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let couvert = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (dansPastille(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, W, H, r)) couvert++;
        }
      }
      const a = couvert / (SS * SS);
      const t = Math.min(1, Math.max(0, ((x * dx + y * dy) - min) / (max - min || 1)));
      const o = (y * W + x) * 4;
      out[o] = Math.round(r1 + (r2 - r1) * t);
      out[o + 1] = Math.round(g1 + (g2 - g1) * t);
      out[o + 2] = Math.round(b1 + (b2 - b1) * t);
      out[o + 3] = Math.round(a * 255);
    }
  }
  return { data: out, W, H };
}

/** Rectangle a coins arrondis, rayon r. */
function dansPastille(x, y, W, H, r) {
  if (x < 0 || y < 0 || x > W || y > H) return false;
  const cx = Math.min(Math.max(x, r), W - r);
  const cy = Math.min(Math.max(y, r), H - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

for (const p of PASTILLES) {
  const { data, W, H } = dessiner(p);
  const cible = path.join(ASSETS, p.nom + ".png");
  fs.writeFileSync(cible, encoderPng(data, W, H));
  console.log("  " + p.nom + ".png".padEnd(8), W + "x" + H, Math.round(fs.statSync(cible).size / 1024) + " ko");
}
console.log("\nPastilles écrites dans public/assets.");

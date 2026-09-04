/**
 * Genere icone.ico (icone du raccourci Bureau).
 *
 * On ecrit le PNG puis le conteneur ICO a la main : cela evite d'ajouter une
 * dependance graphique pour un fichier produit une seule fois. Windows accepte
 * les entrees ICO au format PNG depuis Vista.
 *
 *   node scripts/make-icon.js
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OR = [242, 101, 34];   // orange ADBI
const VI = [139, 26, 126];   // violet ADBI

/** Dessine l'icone : carre arrondi degrade + feuille blanche + trait orange. */
function dessiner(taille) {
  const SS = 4; // suréchantillonnage pour lisser les bords
  const n = taille * SS;
  const acc = new Float32Array(n * n * 4);

  const rayon = n * 0.22;
  const feuilleX = n * 0.28, feuilleY = n * 0.2;
  const feuilleW = n * 0.44, feuilleH = n * 0.6;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      if (!dansCarreArrondi(x, y, n, rayon)) continue;

      // Fond : degrade diagonal orange -> violet.
      const t = (x / n) * 0.55 + (y / n) * 0.45;
      let r = OR[0] + (VI[0] - OR[0]) * t;
      let g = OR[1] + (VI[1] - OR[1]) * t;
      let b = OR[2] + (VI[2] - OR[2]) * t;

      // Feuille blanche.
      if (x >= feuilleX && x <= feuilleX + feuilleW && y >= feuilleY && y <= feuilleY + feuilleH) {
        r = g = b = 255;
        // Lignes de texte grises, et une ligne orange en tete.
        const rel = (y - feuilleY) / feuilleH;
        const bandes = [0.16, 0.34, 0.46, 0.58, 0.7, 0.82];
        for (const bpos of bandes) {
          if (Math.abs(rel - bpos) < 0.035) {
            const largeur = bpos === 0.16 ? 0.62 : bpos === 0.82 ? 0.45 : 0.78;
            if (x < feuilleX + feuilleW * (0.11 + largeur)) {
              if (bpos === 0.16) { r = OR[0]; g = OR[1]; b = OR[2]; }
              else { r = g = b = 178; }
            }
          }
        }
      }

      acc[i] = r; acc[i + 1] = g; acc[i + 2] = b; acc[i + 3] = 255;
    }
  }

  // Reduction : moyenne des SS x SS sous-pixels (anticrenelage).
  const out = Buffer.alloc(taille * taille * 4);
  for (let y = 0; y < taille; y++) {
    for (let x = 0; x < taille; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * n + (x * SS + dx)) * 4;
          const al = acc[i + 3] / 255;
          r += acc[i] * al; g += acc[i + 1] * al; b += acc[i + 2] * al; a += al;
        }
      }
      const k = SS * SS;
      const o = (y * taille + x) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / k) * 255);
    }
  }
  return out;
}

function dansCarreArrondi(x, y, n, r) {
  const m = n * 0.03; // petite marge pour ne pas coller au bord
  const x0 = m, y0 = m, x1 = n - m, y1 = n - m;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

// ------------------------------------------------------------ PNG ---------

function png(rgba, taille) {
  const brut = Buffer.alloc((taille * 4 + 1) * taille);
  for (let y = 0; y < taille; y++) {
    brut[y * (taille * 4 + 1)] = 0; // filtre « none »
    rgba.copy(brut, y * (taille * 4 + 1) + 1, y * taille * 4, (y + 1) * taille * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(taille, 0);
  ihdr.writeUInt32BE(taille, 4);
  ihdr[8] = 8;   // 8 bits par canal
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(brut, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const corps = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corps) >>> 0);
  return Buffer.concat([len, corps, crc]);
}

let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

// ------------------------------------------------------------ ICO ---------

function ico(images) {
  const entetes = Buffer.alloc(6 + images.length * 16);
  entetes.writeUInt16LE(0, 0);
  entetes.writeUInt16LE(1, 2); // type icone
  entetes.writeUInt16LE(images.length, 4);

  let offset = entetes.length;
  images.forEach((img, i) => {
    const p = 6 + i * 16;
    entetes[p] = img.taille >= 256 ? 0 : img.taille;
    entetes[p + 1] = img.taille >= 256 ? 0 : img.taille;
    entetes.writeUInt16LE(1, p + 4);      // plans
    entetes.writeUInt16LE(32, p + 6);     // bits par pixel
    entetes.writeUInt32LE(img.data.length, p + 8);
    entetes.writeUInt32LE(offset, p + 12);
    offset += img.data.length;
  });

  return Buffer.concat([entetes, ...images.map((i) => i.data)]);
}

const images = [16, 32, 48, 64, 128, 256].map((taille) => ({
  taille,
  data: png(dessiner(taille), taille),
}));

const cible = path.join(__dirname, "..", "icone.ico");
fs.writeFileSync(cible, ico(images));
console.log("Icone écrite :", cible, "(" + images.length + " tailles)");

/**
 * Genere icone.ico (icone du raccourci Bureau de la Factory).
 *
 * Meme technique que celle du One pager : le PNG puis le conteneur ICO sont
 * ecrits a la main, ce qui evite une dependance graphique pour un fichier
 * produit une seule fois. Windows accepte les entrees ICO au format PNG.
 *
 * Le motif (grille de 4 tuiles) reprend le bouton « Modules » de la Factory :
 * meme famille visuelle que les autres icones ADBI, glyphe different.
 *
 *   node scripts/make-icon.js
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OR = [242, 101, 34]; // orange ADBI
const VI = [139, 26, 126]; // violet ADBI

/** Dessine l'icone : carre arrondi degrade + grille de 4 tuiles blanches. */
function dessiner(taille) {
  const SS = 4; // suréchantillonnage pour lisser les bords
  const n = taille * SS;
  const acc = new Float32Array(n * n * 4);

  // Grille 2 x 2 centree, avec une gouttiere entre les tuiles.
  const g0 = n * 0.25;
  const g1 = n * 0.75;
  const gouttiere = n * 0.07;
  const cote = (g1 - g0 - gouttiere) / 2;
  const rTuile = cote * 0.26;
  const tuiles = [
    { x: g0, y: g0, opacite: 1 },
    { x: g0 + cote + gouttiere, y: g0, opacite: 1 },
    { x: g0, y: g0 + cote + gouttiere, opacite: 1 },
    // La derniere est plus discrete : evoque un module « a venir ».
    { x: g0 + cote + gouttiere, y: g0 + cote + gouttiere, opacite: 0.55 },
  ];

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const m = n * 0.03; // petite marge pour ne pas coller au bord
      if (!dansRectArrondi(x, y, m, m, n - m, n - m, n * 0.22)) continue;

      // Fond : degrade diagonal orange -> violet.
      const t = (x / n) * 0.55 + (y / n) * 0.45;
      let r = OR[0] + (VI[0] - OR[0]) * t;
      let g = OR[1] + (VI[1] - OR[1]) * t;
      let b = OR[2] + (VI[2] - OR[2]) * t;

      for (const tuile of tuiles) {
        if (dansRectArrondi(x, y, tuile.x, tuile.y, tuile.x + cote, tuile.y + cote, rTuile)) {
          const o = tuile.opacite;
          r = r * (1 - o) + 255 * o;
          g = g * (1 - o) + 255 * o;
          b = b * (1 - o) + 255 * o;
          break;
        }
      }

      acc[i] = r;
      acc[i + 1] = g;
      acc[i + 2] = b;
      acc[i + 3] = 255;
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

function dansRectArrondi(x, y, x0, y0, x1, y1, r) {
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
  ihdr[8] = 8; // 8 bits par canal
  ihdr[9] = 6; // RGBA
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
    entetes.writeUInt16LE(1, p + 4);  // plans
    entetes.writeUInt16LE(32, p + 6); // bits par pixel
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

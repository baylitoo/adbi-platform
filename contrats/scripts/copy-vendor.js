// Copie les builds navigateur des dependances dans public/vendor
// pour que l'application fonctionne entierement hors-ligne.
const fs = require('fs');
const path = require('path');

const vendorDir = path.join(__dirname, '..', 'public', 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });

const files = [
  ['pdfmake/build/pdfmake.min.js', 'pdfmake.min.js'],
  ['pdfmake/build/vfs_fonts.js', 'vfs_fonts.js'],
  ['jszip/dist/jszip.min.js', 'jszip.min.js'],
];

let ok = 0;
for (const [from, to] of files) {
  try {
    const src = require.resolve(from.split('/')[0] + '/package.json');
    const base = path.dirname(src);
    const rel = from.split('/').slice(1).join('/');
    const full = path.join(base, rel);
    fs.copyFileSync(full, path.join(vendorDir, to));
    ok++;
  } catch (e) {
    // tentative chemin direct dans node_modules
    try {
      const full = path.join(__dirname, '..', 'node_modules', from);
      fs.copyFileSync(full, path.join(vendorDir, to));
      ok++;
    } catch (e2) {
      console.warn('[copy-vendor] introuvable :', from);
    }
  }
}
console.log(`[copy-vendor] ${ok}/${files.length} fichiers copies dans public/vendor`);

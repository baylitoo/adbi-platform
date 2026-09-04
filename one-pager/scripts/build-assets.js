/**
 * Rasterise les avatars SVG en PNG (une seule fois, a la main).
 *
 * Pourquoi : PowerPoint n'affiche une image SVG de maniere fiable que si elle
 * est accompagnee d'un repli PNG. Plutot que de produire un .pptx qui s'ouvre
 * avec des cadres vides, on embarque directement des PNG.
 *
 * Le rendu SVG demande un moteur graphique : on emprunte celui du navigateur,
 * via un serveur ephemere. Aucune dependance supplementaire.
 *
 *   node scripts/build-assets.js
 *   -> ouvrir http://localhost:4299 dans un navigateur, attendre « Terminé ».
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ASSETS = path.join(__dirname, "..", "public", "assets");
const PORT = 4299;

// Chaque SVG a sa taille cible. Les avatars sont carres et recadres au centre ;
// les decors gardent leurs proportions d'origine, sans quoi les vagues du
// gabarit seraient deformees.
// Le fond de vagues est volontairement modeste en definition : PowerPoint ne
// mutualise pas les images entre slides, chaque page d'un livret en embarque
// donc une copie. A 62 % de transparence et sur un aplat de courbes fines, la
// difference est invisible, mais 30 slides passent de 36 Mo a moins de 10.
const CIBLES = {
  "fond-vagues.svg": { w: 760, h: 620, carre: false },
  "coin-orange.svg": { w: 700, h: 530, carre: false },
};
const AVATAR = { w: 512, h: 512, carre: true };

const sources = fs
  .readdirSync(ASSETS)
  .filter((f) => /\.svg$/.test(f))
  .map((f) => ({ nom: f, ...(CIBLES[f] || AVATAR) }));

const page = `<!doctype html><meta charset="utf-8"><title>Construction des avatars</title>
<body style="font:14px system-ui;padding:24px">
<h1>Construction des avatars</h1><ul id="log"></ul>
<script>
const sources = ${JSON.stringify(sources)};
const log = (t) => document.getElementById('log').insertAdjacentHTML('beforeend', '<li>' + t + '</li>');

(async () => {
  for (const src of sources) {
    const svg = await (await fetch('/assets/' + src.nom)).text();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const img = new Image();
    await new Promise((ok, ko) => { img.onload = ok; img.onerror = ko; img.src = url; });

    const c = document.createElement('canvas');
    c.width = src.w; c.height = src.h;
    const ctx = c.getContext('2d');
    if (src.carre) {
      // Portrait : on recadre au centre pour obtenir un carre net.
      const cote = Math.min(img.width, img.height) || src.w;
      const k = src.w / cote;
      ctx.drawImage(img, (src.w - img.width * k) / 2, (src.h - img.height * k) / 2, img.width * k, img.height * k);
    } else {
      // Decor : on respecte les proportions d'origine, sur fond transparent.
      ctx.drawImage(img, 0, 0, src.w, src.h);
    }

    const dataUri = c.toDataURL('image/png');
    const r = await fetch('/ecrire?nom=' + encodeURIComponent(src.nom.replace(/\\.svg$/, '.png')), { method: 'POST', body: dataUri });
    log(src.nom + ' → ' + (await r.text()));
  }
  log('<b>Terminé — vous pouvez fermer cet onglet.</b>');
  fetch('/fin');
})().catch(e => log('<b style="color:red">Erreur : ' + e.message + '</b>'));
</script>`;

const serveur = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");

  if (u.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(page);
  }

  if (u.pathname.startsWith("/assets/")) {
    const f = path.join(ASSETS, path.basename(u.pathname));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    return res.end(fs.readFileSync(f));
  }

  if (u.pathname === "/ecrire" && req.method === "POST") {
    let corps = "";
    req.on("data", (c) => (corps += c));
    return req.on("end", () => {
      const nom = path.basename(u.searchParams.get("nom") || "");
      const b64 = String(corps).split(",")[1] || "";
      const buf = Buffer.from(b64, "base64");
      fs.writeFileSync(path.join(ASSETS, nom), buf);
      console.log("  écrit", nom, Math.round(buf.length / 1024) + " ko");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(Math.round(buf.length / 1024) + " ko");
    });
  }

  if (u.pathname === "/fin") {
    res.writeHead(200); res.end("ok");
    console.log("\nTerminé.");
    return setTimeout(() => process.exit(0), 200);
  }

  res.writeHead(404); res.end();
});

serveur.listen(PORT, () => {
  console.log(`\n  ${sources.length} image(s) à convertir : ${sources.map((s) => s.nom).join(", ")}`);
  console.log(`  Ouvrez http://localhost:${PORT} puis attendez « Terminé ».\n`);
});

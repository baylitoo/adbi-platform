#!/usr/bin/env node
/**
 * Migration ponctuelle data/cvs.sqlite -> PostgreSQL (issue #16).
 *
 * Ne touche PAS au sqlite existant (lecture seule) : peut être relancé sans
 * risque, `ON CONFLICT (id) DO UPDATE` dans lib/db.pg.js rend l'insertion
 * idempotente. Vérifie qu'on retrouve bien le même nombre de CV côté
 * PostgreSQL qu'au départ avant de conclure au succès.
 *
 * Usage :
 *   DATABASE_URL=postgresql://... node scripts/migrer-vers-postgres.js
 */

const sqlite = require("../lib/db.js");
const pg = require("../lib/db.pg.js");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL manquante — voir .env.example");
    process.exit(1);
  }

  await sqlite.init();
  const fiches = sqlite.list().map((r) => sqlite.get(r.id));
  console.log(`[migration] ${fiches.length} CV trouvés dans data/cvs.sqlite`);

  await pg.init();
  let migres = 0;
  for (const fiche of fiches) {
    await pg.save(fiche);
    migres += 1;
    process.stdout.write(`\r[migration] ${migres}/${fiches.length}`);
  }
  console.log("");

  const restant = await pg.list();
  if (restant.length !== fiches.length) {
    console.error(
      `[migration] ÉCART : ${fiches.length} CV en source, ${restant.length} en base après migration — ne pas basculer server.js dessus.`
    );
    process.exit(1);
  }

  console.log(`[migration] OK — ${restant.length} CV en PostgreSQL, comptage identique à la source.`);
}

main().catch((e) => {
  console.error("[migration] échec :", e);
  process.exit(1);
});

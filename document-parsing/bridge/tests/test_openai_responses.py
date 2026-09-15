"""Transport OpenAI (#194) : aucun appel réseau, session simulée.

Lancement : python -m unittest discover -s document-parsing/bridge/tests
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

ICI = Path(__file__).resolve().parent
sys.path.insert(0, str(ICI.parent))

import openai_responses as oa  # noqa: E402

DOSSIER_SCHEMAS = ICI.parents[1] / "schemas"
SCHEMAS = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in sorted(DOSSIER_SCHEMAS.glob("*.schema.json"))}


class ConversionSchema(unittest.TestCase):
    def verifier_strict(self, noeud, chemin):
        if noeud["type"] == "object":
            self.assertIs(noeud["additionalProperties"], False, chemin)
            self.assertEqual(sorted(noeud["required"]), sorted(noeud["properties"]), chemin)
            for cle, sous in noeud["properties"].items():
                self.verifier_strict(sous, chemin + "." + cle)
        elif noeud["type"] == "array":
            self.verifier_strict(noeud["items"], chemin + "[]")
        elif isinstance(noeud["type"], list):
            self.assertEqual(noeud["type"], ["string", "null"], chemin)
        else:
            self.assertEqual(noeud["type"], "string", chemin)

    def test_chaque_schema_du_depot_cv_compris(self):
        self.assertEqual(list(SCHEMAS), ["adbi_resume.schema.json", "contract.schema.json", "rib.schema.json", "urssaf.schema.json"])
        for fichier, dynamique in SCHEMAS.items():
            with self.subTest(fichier=fichier):
                converti = oa.schema_openai(dynamique)
                self.assertEqual(converti["name"], "adbi_" + dynamique["document_type"])
                self.verifier_strict(converti["schema"], fichier)
                self.assertEqual(list(converti["schema"]["properties"]), [c["name"] for c in dynamique["fields"]])
                self.assertNotIn('"format"', json.dumps(converti))

    def test_money_date_nombre(self):
        contrat = oa.schema_openai(SCHEMAS["contract.schema.json"])["schema"]["properties"]
        self.assertEqual(contrat["tjm"]["properties"]["amount"], {"type": ["string", "null"], "description": oa.CONSIGNE_MONTANT})
        self.assertEqual(contrat["tjm"]["required"], ["amount", "currency"])
        self.assertEqual(contrat["date_debut"], {"type": ["string", "null"], "description": oa.CONSIGNE_DATE})
        self.assertEqual(contrat["numero_contrat"], {"type": ["string", "null"]})

    def test_schema_invalide_refuse(self):
        for cas in (None, {}, {"document_type": "x", "fields": []},
                    {"document_type": "x", "fields": [{"name": "a", "type": "boolean"}]},
                    {"document_type": "x", "fields": [{"name": "a", "type": "string"}, {"name": "a", "type": "date"}]},
                    {"document_type": "x", "fields": [{"name": "o", "type": "object", "fields": []}]}):
            with self.subTest(cas=cas), self.assertRaises(oa.ErreurSchema):
                oa.schema_openai(cas)

    @unittest.skipUnless(shutil.which("node"), "node absent : parité non vérifiée")
    def test_parite_node(self):
        script = r"""
const oa = require(process.argv[1]);
const schemas = JSON.parse(require("fs").readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(schemas).map(([f, s]) => [f, oa.schemaOpenAI(s)]))));
"""
        sortie = subprocess.run(["node", "-e", script, str(ICI.parent / "openai-responses.js")],
                                input=json.dumps(SCHEMAS), capture_output=True, text=True, encoding="utf-8", check=True)
        self.assertEqual(json.loads(sortie.stdout), {f: oa.schema_openai(s) for f, s in SCHEMAS.items()})


if __name__ == "__main__":
    unittest.main()

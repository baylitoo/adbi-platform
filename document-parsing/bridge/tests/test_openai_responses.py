"""Transport OpenAI (#194) : aucun appel réseau, session simulée.

Lancement : python -m unittest discover -s document-parsing/bridge/tests
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import MagicMock, Mock

import requests

ICI = Path(__file__).resolve().parent
sys.path.insert(0, str(ICI.parent))

import openai_responses as oa  # noqa: E402
from docie_bridge import DocIEBridgeError  # noqa: E402

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
        # Liste NON figée : un schéma ajouté ailleurs (kbis #214, fiscale #215)
        # doit être converti par la boucle, pas faire échouer ce test.
        for attendu in ("adbi_resume.schema.json", "contract.schema.json", "rib.schema.json", "urssaf.schema.json"):
            self.assertIn(attendu, SCHEMAS)
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

    def test_descriptions_kbis_arrivent_dans_la_charge(self):
        """Les descriptions du Kbis atteignent reellement le modele.

        Elles ne servent que sur les profils qui les rendent -- ce transport :
        `_description` les recopie dans properties[...]["description"], et le
        message systeme demande de les suivre. Sans cette mesure, leur valeur
        reposerait sur une LECTURE du code ; un changement de cablage les
        ferait disparaitre en silence, tous les tests restant verts.
        """
        kbis = oa.schema_openai(SCHEMAS["kbis.schema.json"])["schema"]["properties"]
        self.assertEqual(kbis["company_name"], {
            "type": ["string", "null"],
            "description": "Denomination sociale de la societe, sans la forme juridique"})
        self.assertEqual(kbis["activity_code"], {
            "type": ["string", "null"],
            "description": "Code d'activite APE/NAF (4 chiffres et 1 lettre), pas son libelle"})
        # Les huit champs `string` en portent une, aucune vide.
        chaines = [c["name"] for c in SCHEMAS["kbis.schema.json"]["fields"] if c["type"] == "string"]
        self.assertEqual(len(chaines), 8)
        for nom in chaines:
            with self.subTest(champ=nom):
                self.assertTrue((kbis[nom].get("description") or "").strip(), nom)

    def test_kbis_description_propre_et_consigne_de_type(self):
        """Un champ portant les DEUX rend les deux, joints par « — »."""
        kbis = oa.schema_openai(SCHEMAS["kbis.schema.json"])["schema"]["properties"]
        self.assertEqual(kbis["issued_date"], {
            "type": ["string", "null"],
            "description": "Date d'edition/delivrance du Kbis — " + oa.CONSIGNE_DATE})
        # Pourquoi aucune prose n'a ete ajoutee sur les `date` et les `money` :
        # ils recoivent deja leur consigne par TYPE, en ajouter une ferait
        # doublon dans le meme champ.
        self.assertEqual(kbis["registration_date"],
                         {"type": ["string", "null"], "description": oa.CONSIGNE_DATE})
        self.assertNotIn("description", kbis["share_capital"])
        self.assertEqual(kbis["share_capital"]["properties"]["amount"]["description"],
                         oa.CONSIGNE_MONTANT)

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


CLE = "sk-test-secret-1234567890"
ENV = {"OPENAI_API_KEY": CLE}
CONTRAT = SCHEMAS["contract.schema.json"]
EXTRAIT = {f["name"]: ({"amount": "650", "currency": "EUR"} if f["type"] == "money" else None) for f in CONTRAT["fields"]}
EXTRAIT["st_nom"] = "ACME SAS"


def reponse(**corps):
    base = {"id": "resp_abc", "object": "response", "status": "completed", "model": "gpt-6-luna-2026-05-18",
            "output": [{"type": "message", "role": "assistant",
                        "content": [{"type": "output_text", "text": json.dumps(EXTRAIT), "annotations": []}]}],
            "usage": {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30}}
    base.update(corps)
    return base


def session_simulee(corps, statut=200):
    session = Mock()
    response = MagicMock(status_code=statut)
    response.__enter__.return_value = response
    brut = corps if isinstance(corps, (str, bytes)) else json.dumps(corps)
    response.iter_content.return_value = [brut.encode() if isinstance(brut, str) else brut]
    session.post.return_value = response
    return session


def extraire(texte="Contrat", session=None, **options):
    options.setdefault("mode", "rapide")
    options.setdefault("dynamic_schema", CONTRAT)
    options.setdefault("env", ENV)
    return oa.extraire_via_openai(texte, session=session or session_simulee(reponse()), **options)


class Transport(unittest.TestCase):
    def assert_code(self, code, fonction, *args, **kwargs):
        with self.assertRaises(DocIEBridgeError) as leve:
            fonction(*args, **kwargs)
        self.assertEqual(leve.exception.code, code)
        self.assertNotIn(CLE, repr((str(leve.exception), leve.exception.code, leve.exception.status)))
        return leve.exception

    def test_requete_mode_rapide(self):
        session = session_simulee(reponse())
        extraire("Contrat ACME", session=session)
        session.post.assert_called_once()
        appel = session.post.call_args
        self.assertEqual(appel.args[0], "https://api.openai.com/v1/responses")
        self.assertEqual(appel.kwargs["headers"], {"Authorization": "Bearer " + CLE})
        self.assertIs(appel.kwargs["allow_redirects"], False)
        corps = appel.kwargs["json"]
        self.assertIs(corps["store"], False)
        self.assertEqual(corps["model"], "gpt-6-luna")
        self.assertEqual(corps["reasoning"], {"effort": "none"})
        self.assertEqual(corps["text"]["format"], {"type": "json_schema", "name": "adbi_contract", "strict": True,
                                                   "schema": oa.schema_openai(CONTRAT)["schema"]})
        self.assertEqual(corps["input"], [{"role": "user", "content": [{"type": "input_text", "text": "Contrat ACME"}]}])
        self.assertEqual(corps["max_output_tokens"], oa.MAX_OUTPUT_TOKENS)
        self.assertIn("untrusted data", corps["instructions"])

    def test_requete_mode_raisonnement(self):
        session = session_simulee(reponse())
        resultat = extraire(session=session, mode="raisonnement")
        corps = session.post.call_args.kwargs["json"]
        self.assertEqual(corps["model"], "gpt-6-luna")
        self.assertEqual(corps["reasoning"], {"effort": "low"})
        self.assertEqual(resultat["metadata"]["mode"], "raisonnement")

    def test_modeles_defauts_surcharges_et_refus(self):
        self.assertEqual(oa.configuration_openai(ENV, "rapide")["modele"], "gpt-6-luna")
        self.assertEqual(oa.configuration_openai(ENV, "raisonnement")["modele"], "gpt-6-luna")
        session = session_simulee(reponse())
        extraire(session=session, env={**ENV, "OPENAI_MODELE_RAPIDE": " gpt-6-luna "})
        self.assertEqual(session.post.call_args.kwargs["json"]["model"], "gpt-6-luna")
        self.assertEqual(session.post.call_args.kwargs["json"]["reasoning"], {"effort": "none"})
        for mode, variable, valeur in (("rapide", "OPENAI_MODELE_RAPIDE", "gpt-5-nano"),
                                       ("raisonnement", "OPENAI_MODELE_RAISONNEMENT", "gpt-4.1-nano"),
                                       ("raisonnement", "OPENAI_MODELE_RAISONNEMENT", "gpt-5")):
            with self.subTest(variable=variable, valeur=valeur):
                session = session_simulee(reponse())
                erreur = self.assert_code("configuration", extraire, session=session, mode=mode, env={**ENV, variable: valeur})
                self.assertIn(variable, str(erreur))
                self.assertNotIn(valeur, str(erreur))
                session.post.assert_not_called()
        for mode in (None, "gpt-5-nano", ""):
            self.assert_code("input", extraire, mode=mode)

    def test_configuration_et_delai(self):
        for env in ({}, {"OPENAI_API_KEY": "a\nb"}, {**ENV, "OPENAI_BASE_URL": "http://api.example"},
                    {**ENV, "OPENAI_BASE_URL": "https://api.openai.com/v1"}, {**ENV, "OPENAI_TIMEOUT_SECONDS": "0"}):
            with self.subTest(env=env):
                session = session_simulee(reponse())
                self.assert_code("configuration", extraire, session=session, env=env)
                session.post.assert_not_called()
        self.assertEqual(oa.configuration_openai(ENV, "rapide")["timeout"], 360)
        self.assertEqual(oa.configuration_openai({**ENV, "DOCIE_TIMEOUT_SECONDS": "900"}, "rapide")["timeout"], 900)
        self.assertEqual(oa.configuration_openai({**ENV, "DOCIE_TIMEOUT_SECONDS": "900", "OPENAI_TIMEOUT_SECONDS": "120"}, "rapide")["timeout"], 120)

    def test_texte_seulement(self):
        for texte in (b"%PDF-1.7", bytearray(b"\x89PNG"), {"mime": "image/png"}, "", "  \n", "a\x00b", "x" * (oa.MAX_TEXT_BYTES + 1)):
            with self.subTest(texte=str(texte)[:20]):
                session = session_simulee(reponse())
                self.assert_code("input", extraire, texte, session=session)
                session.post.assert_not_called()
        self.assert_code("input", extraire, dynamic_schema=None)

    def test_resultat_normalise(self):
        resultat = extraire()
        meta = dict(resultat["metadata"])
        self.assertIsInstance(meta.pop("elapsed_ms"), int)
        self.assertEqual(resultat["schema_name"], "contract")
        self.assertEqual(resultat["result"], EXTRAIT)
        self.assertEqual(meta, {"request_id": "resp_abc", "fournisseur": "openai", "mode": "rapide",
                                "model": "gpt-6-luna-2026-05-18", "agent": None, "sans_preuve": True,
                                "field_confidence": None, "validation": None,
                                "usage": {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30},
                                "prompt_profile": None, "partiel": [], "blocs_texte": None,
                                "troncature_possible": False, "schema_reported": False})
        for model in ("gpt-4o-2024-08-06", "gpt-4.1-mini-2025-04-14", None):
            self.assert_code("schema", extraire, session=session_simulee(reponse(model=model)))

    def test_reponses_incompletes_refus_et_formes(self):
        texte = lambda t: [{"type": "message", "content": [{"type": "output_text", "text": t}]}]  # noqa: E731
        for corps, code in ((reponse(status="incomplete", incomplete_details={"reason": "max_output_tokens"}), "incomplete"),
                            (reponse(output=[{"type": "message", "content": [{"type": "refusal", "refusal": "I'm sorry"}]}]), "refusal"),
                            (reponse(status="failed", error={"message": CLE}), "upstream"),
                            (reponse(output=[{"type": "reasoning"}]), "response"),
                            (reponse(output=texte("pas du JSON")), "response"),
                            (reponse(output=texte('{"st_nom": "A"}')), "response"),
                            ("[]", "response")):
            with self.subTest(code=code):
                self.assert_code(code, extraire, session=session_simulee(corps))

    def test_erreurs_http_et_cle_jamais_recopiee(self):
        corps_cle = json.dumps({"error": {"message": "Incorrect API key provided: " + CLE, "code": "invalid_api_key"}})
        contexte = json.dumps({"error": {"message": "exceeds the context window " + CLE, "code": "context_length_exceeded"}})
        for statut, corps, code in ((401, corps_cle, "auth"), (403, corps_cle, "auth"), (413, corps_cle, "limits"),
                                    (429, corps_cle, "rate_limit"), (400, contexte, "context"), (400, corps_cle, "upstream"),
                                    (500, corps_cle, "upstream"), (503, corps_cle, "upstream")):
            with self.subTest(statut=statut, code=code):
                erreur = self.assert_code(code, extraire, session=session_simulee(corps, statut))
                self.assertEqual(erreur.status, statut)
        for echec, code in ((requests.Timeout(CLE), "timeout"), (requests.ConnectionError(CLE), "network")):
            session = Mock()
            session.post.side_effect = echec
            self.assert_code(code, extraire, session=session)
        self.assert_code("response", extraire, session=session_simulee("pas du JSON " + CLE))
        reflet = reponse(output=[{"type": "message", "content": [{"type": "output_text", "text": json.dumps({**EXTRAIT, "st_nom": CLE})}]}])
        resultat = extraire(session=session_simulee(reflet))
        self.assertEqual(resultat["result"]["st_nom"], "[REDACTED]")
        self.assertNotIn(CLE, json.dumps(resultat))


if __name__ == "__main__":
    unittest.main()

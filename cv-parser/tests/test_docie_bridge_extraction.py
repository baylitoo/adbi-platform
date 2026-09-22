"""Tests du chemin d'extraction via le bridge DocIE partagé (issue #151).

Aucun appel réseau réel : le transport HTTP du bridge
(document-parsing/bridge/docie_bridge.py) est bouché via une session
`requests` simulée, comme document-parsing/bridge/tests/test_bridge.py le
fait déjà pour le bridge lui-même — cf. politique du dépôt : "Aucun appel
distant DocIE par agent ADBI".
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "document-parsing" / "bridge"))

from docie_client import DocIEError
import docie_bridge_extraction as bridge_extraction

BRIDGE_ENV = {"DOCIE_BASE_URL": "https://docie.example", "DOCIE_API_KEY": "test-secret",
              "DOCIE_AGENT_RESUME": "adbi_agent_1"}

FIXTURE_BODY = {
    "id": "chatcmpl-test", "model": "spark-x2.5-1.7b",
    "choices": [{"finish_reason": "stop", "message": {
        "content": json.dumps({"document_type": "adbi_resume", "name": "Alice Dupont",
                                "title": "Développeuse", "experience": [], "education": [],
                                "skills": [], "languages": [], "projects": [],
                                "certifications": [], "interests": []})}}],
    "usage": {"prompt_tokens": 100, "completion_tokens": 30, "total_tokens": 130},
    "docie_agent": {"agent": "adbi_agent_1", "validation": {"valid": True, "errors": [], "warnings": []}},
}


def _fake_session(chunks):
    session = Mock()
    response = MagicMock(status_code=200)
    response.__enter__.return_value = response
    response.iter_content.return_value = chunks
    session.post.return_value = response
    return session


class DocieExtractionEnabledTests(unittest.TestCase):
    def test_default_is_disabled(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DOCIE_EXTRACTION_ENABLED", None)
            self.assertFalse(bridge_extraction.docie_extraction_enabled())

    def test_flag_check_never_imports_the_bridge_module(self):
        """Flag off must not require docie_bridge.py to even be importable
        (e.g. before the Docker image's additional_contexts copy lands) —
        this is the structural guarantee behind "flag off = unchanged"."""
        sys.modules.pop("docie_bridge", None)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DOCIE_EXTRACTION_ENABLED", None)
            bridge_extraction.docie_extraction_enabled()
        self.assertNotIn("docie_bridge", sys.modules)

    def test_recognized_truthy_values(self):
        for value in ("1", "true", "TRUE", "on", "On"):
            with patch.dict(os.environ, {"DOCIE_EXTRACTION_ENABLED": value}):
                self.assertTrue(bridge_extraction.docie_extraction_enabled())

    def test_other_values_stay_disabled(self):
        for value in ("0", "false", "off", "yes", ""):
            with patch.dict(os.environ, {"DOCIE_EXTRACTION_ENABLED": value}):
                self.assertFalse(bridge_extraction.docie_extraction_enabled())


class BridgeExtractionSuccessTests(unittest.TestCase):
    def test_pdf_goes_through_bridge_and_maps_into_cv_master_shape(self):
        session = _fake_session([json.dumps(FIXTURE_BODY).encode()])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.pdf"
            path.write_bytes(b"%PDF-fake")
            with patch.dict(os.environ, BRIDGE_ENV):
                data, metadata = bridge_extraction.extract_resume(path, session=session)

        # Un seul POST vers l'agent bridge, jamais l'ancien chemin DocIE.
        session.post.assert_called_once()
        endpoint = session.post.call_args.args[0]
        self.assertEqual(endpoint, "https://docie.example/v1/agents/adbi_agent_1/chat/completions")

        # docie_client.map_resume a bien tourné : la structure cv_master (listes
        # education/skills/.../contact) est déjà en place pour normalize_cv_data.
        self.assertEqual(data["name"], "Alice Dupont")
        for key in ("experience", "education", "skills", "languages", "projects", "certifications", "interests"):
            self.assertIn(key, data)
            self.assertIsInstance(data[key], list)

        self.assertEqual(metadata["transport"], "docie-bridge")
        self.assertEqual(metadata["model_profile"], "spark-x2.5-1.7b")
        self.assertEqual(metadata["validation"], {"valid": True, "errors": [], "warnings": []})

    def test_progress_callback_is_invoked(self):
        session = _fake_session([json.dumps(FIXTURE_BODY).encode()])
        seen = []
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.pdf"
            path.write_bytes(b"%PDF-fake")
            with patch.dict(os.environ, BRIDGE_ENV):
                bridge_extraction.extract_resume(path, progress=seen.append, session=session)
        self.assertTrue(seen)


class BridgeExtractionFailureTests(unittest.TestCase):
    def test_bridge_error_becomes_docie_error_without_a_second_call(self):
        session = Mock()
        session.post.side_effect = __import__("requests").Timeout()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.pdf"
            path.write_bytes(b"%PDF-fake")
            with patch.dict(os.environ, BRIDGE_ENV):
                with self.assertRaises(DocIEError) as raised:
                    bridge_extraction.extract_resume(path, session=session)
        self.assertIn("timeout", str(raised.exception))
        session.post.assert_called_once()

    def test_upstream_http_error_becomes_docie_error(self):
        session = Mock()
        response = MagicMock(status_code=500)
        response.__enter__.return_value = response
        session.post.return_value = response
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.pdf"
            path.write_bytes(b"%PDF-fake")
            with patch.dict(os.environ, BRIDGE_ENV):
                with self.assertRaises(DocIEError):
                    bridge_extraction.extract_resume(path, session=session)
        session.post.assert_called_once()

    def test_missing_configuration_fails_before_any_network_call(self):
        session = Mock()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.pdf"
            path.write_bytes(b"%PDF-fake")
            with patch.dict(os.environ, {**BRIDGE_ENV, "DOCIE_AGENT_RESUME": ""}):
                with self.assertRaises(DocIEError):
                    bridge_extraction.extract_resume(path, session=session)
        session.post.assert_not_called()


class RevueMetadataTests(unittest.TestCase):
    """Ce que DocIE dit de son extraction doit traverser ce module (issue #172).

    Le bridge est bouché ici plutôt que son transport HTTP : `field_confidence`
    est rendu par le bridge (PR #173) et ce test porte sur ce que CE module en
    fait — le recopier au lieu de le jeter — pas sur sa collecte.
    """

    def _extraire(self, metadata_bridge):
        resultat = {"schema_name": "adbi_resume", "result": {
            "name": "Alice Dupont", "title": "Développeuse",
            "experience": [{"company": "Numelia", "description": "A"}],
            "education": [], "skills": [], "languages": [], "projects": [],
            "certifications": [], "interests": []}, "metadata": metadata_bridge}
        faux_bridge = MagicMock()
        faux_bridge.extract_document.return_value = resultat
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.pdf"
            path.write_bytes(b"%PDF-fake")
            with patch("docie_bridge_extraction._load_bridge", return_value=faux_bridge):
                return bridge_extraction.extract_resume(path)

    def test_field_confidence_arrive_au_consommateur(self):
        _, metadata = self._extraire({
            "request_id": "req-1", "model": "spark-x2.5-1.7b",
            "validation": {"valid": True, "errors": [], "warnings": []},
            "field_confidence": {"experience[0].description": 0.5, "name": 1}})
        self.assertEqual(metadata["field_confidence"],
                         {"experience[0].description": 0.5, "name": 1})

    def test_validation_absente_reste_absente(self):
        """None (DocIE n'a rien joint) ne doit plus être replié sur {} : une
        réponse non vérifiée n'est pas une réponse propre."""
        _, metadata = self._extraire({"request_id": "req-1", "validation": None})
        self.assertIsNone(metadata["validation"])

    def test_schema_non_nomme_traverse_jusqu_a_la_revue(self):
        """#177 ligne 21 : le bridge tolère une réponse qui ne nomme pas son
        schéma et pose `schema_reported` à False. Le drapeau était jeté ici,
        donc la CVthèque acceptait la fiche sans rien dire là où one-pager
        avertit (`docie_schema_non_verifie`)."""
        from docie_review import revue_docie
        data, metadata = self._extraire({
            "request_id": "req-1", "validation": {"valid": True, "errors": [], "warnings": []},
            "field_confidence": {}, "schema_reported": False})
        self.assertIs(metadata["schema_reported"], False)
        self.assertIn("docie_schema_non_verifie", revue_docie(data, metadata)["warnings"])

    def test_schema_nomme_n_avertit_pas(self):
        from docie_review import revue_docie
        data, metadata = self._extraire({
            "request_id": "req-1", "validation": {"valid": True, "errors": [], "warnings": []},
            "field_confidence": {}, "schema_reported": True})
        self.assertIs(metadata["schema_reported"], True)
        self.assertEqual(revue_docie(data, metadata)["warnings"], [])

    def test_bridge_sans_drapeau_de_schema_reste_compatible(self):
        """Clé absente (bridge antérieur, chemin historique docie_client) :
        « pas dit » n'est pas « non nommé » — aucune revue inventée."""
        from docie_review import revue_docie
        data, metadata = self._extraire({
            "request_id": "req-1", "validation": {"valid": True, "errors": [], "warnings": []}})
        self.assertIsNone(metadata["schema_reported"])
        self.assertEqual(revue_docie(data, metadata)["warnings"], [])

    def test_bridge_sans_confiance_par_champ_reste_compatible(self):
        """Bridge antérieur à #173 : clé absente -> {}, aucune revue inventée."""
        _, metadata = self._extraire({"request_id": "req-1", "validation": {"valid": True}})
        self.assertEqual(metadata["field_confidence"], {})
        self.assertEqual(metadata["validation"], {"valid": True})


class VoieTexteTests(unittest.TestCase):
    """Voie TEXTE du pont (#151).

    Un document qui PORTE son texte n'a rien à faire sur la voie agent, et n'a
    plus à sortir du pont par le client historique. Ce qui est vérifié ici est
    le ROUTAGE et ce qui part dans le corps ; la lecture locale elle-même
    (pypdf, rendu DOCX) reste couverte par les tests de docie_client, dont la
    règle est IMPORTÉE par le module testé, pas recopiée.
    """

    def _pont(self):
        pont = MagicMock()
        pont.extract_text.return_value = {"schema_name": "adbi_resume", "result": {
            "name": "Alice Dupont", "title": "Développeuse", "experience": [],
            "education": [], "skills": [], "languages": [], "projects": [],
            "certifications": [], "interests": []},
            "metadata": {"request_id": "req-texte", "model": "lfm2.5-2.6b", "agent": None,
                         "validation": {"valid": True, "errors": [], "warnings": []},
                         "field_confidence": {"name": 0.4},
                         "partiel": [{"champ": "name", "raison": "boucle"}],
                         "blocs_texte": 12, "troncature_possible": False,
                         "schema_reported": True}}
        return pont

    def _extraire(self, nom, texte, pont, **kwargs):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / nom
            path.write_bytes(b"le contenu importe peu : texte_document est bouche")
            with patch("docie_bridge_extraction.docie_client.texte_document",
                       return_value=(texte, None)):
                with patch("docie_bridge_extraction._load_bridge", return_value=pont):
                    with patch.dict(os.environ, BRIDGE_ENV):
                        return bridge_extraction.extract_resume(path, **kwargs)

    def test_docx_part_par_le_pont_et_non_par_le_client_historique(self):
        pont = self._pont()
        legacy = Mock()
        with patch("docie_bridge_extraction.docie_client.extract_resume", legacy):
            data, metadata = self._extraire("cv.docx", "Alice Dupont\nDéveloppeuse", pont)
        legacy.assert_not_called()
        pont.extract_document.assert_not_called()
        self.assertEqual(pont.extract_text.call_count, 1)
        self.assertEqual(data["name"], "Alice Dupont")
        self.assertEqual(metadata["transport"], "docie-bridge")
        self.assertEqual(metadata["voie"], "texte")

    def test_pdf_reste_sur_la_voie_agent_et_sa_couche_texte_n_est_meme_pas_lue(self):
        """Volontaire, et pas un oubli. Le pont actif,
        choix_modele.voie_pour(".pdf") rend "agent" : le sélecteur ne propose
        que des modèles de cette voie et app.py a validé le Choix pour elle.
        Router le PDF en texte ferait refuser un modèle vision-seul
        (`modele_non_propose`) là où il fonctionnait. La lecture locale ne doit
        donc même pas être tentée."""
        pont = self._pont()
        pont.extract_document.return_value = {"schema_name": "adbi_resume", "result": {
            "name": "Bob", "title": "", "experience": [], "education": [], "skills": [],
            "languages": [], "projects": [], "certifications": [], "interests": []},
            "metadata": {"request_id": "req-agent", "agent": "adbi_agent_1"}}
        lecture = Mock()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cv.pdf"
            path.write_bytes(b"%PDF-fake")
            with patch("docie_bridge_extraction.docie_client.texte_document", lecture):
                with patch("docie_bridge_extraction._load_bridge", return_value=pont):
                    with patch.dict(os.environ, BRIDGE_ENV):
                        _, metadata = bridge_extraction.extract_resume(path)
        lecture.assert_not_called()
        pont.extract_text.assert_not_called()
        self.assertEqual(pont.extract_document.call_count, 1)
        self.assertEqual(metadata["voie"], "agent")

    def test_le_schema_part_dans_le_corps_avec_le_bon_document_type(self):
        """Le pont refuse un `dynamic_schema` dont le `document_type` n'est pas
        celui du `kind` : un chemin de schéma copié d'une autre pièce
        échouerait ici, et nulle part ailleurs."""
        pont = self._pont()
        self._extraire("cv.docx", "Alice", pont)
        args, kwargs = pont.extract_text.call_args
        self.assertEqual(args[0], "Alice")
        self.assertEqual(kwargs["kind"], "resume")
        self.assertEqual(kwargs["dynamic_schema"]["document_type"], "adbi_resume")

    def test_signaux_de_revue_arrivent_par_la_voie_texte(self):
        """Ce que le client historique ne rendait PAS : `field_confidence` et
        `partiel`, que docie_review consomme pour marquer les champs à
        vérifier. Sans eux, la revue n'avait rien à dire."""
        pont = self._pont()
        _, metadata = self._extraire("cv.docx", "Alice", pont)
        self.assertEqual(metadata["field_confidence"], {"name": 0.4})
        self.assertEqual(metadata["partiel"], [{"champ": "name", "raison": "boucle"}])
        self.assertEqual(metadata["blocs_texte"], 12)
        self.assertIs(metadata["troncature_possible"], False)

    def test_modele_choisi_verifie_sur_le_texte_et_envoye_en_model_profile(self):
        pont = self._pont()
        choix = Mock()
        choix.est_externe = False
        choix.pour_texte.return_value = "store:lfm25_2_6b"
        self._extraire("cv.docx", "Alice Dupont", pont, choix=choix)
        choix.pour_texte.assert_called_once_with("Alice Dupont")
        choix.pour_agent.assert_not_called()
        _, kwargs = pont.extract_text.call_args
        self.assertEqual(kwargs["model_profile"], "store:lfm25_2_6b")



if __name__ == "__main__":
    unittest.main()

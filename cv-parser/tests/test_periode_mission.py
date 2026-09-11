"""« Mission en cours ? » : le Python et le JS doivent répondre pareil.

Le jeu d'essai et le motif sont lus dans la fixture partagée
document-parsing/fixtures/mission_en_cours.json — le test JS jumeau
(one-pager/tests/docie-extract.test.js) lit exactement le même fichier. Comparer
le motif, et pas seulement les verdicts, est ce qui empêche les deux listes de
redivergier : ajouter un synonyme d'un seul côté casse le test de l'autre.

`app.py` ouvre PostgreSQL à l'import ; `compute_years_experience` et
`normalize_cv_data` en sont donc extraites par `ast`, comme l'inventaire #177.
"""
import ast
import json
import re
import sys
import unittest
from datetime import datetime
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))

from niveau_langue import niveau_cecrl  # noqa: E402
from periode_mission import (  # noqa: E402
    MISSION_EN_COURS_RE,
    MOIS,
    analyser_date,
    analyser_periode,
    duree_mois,
    index_mois,
    mentionne_en_cours,
    mission_en_cours,
    mois_courant,
    ordre_missions,
    periode_lisible,
    sans_accents,
    titre_de_repli,
)

FIXTURE = Path(__file__).resolve().parents[2] / "document-parsing/fixtures/mission_en_cours.json"
FIXTURE_DATES = Path(__file__).resolve().parents[2] / "document-parsing/fixtures/date_mission.json"
REPONSE_DOCIE = (
    Path(__file__).resolve().parents[2]
    / "document-parsing/fixtures/cv_samples/results/simple_docie.json"
)


def _fonctions_de_app(noms):
    """Extrait des fonctions d'app.py sans l'importer (il ouvre PostgreSQL)."""
    arbre = ast.parse((RACINE / "app.py").read_text(encoding="utf-8"))
    source = "\n\n".join(
        ast.unparse(n) for n in arbre.body
        if isinstance(n, ast.FunctionDef) and n.name in noms
    )
    espace = {
        "re": re,
        "datetime": datetime,
        "mentionne_en_cours": mentionne_en_cours,
        "analyser_periode": analyser_periode,
        "ordre_missions": ordre_missions,
        "index_mois": index_mois,
        "mois_courant": mois_courant,
        "periode_lisible": periode_lisible,
        "titre_de_repli": titre_de_repli,
        "niveau_cecrl": niveau_cecrl,
        # normalize_cv_data appelle ces trois-là hors du périmètre mesuré ici.
        "normalize_skills": lambda *a, **k: {},
        "skills_to_flat": lambda *a, **k: [],
        "compute_skills_flat": lambda *a, **k: [],
    }
    exec(compile(source, str(RACINE / "app.py"), "exec"), espace)
    return espace


def _anciennete_attendue(*intervalles):
    """L'ancienneté que doit rendre `compute_years_experience`, en mois réels.

    Écrite avec les primitives partagées (index_mois / mois_courant) plutôt
    qu'avec un nombre en dur : « Mars 2019 -> aujourd'hui » ne vaut pas le même
    nombre d'années selon le jour où le test tourne. `None` en fin d'intervalle
    signifie « en cours ». Les intervalles sont supposés disjoints.
    """
    mois = sum(
        duree_mois(debut, fin or mois_courant()) for debut, fin in intervalles
    )
    return int(mois / 12 + 0.5)


def _periode_comme_map_resume(lignes):
    """Reproduit docie_client.map_resume : `period` = début – fin."""
    sorties = []
    for ligne in lignes:
        ligne = dict(ligne)
        ligne["period"] = ligne.get("period") or " – ".join(
            str(ligne[k]) for k in ("start_date", "end_date") if ligne.get(k)
        )
        sorties.append(ligne)
    return sorties


class MotifPartageTests(unittest.TestCase):
    """Le motif Python est celui de la fixture, donc celui du JS."""

    def setUp(self):
        self.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_le_motif_est_celui_de_la_fixture_partagee(self):
        self.assertEqual(MISSION_EN_COURS_RE.pattern, self.fixture["motif"])

    def test_chaque_cas_du_jeu_dessai_partage(self):
        for cas in self.fixture["cas"]:
            with self.subTest(valeur=cas["valeur"]):
                self.assertEqual(
                    mission_en_cours(cas["valeur"]), cas["en_cours"], cas["preuve"]
                )

    def test_une_date_de_fin_absente_vaut_en_cours(self):
        self.assertTrue(self.fixture["vide_est_en_cours"])
        for vide in ("", "   ", None):
            with self.subTest(valeur=vide):
                self.assertTrue(mission_en_cours(vide))
        # `mentionne_en_cours` répond à l'autre question : le texte porte-t-il
        # une marque ? Une période vide n'en porte pas.
        self.assertFalse(mentionne_en_cours(""))

    def test_accents_et_casse(self):
        self.assertEqual(sans_accents("Présent à ce jour"), "Present a ce jour")
        for valeur in ("PRÉSENT", "présent", "Présent"):
            with self.subTest(valeur=valeur):
                self.assertTrue(mentionne_en_cours(valeur))


class AncienneteTests(unittest.TestCase):
    """#177 lignes 4, 5 et 6, mesurées de bout en bout."""

    def setUp(self):
        espace = _fonctions_de_app({"compute_years_experience", "normalize_cv_data"})
        self.normalize = espace["normalize_cv_data"]

    def annees(self, lignes):
        fiche = self.normalize({"experience": _periode_comme_map_resume(lignes)})
        return fiche["years_experience"], [e["period"] for e in fiche["experience"]]

    def test_poste_actuel_compte_jusqu_a_aujourdhui(self):
        # Avant : 0 an — « actuel » manquait à la liste Python (#177 ligne 4).
        annees, periodes = self.annees(
            [{"title": "Dev", "start_date": "Mars 2019", "end_date": "Poste actuel"}]
        )
        self.assertEqual(annees, _anciennete_attendue(("2019-03", None)))
        self.assertEqual(periodes, ["Mars 2019 – Poste actuel"])

    def test_maintenant_compte_jusqu_a_aujourdhui(self):
        annees, _ = self.annees(
            [{"title": "Dev", "start_date": "Mars 2019", "end_date": "Maintenant"}]
        )
        self.assertEqual(annees, _anciennete_attendue(("2019-03", None)))

    def test_sans_date_de_fin_la_mission_est_en_cours(self):
        # Avant : période « Mars 2019 » seule, donc 0 an (#177 ligne 6).
        annees, periodes = self.annees(
            [{"title": "Dev", "start_date": "Mars 2019", "end_date": ""}]
        )
        self.assertEqual(periodes, ["Depuis Mars 2019"])
        self.assertEqual(annees, _anciennete_attendue(("2019-03", None)))

    def test_une_mission_terminee_reste_bornee(self):
        annees, _ = self.annees(
            [{"title": "Dev", "start_date": "Mars 2019", "end_date": "Juin 2021"}]
        )
        self.assertEqual(annees, 2)

    def test_la_vraie_reponse_docie_du_depot_est_inchangee(self):
        """Non-régression sur la fixture « Camille Béranger » : 7 ans avant.

        Les deux missions sont jointives (février 2022 puis mars 2022) : leur
        union est donc un seul intervalle de septembre 2019 à aujourd'hui.
        Le passage aux mois réels (#177 ligne 9) ne déplace pas ce total.
        """
        def deballe(valeur):
            if isinstance(valeur, dict):
                if "value" in valeur and ("confidence" in valeur or "evidence_ids" in valeur):
                    return deballe(valeur["value"])
                return {k: deballe(v) for k, v in valeur.items()}
            if isinstance(valeur, list):
                return [deballe(v) for v in valeur]
            return valeur

        reponse = json.loads(REPONSE_DOCIE.read_text(encoding="utf-8"))
        missions = deballe(reponse["result"]).get("experience") or []
        annees, periodes = self.annees(missions)
        self.assertEqual(periodes[0], "Mars 2022 – Aujourd'hui")
        # 7 ans au moment où #177 l'a relevé ; l'attendu est recalculé plutôt
        # que figé, la fiche portant une mission toujours en cours.
        self.assertEqual(annees, _anciennete_attendue(("2019-09", None)))


class AnalyseurDeDateTests(unittest.TestCase):
    """#177 ligne 8 : un seul analyseur de date, honoré à l'identique des deux côtés.

    Le jeu d'essai est lu dans document-parsing/fixtures/date_mission.json — le
    test JS jumeau (one-pager/tests/normalize.test.js) lit exactement le même
    fichier et compare sa table de mois au même champ `mois`. Ajouter un libellé
    de mois d'un seul côté casse donc le test de l'autre service.
    """

    def setUp(self):
        self.fixture = json.loads(FIXTURE_DATES.read_text(encoding="utf-8"))

    def test_la_table_des_mois_est_celle_du_jeu_dessai_partage(self):
        self.assertEqual(MOIS, self.fixture["mois"])

    def test_chaque_date_du_jeu_dessai_partage(self):
        for cas in self.fixture["cas"]:
            with self.subTest(valeur=cas["valeur"]):
                self.assertEqual(analyser_date(cas["valeur"]), cas["iso"], cas["preuve"])

    def test_chaque_duree_du_jeu_dessai_partage(self):
        for cas in self.fixture["durees"]:
            with self.subTest(debut=cas["debut"], fin=cas["fin"]):
                self.assertEqual(duree_mois(cas["debut"], cas["fin"]), cas["mois"], cas["preuve"])

    def test_une_annee_seule_vaut_janvier(self):
        # Convention de one-pager/lib/extract.js::monthIndex, celle dont sort
        # l'ancienneté affichée : s'en écarter ferait diverger d'un an tout CV
        # daté à l'année seule.
        self.assertEqual(index_mois("2019"), index_mois("2019-01"))

    def test_une_fin_anterieure_au_debut_ne_compte_pas_negativement(self):
        self.assertEqual(duree_mois("2021-06", "2019-03"), 0)

    def test_le_texte_vide_et_les_absences(self):
        for vide in ("", "   ", None):
            with self.subTest(valeur=vide):
                self.assertIsNone(analyser_date(vide))
                self.assertEqual(analyser_periode(vide), (None, None, False))


class DecoupagePeriodeTests(unittest.TestCase):
    """La marque « en cours » ne se cherche que dans la borne de FIN.

    C'est l'asymétrie que #177 signalait comme « connue et acceptée » faute
    d'analyseur : le motif était appliqué à la période entière côté Python.
    """

    def test_les_deux_bornes_sont_lues(self):
        self.assertEqual(
            analyser_periode("Septembre 2019 - Février 2022"), ("2019-09", "2022-02", False)
        )

    def test_une_periode_fermee_qui_commence_par_depuis(self):
        # « Depuis 2015 jusqu'en 2018 » : période FERMÉE. Avant l'analyseur,
        # « depuis » suffisait à la déclarer en cours et elle était comptée
        # jusqu'à aujourd'hui.
        self.assertEqual(analyser_periode("Depuis 2015 jusqu'en 2018"), ("2015", "2018", False))

    def test_sans_separateur_la_chaine_entiere_reste_la_question(self):
        self.assertEqual(analyser_periode("Depuis Mars 2019"), ("2019-03", None, True))

    def test_un_tiret_dans_une_date_ne_coupe_pas_la_periode(self):
        # Le séparateur doit être entouré d'espaces, sans quoi « 2019-03 »
        # serait coupé en deux et le mois perdu.
        self.assertEqual(analyser_periode("2019-03"), ("2019-03", "2019-03", False))
        self.assertEqual(analyser_periode("2019-03 - 2021-06"), ("2019-03", "2021-06", False))

    def test_les_formes_rendues_par_map_resume(self):
        # `map_resume` fabrique la période avec un tiret demi-cadratin entouré
        # d'espaces ; `normalize_cv_data` ajoute la forme « Depuis <début> ».
        self.assertEqual(analyser_periode("Mars 2022 – Aujourd'hui"), ("2022-03", None, True))
        self.assertEqual(analyser_periode("Mars 2019 – Poste actuel"), ("2019-03", None, True))

    def test_les_separateurs_francais_ecrits_en_toutes_lettres(self):
        for periode in ("De mars 2019 à juin 2021", "Mars 2019 au Juin 2021",
                        "Mars 2019 jusqu'au Juin 2021"):
            with self.subTest(periode=periode):
                self.assertEqual(analyser_periode(periode), ("2019-03", "2021-06", False))


class AncienneteAvecAnalyseurTests(unittest.TestCase):
    """#177 ligne 8, mesuré sur `compute_years_experience`."""

    def setUp(self):
        espace = _fonctions_de_app({"compute_years_experience"})
        self.annees = espace["compute_years_experience"]

    def test_une_periode_fermee_ouverte_par_depuis_ne_court_plus_jusqu_a_aujourdhui(self):
        # Avant l'analyseur : « depuis » dans la chaîne -> fin = année courante,
        # soit 2026 - 2015 = 11 ans pour une mission de 3 ans.
        self.assertEqual(self.annees([{"period": "Depuis 2015 jusqu'en 2018"}]), 3)

    def test_les_periodes_ordinaires_sont_inchangees(self):
        self.assertEqual(self.annees([{"period": "Septembre 2019 - Février 2022"}]), 3)
        self.assertEqual(
            self.annees([{"period": "Mars 2019 – Poste actuel"}]),
            _anciennete_attendue(("2019-03", None)),
        )

    def test_les_missions_paralleles_ne_comptent_pas_deux_fois(self):
        """#177 ligne 9 : union des périodes, pas somme — comme le JS.

        Avant : 4 ans (janvier 2019 -> décembre 2022) plus 3 ans (juin 2020 ->
        décembre 2022) additionnés, soit 7 ans pour quatre ans de carrière.
        """
        annees = self.annees([
            {"period": "Janvier 2019 - Décembre 2022"},
            {"period": "Juin 2020 - Décembre 2022"},
        ])
        self.assertEqual(annees, 4)

    def test_deux_missions_jointives_forment_une_seule_periode(self):
        # Une mission qui finit en mai, la suivante qui commence en juin : le
        # mois de « trou » n'en est pas un.
        self.assertEqual(
            self.annees([{"period": "Janvier 2019 - Mai 2020"},
                         {"period": "Juin 2020 - Décembre 2020"}]),
            2,
        )

    def test_les_mois_comptent_et_pas_seulement_les_millesimes(self):
        """Janvier -> décembre fait une année, janvier -> février n'en fait pas.

        Les deux valaient 0 an quand seuls les millésimes étaient soustraits.
        """
        self.assertEqual(self.annees([{"period": "Janvier 2020 - Décembre 2020"}]), 1)
        self.assertEqual(self.annees([{"period": "Janvier 2020 - Février 2020"}]), 0)

    def test_une_periode_illisible_compte_toujours_pour_un_an(self):
        # Repli conservé : la mettre à zéro sortirait le consultant du
        # rapprochement, exactement comme « Poste actuel » avant #176.
        self.assertEqual(self.annees([{"period": "il y a longtemps"}]), 1)
        self.assertEqual(self.annees([{"period": ""}]), 0)


class AncienneteAnnonceeParDocIETests(unittest.TestCase):
    """#177 ligne 3 : n'écraser le `years_experience` de DocIE que si on a mieux.

    `normalize_cv_data` le remplaçait systématiquement par le calcul, même quand
    aucune période n'était lisible et que le calcul ne reposait donc sur rien :
    DocIE pouvait annoncer 12 ans, la fiche en affichait 0, et
    /api/needs/<id>/match classait le consultant en dernier — la panne « senior
    introuvable » de #176, par une autre cause.

    Ordre de préférence mesuré ici, celui du JS
    (`lib/docie-extract.js` : calcul si `experiences.some(e => e.start_date)`,
    repli sur `years_experience` sinon) :
        période lisible > valeur annoncée par DocIE > un an par période illisible.
    """

    def setUp(self):
        espace = _fonctions_de_app({"normalize_cv_data", "compute_years_experience"})
        self.normalize = espace["normalize_cv_data"]

    def _annees(self, missions, annonce=None):
        return self.normalize(
            {"experience": missions, "years_experience": annonce}
        )["years_experience"]

    def test_une_periode_lisible_prime_sur_ce_que_docie_annonce(self):
        """Le calcul est mesuré ; l'annonce de DocIE ne l'est pas."""
        missions = [{"period": "Janvier 2019 - Décembre 2022"}]
        self.assertEqual(self._annees(missions), 4)
        self.assertEqual(self._annees(missions, 12), 4)

    def test_sans_aucune_mission_la_valeur_de_docie_passe(self):
        # Avant : 0, quoi que DocIE ait lu dans l'en-tête du CV.
        self.assertEqual(self._annees([], 12), 12)
        self.assertEqual(self._annees([], None), 0)

    def test_des_missions_sans_date_laissent_passer_la_valeur_de_docie(self):
        self.assertEqual(self._annees([{"period": ""}, {"period": ""}], 12), 12)

    def test_des_periodes_illisibles_laissent_passer_la_valeur_de_docie(self):
        """« 3 ans » n'est pas une période lisible : DocIE fait mieux."""
        missions = [{"period": "3 ans"}, {"period": "2 ans"}]
        self.assertEqual(self._annees(missions, 12), 12)

    def test_le_forfait_dun_an_reste_le_dernier_recours(self):
        """DocIE muet : le repli de #176 tient, personne n'est ramené à zéro."""
        self.assertEqual(self._annees([{"period": "3 ans"}, {"period": "2 ans"}]), 2)
        self.assertEqual(self._annees([{"period": "il y a longtemps"}], 0), 1)

    def test_une_periode_lisible_tres_courte_reste_prioritaire(self):
        """Trois mois lisibles valent 0 an, et ce 0-là est mesuré : il tient."""
        self.assertEqual(self._annees([{"period": "Janvier 2024 - Mars 2024"}], 12), 0)

    def test_la_valeur_de_docie_est_coercee_comme_par_le_JS(self):
        """`Math.max(0, Math.round(Number(x) || 0))`, arrondi au supérieur."""
        for annonce, attendu in (
            (12, 12), ("12", 12), (" 12 ", 12), (12.6, 13), (12.4, 12),
            ("douze", 0), ("", 0), (None, 0), (-5, 0), (True, 0), ([], 0),
        ):
            with self.subTest(annonce=annonce):
                self.assertEqual(self._annees([], annonce), attendu)

    def test_predicat_et_cumul_restent_dacord(self):
        """`periode_lisible` doit dire vrai exactement quand le cumul a un intervalle.

        Le critère est écrit à DEUX endroits — `periode_mission.periode_lisible`
        et la boucle de `compute_years_experience` — et ils doivent rester
        d'accord : s'ils divergeaient, la valeur annoncée par DocIE
        remplacerait un calcul réel, ou l'inverse.

        Chaque période est confrontée à l'ancienneté qu'on en RECALCULE avec les
        primitives partagées, jamais à une heuristique sur le résultat : une
        année civile pleine vaut 1 an tout comme le forfait d'une période
        illisible, donc le nombre seul ne dit pas d'où il vient.
        """
        annees = _fonctions_de_app({"compute_years_experience"})["compute_years_experience"]
        for periode in ("Janvier 2019 - Décembre 2022", "Mars 2019 – Poste actuel",
                        "Depuis 2015 jusqu'en 2018", "2019", "Janvier 2024 - Mars 2024",
                        "Janvier 2020 - Décembre 2020",  # 1 an, lisible : le sosie du forfait
                        "3 ans", "il y a longtemps", "", "   "):
            with self.subTest(periode=periode):
                missions = [{"period": periode}]
                debut, fin, en_cours = analyser_periode(periode)
                intervalle = bool(debut) and index_mois(
                    mois_courant() if en_cours or not fin else fin) >= index_mois(debut)
                self.assertEqual(periode_lisible(missions), intervalle, periode)
                if intervalle:
                    attendu = _anciennete_attendue((debut, fin))
                else:
                    # Forfait d'un an dès que la période est présente — même
                    # faite d'espaces, `compute_years_experience` testant la
                    # chaîne brute.
                    attendu = 1 if periode else 0
                self.assertEqual(annees(missions), attendu, periode)

    def test_la_vraie_reponse_docie_ne_bouge_pas(self):
        """Témoin : elle a des périodes lisibles, et DocIE n'y annonce rien.

        `years_experience` y vaut littéralement `null` : le repli est donc
        inerte sur la seule vraie réponse DocIE du dépôt. Ce qui le justifie,
        c'est la parité avec le JS et les cas sans période lisible, pas cette
        fixture-ci.
        """
        reponse = json.loads(REPONSE_DOCIE.read_text(encoding="utf-8"))
        self.assertIsNone(reponse["result"]["years_experience"])
        from docie_client import map_resume
        fiche = self.normalize(map_resume(reponse))
        self.assertEqual(
            fiche["years_experience"],
            _anciennete_attendue(("2019-09", "2022-02"), ("2022-03", None)),
        )


class OrdreDesMissionsTests(unittest.TestCase):
    """#177 ligne 7 : les missions se lisent de la plus récente à la plus ancienne."""

    def test_tri_decroissant_sur_la_date_de_debut(self):
        lignes = [
            {"title": "Ancienne", "start_date": "Septembre 2019"},
            {"title": "Recente", "start_date": "Mars 2022"},
        ]
        self.assertEqual(ordre_missions(lignes), [1, 0])

    def test_la_periode_sert_de_repli_quand_start_date_manque(self):
        # Après `normalize_cv_data` la fiche ne garde que `period` ; le chemin
        # « Copilot » renormalise une fiche qui n'a jamais eu de `start_date`.
        lignes = [
            {"period": "Septembre 2019 - Février 2022"},
            {"period": "Mars 2022 – Aujourd'hui"},
        ]
        self.assertEqual(ordre_missions(lignes), [1, 0])

    def test_une_mission_sans_date_sort_en_dernier_sans_bouger_des_autres(self):
        lignes = [
            {"title": "Sans date"},
            {"title": "Ancienne", "start_date": "2019"},
            {"title": "Sans date non plus", "start_date": "à définir"},
            {"title": "Recente", "start_date": "2022"},
        ]
        self.assertEqual(ordre_missions(lignes), [3, 1, 0, 2])

    def test_le_tri_est_stable_a_dates_egales(self):
        lignes = [
            {"title": "A", "start_date": "Mars 2022"},
            {"title": "B", "start_date": "Mars 2022"},
            {"title": "C", "start_date": "Mars 2022"},
        ]
        self.assertEqual(ordre_missions(lignes), [0, 1, 2])

    def test_un_mois_connu_passe_devant_la_meme_annee_sans_mois(self):
        # « 2019-03 » et « 2019 » se comparent comme des chaînes, des deux
        # côtés : le mois connu est le plus récent des deux.
        lignes = [{"start_date": "2019"}, {"start_date": "Mars 2019"}]
        self.assertEqual(ordre_missions(lignes), [1, 0])


if __name__ == "__main__":
    unittest.main()

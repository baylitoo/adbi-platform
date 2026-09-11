"""
export_dossier.py — dossier de compétences ADBI en PDF et en Word.

Le gabarit de référence est `NH_ADBI.pdf`, dont la géométrie a été relevée au
point près : page A4 595×842, bandeau haut de 80 pt, bandeau bas de 72 pt, logo
à x=386 y=109 (167×83), identité à x=62, pastilles à y=222 sur 24 pt de haut,
intitulés à x=63 et valeurs à x=197, puces avec marqueur à x=79.

Le PDF est dessiné directement (PyMuPDF) plutôt que converti depuis le HTML :
aucun moteur de conversion à installer, et surtout aucune dérive de mise en
page — ce qui est écrit ici est exactement ce qui sort.

Le Word ne peut pas reproduire un positionnement absolu aussi fidèlement ; il
reprend les mêmes images, les mêmes couleurs et le même enchaînement de
rubriques, avec la mise en page qu'un traitement de texte sait tenir.
"""

from __future__ import annotations

import re
from io import BytesIO
from pathlib import Path

import fitz  # PyMuPDF

RACINE = Path(__file__).parent
IMAGES = RACINE / "static" / "adbi"

# ── Géométrie du modèle (points) ─────────────────────────────────────────────
PAGE_L, PAGE_H = 595, 842
MARGE_G, MARGE_D = 57, 57
BANDEAU_HAUT_H, BANDEAU_BAS_H = 80, 72
Y_PLANCHER = PAGE_H - BANDEAU_BAS_H - 12      # dernière ligne écrivable
COL_VALEUR = 197                              # colonne des valeurs
X_PUCE, X_TEXTE_PUCE = 79, 97

# Nombre maximal de familles de compétences imprimées sur le dossier.
MAX_FAMILLES = 7

# Et bornes du CONTENU d'une famille. Limiter le nombre de familles ne suffit
# pas : mesuré sur un CV réel, une seule famille — « Technologies des
# missions » — comptait 45 entrées et 661 caractères, soit une page entière
# pour une seule ligne du tableau. Un dossier de compétences est une synthèse ;
# une énumération de quarante outils n'apprend rien à qui la lit.
MAX_ITEMS_FAMILLE = 14
MAX_CARACTERES_FAMILLE = 200

# Points de compétences technico-fonctionnelles imprimés. Six suffisent à
# camper un profil ; au-delà, la liste devient un inventaire de tâches que
# personne ne lit, et elle chasse les expériences vers une page de plus.
MAX_SAVOIR_FAIRE = 6

ORANGE = (1.0, 0.4, 0.0)          # #ff6600
VIOLET = (0.44, 0.19, 0.63)       # #7030a0
ENCRE = (0.10, 0.10, 0.10)
GRIS = (0.32, 0.32, 0.32)

# Polices : le modèle est composé en Century Gothic. Les polices de base d'un
# PDF (helv) sont limitées au Latin-1 : l'apostrophe typographique « ’ » et la
# puce « • » y sortaient en points médians. On embarque donc une vraie police,
# avec deux replis si la machine ne l'a pas.
_CANDIDATS_POLICE = [
    ("C:/Windows/Fonts/GOTHIC.TTF", "C:/Windows/Fonts/GOTHICB.TTF"),
    ("C:/Windows/Fonts/calibri.ttf", "C:/Windows/Fonts/calibrib.ttf"),
    ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
]


def _fichiers_police():
    for normale, grasse in _CANDIDATS_POLICE:
        if Path(normale).exists() and Path(grasse).exists():
            return normale, grasse
    return None, None


POLICE = "helv"
POLICE_G = "hebo"


def _img(nom: str, aplati: bool = False) -> Path | None:
    """Chemin d'une image du gabarit.

    `aplati=True` renvoie la version JPEG sur fond blanc, réservée au PDF : une
    image à couche alpha y est stockée en bitmap non compressé — 1,4 Mo par
    bandeau et par page — alors que le fond du dossier est blanc de toute
    façon. Le HTML et le Word gardent les PNG détourés.
    """
    if aplati:
        jpg = IMAGES / (Path(nom).stem + ".jpg")
        if jpg.exists():
            return jpg
    chemin = IMAGES / nom
    return chemin if chemin.exists() else None


class Dossier:
    """Assemble le document page à page, en gérant les ruptures."""

    def __init__(self, pied: str):
        self.doc = fitz.open()
        self.pied = pied
        self.page = None
        self.y = 0
        # Les bandeaux sont insérés une seule fois puis RÉUTILISÉS par leur
        # référence : sans cela, chaque page réencodait les mêmes images et un
        # dossier de quatre pages pesait 3,8 Mo.
        self._refs = {}
        # Polices embarquées, déclarées sur chaque page à sa création.
        self.f_normale, self.f_grasse = _fichiers_police()
        self.police = "adbi" if self.f_normale else POLICE
        self.police_g = "adbib" if self.f_grasse else POLICE_G
        # `fitz.get_text_length` ne connaît que les polices de base : pour une
        # police embarquée il faut mesurer avec l'objet Font correspondant.
        self._mesure = fitz.Font(fontfile=self.f_grasse) if self.f_grasse else None
        self._nouvelle_page(premiere=True)

    # ── Pages ───────────────────────────────────────────────────────────────
    def _bandeau(self, nom: str, rect: fitz.Rect):
        chemin = _img(nom, aplati=True)
        if not chemin:
            return
        # keep_proportion=False : sans cela, PyMuPDF centre l'image dans le
        # rectangle en gardant ses proportions, et le bandeau — plus large que
        # haut — laissait des bandes blanches à gauche, à droite et en bas.
        # Le modèle lui-même étire son bandeau sur toute la largeur de page.
        ref = self._refs.get(nom)
        if ref:
            self.page.insert_image(rect, xref=ref, keep_proportion=False)
        else:
            self._refs[nom] = self.page.insert_image(rect, filename=str(chemin),
                                                     keep_proportion=False)

    def _nouvelle_page(self, premiere: bool = False):
        self.page = self.doc.new_page(width=PAGE_L, height=PAGE_H)
        if self.f_normale:
            self.page.insert_font(fontname="adbi", fontfile=self.f_normale)
            self.page.insert_font(fontname="adbib", fontfile=self.f_grasse)
        self._bandeau("bandeau-1.png", fitz.Rect(0, 0, PAGE_L, BANDEAU_HAUT_H))
        self._bandeau("bandeau-2.png",
                      fitz.Rect(0, PAGE_H - BANDEAU_BAS_H, PAGE_L, PAGE_H))
        if self.pied:
            self.page.insert_text((MARGE_G, PAGE_H - 51), self.pied,
                                  fontname=self.police_g, fontsize=11, color=ENCRE)
        self.y = 96 if not premiere else 109

    def _largeur(self, texte: str, taille: float) -> float:
        """Largeur d'un texte en gras, police embarquée ou de base."""
        if self._mesure:
            return self._mesure.text_length(texte, fontsize=taille)
        return fitz.get_text_length(texte, fontname=POLICE_G, fontsize=taille)

    def _place(self, hauteur: float):
        """Réserve `hauteur` ; ouvre une page si le bloc ne tient plus."""
        if self.y + hauteur > Y_PLANCHER:
            self._nouvelle_page()

    # ── Blocs ───────────────────────────────────────────────────────────────
    def entete(self, nom: str, titre: str, anciennete: str):
        logo = _img("logo-adbi.png", aplati=True)
        if logo:
            self.page.insert_image(fitz.Rect(386, 109, 553, 192), filename=str(logo))
        self.page.insert_text((62, 140), nom, fontname=self.police_g, fontsize=16, color=ORANGE)
        y = 164
        if titre:
            taille = 15 if len(titre) <= 30 else 12
            # Le titre ne doit pas courir sous le logo : on le replie sur deux
            # lignes plutôt que de le laisser mordre dessus.
            for ligne in _replier(titre, 40 if taille == 12 else 32)[:2]:
                self.page.insert_text((62, y), ligne, fontname=self.police_g,
                                      fontsize=taille, color=GRIS)
                y += taille + 3
        if anciennete:
            self.page.insert_text((62, y + 6), anciennete, fontname=self.police_g,
                                  fontsize=10, color=VIOLET)
        self.y = 222

    def pastilles(self, etiquettes: list):
        if not etiquettes:
            self.y = 258
            return
        largeur_utile = PAGE_L - MARGE_G - MARGE_D
        ecart = 9
        largeur = (largeur_utile - ecart * (len(etiquettes) - 1)) / len(etiquettes)
        for i, texte in enumerate(etiquettes):
            x = MARGE_G + i * (largeur + ecart)
            self.page.draw_rect(fitz.Rect(x, self.y, x + largeur, self.y + 24),
                                color=None, fill=ORANGE)
            # Centrage calculé : insert_textbox aligne verticalement en haut,
            # ce qui laisserait le texte collé au bord supérieur de la pastille.
            largeur_texte = self._largeur(texte, 10)
            self.page.insert_text((x + (largeur - largeur_texte) / 2, self.y + 16),
                                  texte, fontname=self.police_g, fontsize=10, color=(1, 1, 1))
        self.y += 24 + 20

    def rubrique(self, titre: str, nouvelle_page: bool = False):
        # Le titre de rubrique respire au-dessus comme en dessous : c'est lui
        # qui structure la lecture du dossier.
        if nouvelle_page:
            self._nouvelle_page()
        self.y += 8
        self._place(44)
        largeur = self._largeur(titre, 12)
        self.page.insert_text(((PAGE_L - largeur) / 2, self.y + 12), titre,
                              fontname=self.police_g, fontsize=12, color=ORANGE)
        self.y += 32

    def ligne(self, intitule: str, valeur: str):
        lignes = _replier(valeur, 60)
        hauteur = max(1, len(lignes)) * 14 + 8
        self._place(hauteur)
        self.page.insert_text((63, self.y + 9), intitule[:34],
                              fontname=self.police_g, fontsize=10, color=ENCRE)
        y = self.y + 9
        for l in lignes:
            self.page.insert_text((COL_VALEUR, y), l, fontname=self.police, fontsize=10, color=ENCRE)
            y += 14
        self.y += hauteur

    def puce(self, texte: str):
        lignes = _replier(texte, 76)
        hauteur = len(lignes) * 14 + 6
        self._place(hauteur)
        self.page.insert_text((X_PUCE, self.y + 9), "•", fontname=self.police, fontsize=11, color=ORANGE)
        y = self.y + 9
        for l in lignes:
            self.page.insert_text((X_TEXTE_PUCE, y), l, fontname=self.police, fontsize=10, color=ENCRE)
            y += 14
        self.y += hauteur

    def etiquette_valeur(self, etiquette: str, valeur: str, taille: float = 9.5):
        """« Rôle : » en gras, la valeur en normal, et le repli aligné dessous.

        Le modèle met l'intitulé en gras et son contenu en texte courant : tout
        passer en gras noyait l'information, tout passer en normal faisait
        disparaître le repère. La valeur reprend à la ligne sous elle-même, pas
        sous l'étiquette, pour rester lisible.
        """
        largeur_etiquette = self._largeur(etiquette, taille)
        x_valeur = MARGE_G + largeur_etiquette
        dispo_premiere = int((PAGE_L - MARGE_D - x_valeur) / (taille * 0.5))
        dispo_suite = int((PAGE_L - MARGE_D - MARGE_G) / (taille * 0.5))

        mots = str(valeur or "").split()
        premiere, reste = [], []
        largeur_courante = 0
        for i, mot in enumerate(mots):
            if not reste and largeur_courante + len(mot) + 1 <= dispo_premiere:
                premiere.append(mot)
                largeur_courante += len(mot) + 1
            else:
                reste.append(mot)

        self._place(14)
        self.page.insert_text((MARGE_G, self.y + 9), etiquette,
                              fontname=self.police_g, fontsize=taille, color=ENCRE)
        if premiere:
            self.page.insert_text((x_valeur, self.y + 9), " ".join(premiere),
                                  fontname=self.police, fontsize=taille, color=ENCRE)
        self.y += 13
        for ligne in _replier(" ".join(reste), dispo_suite):
            self._place(13)
            self.page.insert_text((MARGE_G, self.y + 9), ligne,
                                  fontname=self.police, fontsize=taille, color=ENCRE)
            self.y += 13

    def mission(self, exp: dict):
        societe = str(exp.get("company") or "").strip()
        client = str(exp.get("client") or "").strip()
        if client and client.lower() not in societe.lower():
            societe = f"{societe} – {client}" if societe else client
        periode = str(exp.get("period") or "").strip()
        poste = str(exp.get("title") or "").strip()

        # Lieu de mission (#177 ligne 17) : sur la ligne d'en-tête, à la suite
        # de la société. La borne de 58 caractères reste celle d'avant — la
        # période est posée en face, à droite, et déborder la percuterait — mais
        # la ligne entière tient dedans PAR CONSTRUCTION : le lieu est borné à
        # 24 caractères et la société prend ce qui reste. C'est donc elle qui
        # cède la place : un nom d'entreprise raccourci reste identifiable, un
        # lieu raccourci ne veut plus rien dire.
        lieu = str(exp.get("location") or "").strip()[:24]
        en_tete = f"{societe[:58 - len(lieu) - 3]} — {lieu}" if lieu else societe[:58]
        self._place(52)
        self.page.insert_text((MARGE_G, self.y + 10), en_tete,
                              fontname=self.police_g, fontsize=11, color=ORANGE)
        if periode:
            # Même orange que la société : la période fait partie de l'en-tête
            # de mission, la mettre en gris la reléguait au rang de détail.
            largeur = self._largeur(periode, 9.5)
            self.page.insert_text((PAGE_L - MARGE_D - largeur, self.y + 10), periode,
                                  fontname=self.police_g, fontsize=9.5, color=ORANGE)
        self.y += 18

        if poste:
            self.etiquette_valeur("Rôle : ", poste, taille=10)

        contexte = str(exp.get("contexte") or "").strip()
        if contexte:
            self.etiquette_valeur("Contexte : ", contexte)

        for morceau in str(exp.get("description") or "").split(" · "):
            if morceau.strip():
                self.puce(morceau.strip())

        env = str(exp.get("env_technique") or "").strip()
        if env:
            self.y += 2
            self.etiquette_valeur("Environnement technique : ", env)

        # Respiration entre deux missions : sans elle, la page devient un mur.
        self.y += 14

    def octets(self) -> BytesIO:
        flux = BytesIO()
        self.doc.save(flux)
        self.doc.close()
        flux.seek(0)
        return flux


def trigramme(nom: str) -> str:
    """
    « Sassan KHALAFI » → « SKH ».

    Première lettre du prénom, deux premières du nom. C'est l'identifiant
    utilisé sur les dossiers ADBI : il désigne le consultant sans le nommer,
    ce qui permet de diffuser le dossier avant d'avoir l'accord du candidat.
    """
    mots = [m for m in re.split(r"[\s-]+", str(nom or "").strip()) if m]
    if not mots:
        return ""
    if len(mots) == 1:
        return mots[0][:3].upper()

    prenom, patronyme = mots[0], mots[-1]
    # Beaucoup de CV écrivent « NIDHAMMOU Oussama » : le nom en capitales
    # d'abord. Sans ce contrôle, le trigramme sortait à l'envers (NOU au lieu
    # de ONI).
    if prenom.isupper() and not patronyme.isupper():
        prenom, patronyme = patronyme, prenom
    return (prenom[:1] + patronyme[:2]).upper()


def _valeur_famille(items: list) -> str:
    """
    Technologies d'une famille, bornées pour tenir en trois lignes.

    Le nombre restant est annoncé plutôt que masqué : des points de suspension
    laisseraient croire à une coupure accidentelle, alors que c'est un choix de
    mise en page — le détail complet reste dans la fiche du candidat.
    """
    propres = [str(i).strip() for i in (items or []) if str(i).strip()]
    gardes, total = [], 0
    for texte in propres[:MAX_ITEMS_FAMILLE]:
        if gardes and total + len(texte) + 2 > MAX_CARACTERES_FAMILLE:
            break
        gardes.append(texte)
        total += len(texte) + 2
    valeur = ", ".join(gardes)
    reste = len(propres) - len(gardes)
    return f"{valeur} (+{reste})" if reste > 0 else valeur


def _replier(texte: str, largeur: int) -> list:
    """Découpe un texte en lignes, sans jamais couper un mot."""
    mots = str(texte or "").split()
    lignes, courante = [], ""
    for mot in mots:
        essai = f"{courante} {mot}".strip()
        if len(essai) <= largeur:
            courante = essai
        else:
            if courante:
                lignes.append(courante)
            courante = mot
    if courante:
        lignes.append(courante)
    return lignes


def _certification(cert: dict) -> str:
    """« AWS Certified Solutions Architect — Amazon Web Services ».

    L'organisme émetteur (#177 ligne 18) est rendu par DocIE et était supprimé
    à la normalisation ; il tient sur la même ligne que le nom, les deux
    dossiers listant les certifications en « année / intitulé ». Une seule
    fonction pour le PDF et le Word : les deux exports doivent dire la même
    chose du même candidat.
    """
    nom = str(cert.get("name") or "").strip()
    organisme = str(cert.get("issuer") or "").strip()
    return f"{nom} — {organisme}" if nom and organisme else nom or organisme


# ── Entrées publiques ────────────────────────────────────────────────────────

def en_pdf(cv: dict, pastilles: list, savoir_faire: list) -> BytesIO:
    # Le dossier ne porte pas le nom du candidat mais son trigramme : c'est ce
    # qui permet de le diffuser sans révéler l'identité.
    tri = trigramme(cv.get("name"))
    titre = cv.get("title") or ""
    d = Dossier(f"{tri} {titre}".strip())

    annees = cv.get("years_experience") or 0
    d.entete(tri, titre, f"{annees} ans d’expérience" if annees else "")
    d.pastilles(pastilles)

    # Sept familles au plus : au-delà, le tableau déborde de la première page
    # et le dossier perd sa lisibilité de synthèse. Les familles suivantes
    # restent visibles dans la fiche, elles ne sont simplement pas imprimées.
    familles = [f for f in (cv.get("skills") or []) if f.get("items")][:MAX_FAMILLES]
    if familles:
        d.rubrique("Compétences techniques")
        for f in familles:
            d.ligne(str(f.get("category") or ""), _valeur_famille(f["items"]))

    if savoir_faire:
        d.rubrique("Compétences technico-fonctionnelles")
        for s in savoir_faire[:MAX_SAVOIR_FAIRE]:
            d.puce(s)

    if cv.get("education") or cv.get("certifications"):
        d.rubrique("Formations & Certifications")
        for f in (cv.get("education") or []):
            titre_f = str(f.get("title") or "")
            if f.get("subtitle"):
                titre_f += f" – {f['subtitle']}"
            d.ligne(str(f.get("period") or ""), titre_f)
        for c in (cv.get("certifications") or []):
            d.ligne(str(c.get("year") or ""), _certification(c))

    if cv.get("languages"):
        d.rubrique("Langues")
        for l in cv["languages"]:
            d.ligne(str(l.get("language") or ""), str(l.get("level") or ""))

    if cv.get("experience"):
        # Les expériences ouvrent toujours une page : c'est le cœur du dossier,
        # il ne doit pas commencer coincé sous la fin d'une autre rubrique.
        d.rubrique("Expériences professionnelles", nouvelle_page=True)
        for e in cv["experience"]:
            d.mission(e)

    return d.octets()


def en_word(cv: dict, pastilles: list, savoir_faire: list) -> BytesIO:
    """
    Même dossier, en .docx.

    Word ne sait pas tenir un positionnement absolu comme un PDF : le bandeau
    est posé dans l'en-tête de page (il se répète donc automatiquement), et le
    corps s'enchaîne normalement. Les images, les couleurs et l'ordre des
    rubriques sont ceux du modèle ; seule la géométrie fine diffère, et c'est
    le prix d'un document que le destinataire pourra modifier.
    """
    from docx import Document
    from docx.enum.table import WD_ALIGN_VERTICAL, WD_ROW_HEIGHT_RULE, WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt, RGBColor

    OR = RGBColor(0xFF, 0x66, 0x00)
    VI = RGBColor(0x70, 0x30, 0xA0)
    GR = RGBColor(0x51, 0x51, 0x51)

    doc = Document()

    # Century Gothic, comme le gabarit. Sans cela Word compose le dossier dans
    # sa police par défaut et le document ne ressemble plus au modèle ADBI —
    # le PDF, lui, embarquait déjà la bonne police. On règle le style Normal,
    # dont héritent tous les autres, et les quatre attributs de rFonts : Word
    # ignore un simple `font.name` pour une partie des caractères.
    normal = doc.styles["Normal"]
    normal.font.name, normal.font.size = "Century Gothic", Pt(10)
    rfonts = normal.element.get_or_add_rPr().get_or_add_rFonts()
    for attribut in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        rfonts.set(qn(attribut), "Century Gothic")

    section = doc.sections[0]
    section.page_width, section.page_height = Cm(21), Cm(29.7)
    section.left_margin = section.right_margin = Cm(2)
    # Les marges doivent RÉSERVER la place des bandeaux, sinon Word laisse le
    # corps du texte empiéter puis le repousse lui-même, d'où le grand vide
    # blanc en bas de page. Étirés sur 21 cm, le bandeau haut mesure 3,74 cm et
    # le bas 2,41 cm ; on ajoute de quoi loger la ligne de pied.
    section.header_distance = Cm(0)
    section.footer_distance = Cm(0)
    section.top_margin = Cm(4.1)
    section.bottom_margin = Cm(3.1)

    # Bandeau dans l'en-tête : Word le répète sur toutes les pages, comme le
    # modèle, sans qu'on ait à le replacer page par page.
    def pleine_largeur(p):
        """Sort le paragraphe des marges pour que l'image touche les bords.

        Une image de 21 cm dans une colonne de 17 cm n'est pas centrée par
        Word : elle est calée sur la marge gauche et déborde à droite, d'où la
        bande blanche de 2 cm le long du bord gauche. Un retrait négatif de la
        valeur de la marge ramène le bandeau à x = 0, comme dans le modèle.
        """
        p.paragraph_format.left_indent = Cm(-2)
        p.paragraph_format.right_indent = Cm(-2)
        p.paragraph_format.space_after = Pt(0)

    haut = _img("bandeau-1.png")
    if haut:
        p = section.header.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        pleine_largeur(p)
        p.add_run().add_picture(str(haut), width=Cm(21))

    # Pied de page : trigramme ET titre, comme sur le modèle. Il manquait
    # entièrement au Word, alors que le PDF le portait déjà.
    tri = trigramme(cv.get("name")) or "ADBI"
    pied_texte = f"{tri} {cv.get('title') or ''}".strip()
    p = section.footer.paragraphs[0]
    p.paragraph_format.space_before = Pt(0)
    r = p.add_run(pied_texte)
    r.bold, r.font.size = True, Pt(10)
    bas = _img("bandeau-2.png")
    if bas:
        q = section.footer.add_paragraph()
        q.alignment = WD_ALIGN_PARAGRAPH.CENTER
        # La vague doit affleurer les trois bords, comme dans le modèle.
        pleine_largeur(q)
        q.paragraph_format.space_before = Pt(2)
        q.add_run().add_picture(str(bas), width=Cm(21))

    def para(texte, taille=10, gras=False, couleur=None, avant=0, apres=2, centre=False):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(avant)
        p.paragraph_format.space_after = Pt(apres)
        if centre:
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(texte)
        r.font.size, r.bold = Pt(taille), gras
        if couleur:
            r.font.color.rgb = couleur
        return p

    def fond(cellule, hexa):
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:fill"), hexa)
        cellule._tc.get_or_add_tcPr().append(shd)

    # ── Identité et logo, côte à côte ──
    tete = doc.add_table(rows=1, cols=2)
    tete.autofit = False
    tete.columns[0].width, tete.columns[1].width = Cm(11), Cm(6)
    gauche, droite = tete.rows[0].cells
    gauche.paragraphs[0].text = ""
    r = gauche.paragraphs[0].add_run(trigramme(cv.get("name")) or "ADBI")
    r.bold, r.font.size, r.font.color.rgb = True, Pt(16), OR
    if cv.get("title"):
        # Même règle que le PDF : un intitulé long est composé plus petit pour
        # tenir sur deux lignes. En corps fixe, Century Gothic — plus large que
        # la police par défaut — le faisait déborder sur une troisième.
        r = gauche.add_paragraph().add_run(cv["title"])
        r.bold, r.font.color.rgb = True, GR
        r.font.size = Pt(15) if len(cv["title"]) <= 30 else Pt(12)
    if cv.get("years_experience"):
        r = gauche.add_paragraph().add_run(f"{cv['years_experience']} ans d’expérience")
        r.bold, r.font.size, r.font.color.rgb = True, Pt(10), VI
    logo = _img("logo-adbi.png")
    if logo:
        droite.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT
        droite.paragraphs[0].add_run().add_picture(str(logo), width=Cm(5.4))

    # ── Pastilles ──
    # Quatre PASTILLES distinctes, séparées par du blanc — et non une barre
    # orange continue. On intercale donc des colonnes vides entre les colonnes
    # pleines : deux cellules colorées mitoyennes formeraient un seul aplat,
    # et c'est bien ce qui se produisait.
    if pastilles:
        t = doc.add_table(rows=1, cols=2 * len(pastilles) - 1)
        t.alignment = WD_TABLE_ALIGNMENT.CENTER
        t.autofit = False

        bordures = OxmlElement("w:tblBorders")
        for cote in ("top", "left", "bottom", "right", "insideH", "insideV"):
            b = OxmlElement(f"w:{cote}")
            b.set(qn("w:val"), "nil")
            bordures.append(b)
        t._tbl.tblPr.append(bordures)

        # 17 cm de largeur utile, moins les gouttières, partagés à parts égales.
        GOUTTIERE = Cm(0.36)
        largeur = Cm((17 - 0.36 * (len(pastilles) - 1)) / len(pastilles))

        # Hauteur fixe et texte centré verticalement : sans cela, l'intitulé se
        # colle au bord supérieur et laisse un vide orange en dessous.
        t.rows[0].height = Cm(0.85)
        t.rows[0].height_rule = WD_ROW_HEIGHT_RULE.EXACTLY
        for i, cell in enumerate(t.rows[0].cells):
            vide = i % 2 == 1                       # colonne d'écartement
            cell.width = GOUTTIERE if vide else largeur
            if vide:
                continue
            fond(cell, "FF6600")
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.space_before = p.paragraph_format.space_after = Pt(0)
            r = p.add_run(pastilles[i // 2])
            r.bold, r.font.size, r.font.color.rgb = True, Pt(10), RGBColor(0xFF, 0xFF, 0xFF)

    def rubrique(titre):
        para(titre, taille=12, gras=True, couleur=OR, avant=12, apres=6, centre=True)

    def duo(intitule, valeur):
        t = doc.add_table(rows=1, cols=2)
        t.autofit = False
        t.columns[0].width, t.columns[1].width = Cm(4.7), Cm(12.3)
        a, b = t.rows[0].cells
        ra = a.paragraphs[0].add_run(str(intitule or ""))
        ra.bold, ra.font.size = True, Pt(10)
        rb = b.paragraphs[0].add_run(str(valeur or ""))
        rb.font.size = Pt(10)

    familles = [f for f in (cv.get("skills") or []) if f.get("items")][:MAX_FAMILLES]
    if familles:
        rubrique("Compétences techniques")
        for f in familles:
            duo(f.get("category"), _valeur_famille(f["items"]))

    if savoir_faire:
        rubrique("Compétences technico-fonctionnelles")
        for s in savoir_faire[:MAX_SAVOIR_FAIRE]:
            p = doc.add_paragraph(style="List Bullet")
            p.paragraph_format.space_after = Pt(2)
            p.add_run(s).font.size = Pt(10)

    if cv.get("education") or cv.get("certifications"):
        rubrique("Formations & Certifications")
        for f in (cv.get("education") or []):
            titre_f = str(f.get("title") or "")
            if f.get("subtitle"):
                titre_f += f" – {f['subtitle']}"
            duo(f.get("period"), titre_f)
        for c in (cv.get("certifications") or []):
            duo(c.get("year"), _certification(c))

    if cv.get("languages"):
        rubrique("Langues")
        for l in cv["languages"]:
            duo(l.get("language"), l.get("level"))

    if cv.get("experience"):
        # Saut de page avant les expériences, comme dans le PDF.
        from docx.enum.text import WD_BREAK
        doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
        rubrique("Expériences professionnelles")
        for e in cv["experience"]:
            societe = str(e.get("company") or "").strip()
            client = str(e.get("client") or "").strip()
            if client and client.lower() not in societe.lower():
                societe = f"{societe} – {client}" if societe else client
            # Lieu de mission (#177 ligne 17), comme dans le PDF. Pas de borne
            # ici : le Word replie la ligne, il n'a rien à percuter.
            lieu = str(e.get("location") or "").strip()
            if lieu:
                societe = f"{societe} — {lieu}" if societe else lieu
            p = doc.add_paragraph()
            p.paragraph_format.space_before, p.paragraph_format.space_after = Pt(14), Pt(2)
            r = p.add_run(societe)
            r.bold, r.font.size, r.font.color.rgb = True, Pt(11), OR
            if e.get("period"):
                # Même orange que la société : la période appartient à
                # l'en-tête de mission, pas aux détails.
                r = p.add_run(f"\t{e['period']}")
                r.bold, r.font.size, r.font.color.rgb = True, Pt(9.5), OR

            def champ(etiquette, valeur):
                """Intitulé en gras, contenu en texte courant."""
                q = doc.add_paragraph()
                q.paragraph_format.space_after = Pt(2)
                r = q.add_run(etiquette)
                r.bold, r.font.size = True, Pt(9.5)
                r2 = q.add_run(str(valeur))
                r2.font.size = Pt(9.5)

            if e.get("title"):
                champ("Rôle : ", e["title"])
            if e.get("contexte"):
                champ("Contexte : ", e["contexte"])
            for morceau in str(e.get("description") or "").split(" · "):
                if morceau.strip():
                    p = doc.add_paragraph(style="List Bullet")
                    p.paragraph_format.space_after = Pt(3)
                    p.add_run(morceau.strip()).font.size = Pt(9.5)
            if e.get("env_technique"):
                champ("Environnement technique : ", e["env_technique"])

    flux = BytesIO()
    doc.save(flux)
    flux.seek(0)
    return flux


def nom_fichier(cv: dict, extension: str) -> str:
    nom = re.sub(r"[^\w\s-]", "", cv.get("name") or "Candidat").strip() or "Candidat"
    return f"ADBI CV_{nom}{extension}"

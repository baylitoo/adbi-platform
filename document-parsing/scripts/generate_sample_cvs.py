#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""generate_sample_cvs.py -- produces the synthetic CV fixtures used by
compare_pipelines.py to compare cv-parser's real extraction path against a
real DocIE Studio /v1/studio/extract run.

Three fictional (invented names, no real person) French CVs, born-digital
PDFs built with PyMuPDF (fitz) -- a real text layer, not an image, so both
pipelines see an ordinary digital CV:

  1. cv_simple.pdf   -- clean, 1 page, 2 jobs, minimal env_technique.
  2. cv_dense.pdf    -- 4 jobs, an explicit "Environnement technique : ..."
                        line on every job -- this is the field the ADBI
                        matching algorithm weighs highest, so it gets the
                        densest coverage here.
  3. cv_scanned.pdf  -- SAME content as cv_dense, but rasterized to a page
                        image and re-embedded with NO text layer, to force
                        cv-parser's Docling/OCR fallback path
                        (docling_used=True) and DocIE's OCR backend instead
                        of a plain pdf-text extraction on both sides.

Usage:
    python generate_sample_cvs.py [output_dir]
    (default output_dir: document-parsing/fixtures/cv_samples)
"""
from __future__ import annotations

import sys
from pathlib import Path

import fitz  # PyMuPDF

FIXTURES_DIR = Path(__file__).parent.parent / "fixtures" / "cv_samples"

PAGE_W, PAGE_H = 595, 842  # A4 in points
MARGIN = 50


def _draw_cv(page: "fitz.Page", name: str, title: str, contact_line: str, body_blocks: list[tuple[str, str]]) -> None:
    """body_blocks: list of (heading, text) pairs, rendered top to bottom."""
    y = MARGIN
    page.insert_text((MARGIN, y + 18), name, fontsize=20, fontname="helv", color=(0.1, 0.1, 0.3))
    y += 28
    page.insert_text((MARGIN, y + 14), title, fontsize=13, fontname="helv", color=(0.2, 0.2, 0.2))
    y += 22
    page.insert_text((MARGIN, y + 12), contact_line, fontsize=9, fontname="helv", color=(0.3, 0.3, 0.3))
    y += 30

    for heading, text in body_blocks:
        page.insert_text((MARGIN, y + 12), heading, fontsize=12, fontname="helv", color=(0.05, 0.05, 0.05))
        y += 18
        rect = fitz.Rect(MARGIN, y, PAGE_W - MARGIN, PAGE_H - MARGIN)
        used = page.insert_textbox(rect, text, fontsize=9.5, fontname="helv", color=(0, 0, 0), lineheight=1.35)
        # insert_textbox returns the remaining (unfilled) height as a negative
        # number is not what this version returns; recompute from line count.
        n_lines = text.count("\n") + 1
        y += n_lines * 9.5 * 1.35 + 10


CV_SIMPLE = dict(
    name="Camille Béranger",
    title="Développeuse Full-Stack",
    contact="camille.beranger@example.fr | 06 12 34 56 78 | Lyon, France",
    blocks=[
        ("EXPERIENCE PROFESSIONNELLE",
         "Développeuse Full-Stack -- Numelia (Lyon)\n"
         "Mars 2022 - Aujourd'hui\n"
         "Conception et développement d'une plateforme SaaS de gestion de stocks pour PME. "
         "Mise en place de l'API REST et du frontend React.\n"
         "Environnement technique : Python, Django, PostgreSQL, React, Docker\n"
         "\n"
         "Développeuse Web -- Studio Pixelia (Lyon)\n"
         "Septembre 2019 - Février 2022\n"
         "Développement de sites vitrines et e-commerce pour des clients locaux. "
         "Intégration HTML/CSS et scripts JavaScript."),
        ("FORMATION",
         "Master Informatique -- Université Claude Bernard Lyon 1, 2019"),
        ("COMPETENCES",
         "Langages : Python, JavaScript, SQL\n"
         "Frameworks : Django, React, Node.js\n"
         "Outils : Docker, Git, Jenkins"),
        ("LANGUES",
         "Français : natif\n"
         "Anglais : courant"),
    ],
)

CV_DENSE = dict(
    name="Thomas Verrier",
    title="Ingénieur DevOps / Lead Backend",
    contact="thomas.verrier@example.fr | 07 89 12 34 56 | Nantes, France | linkedin.com/in/thomas-verrier-dev",
    blocks=[
        ("EXPERIENCE PROFESSIONNELLE",
         "Lead Backend Engineer -- Oxantis (Nantes)\n"
         "Janvier 2023 - Aujourd'hui\n"
         "Pilotage technique d'une équipe de 5 développeurs sur la refonte de la plateforme de "
         "facturation. Migration progressive d'un monolithe PHP vers des microservices. Mise en "
         "place du CI/CD et de l'observabilité.\n"
         "Environnement technique : Python, FastAPI, PostgreSQL, Kafka, Docker, Kubernetes, "
         "Terraform, Prometheus, Grafana, GitLab CI\n"
         "\n"
         "Ingénieur DevOps -- Cargium Solutions (Nantes)\n"
         "Juin 2020 - Décembre 2022\n"
         "Industrialisation des déploiements pour une plateforme logistique multi-tenant. Mise en "
         "place d'une infrastructure as code sur AWS et automatisation des tests d'intégration.\n"
         "Environnement technique : AWS (EC2, S3, RDS, Lambda), Terraform, Ansible, Jenkins, "
         "Python, Bash, Docker\n"
         "\n"
         "Développeur Backend -- Ideloop (Rennes)\n"
         "Septembre 2018 - Mai 2020\n"
         "Développement d'APIs pour une application mobile de covoiturage. Intégration de paiement "
         "et de géolocalisation.\n"
         "Environnement technique : Node.js, Express, MongoDB, Redis, Stripe API, Google Maps API\n"
         "\n"
         "Développeur Full-Stack -- Webnova (Rennes)\n"
         "Septembre 2016 - Août 2018\n"
         "Développement de sites web sur mesure pour des clients PME, du cahier des charges à la "
         "mise en production.\n"
         "Environnement technique : PHP, Symfony, MySQL, jQuery, Bootstrap"),
        ("FORMATION",
         "Diplôme d'Ingénieur, spécialité Informatique -- INSA Rennes, 2016\n"
         "Licence Informatique -- Université Rennes 1, 2013"),
        ("COMPETENCES",
         "Cloud et Infra : AWS, Docker, Kubernetes, Terraform, Ansible\n"
         "Langages : Python, PHP, JavaScript, Bash\n"
         "Bases de données : PostgreSQL, MySQL, MongoDB, Redis\n"
         "CI/CD et Monitoring : GitLab CI, Jenkins, Prometheus, Grafana"),
        ("LANGUES",
         "Français : natif\n"
         "Anglais : courant\n"
         "Espagnol : notions"),
    ],
)


def build_pdf(spec: dict, out_path: Path) -> None:
    doc = fitz.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    _draw_cv(page, spec["name"], spec["title"], spec["contact"], spec["blocks"])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out_path))
    doc.close()
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")


def build_scanned_pdf(source_pdf: Path, out_path: Path, dpi: int = 150) -> None:
    """Rasterize source_pdf's one page to a JPEG and re-embed it with NO text
    layer -- a synthetic stand-in for a scanned CV, to exercise the OCR path
    on both pipelines (cv-parser's Docling fallback, DocIE's OCR backend).
    Grayscale + JPEG keeps the fixture small enough to commit (a raw PNG at
    200 DPI came out at ~11 MB; this is ~150-250 KB)."""
    src = fitz.open(str(source_pdf))
    page = src[0]
    zoom = dpi / 72.0
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY)
    img_bytes = pix.tobytes("jpg", jpg_quality=82)
    src.close()

    doc = fitz.open()
    new_page = doc.new_page(width=PAGE_W, height=PAGE_H)
    new_page.insert_image(fitz.Rect(0, 0, PAGE_W, PAGE_H), stream=img_bytes)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out_path), garbage=4, deflate=True)
    doc.close()
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes) -- image-only, no text layer")


def main() -> int:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else FIXTURES_DIR
    simple_path = out_dir / "cv_simple.pdf"
    dense_path = out_dir / "cv_dense.pdf"
    scanned_path = out_dir / "cv_scanned.pdf"

    build_pdf(CV_SIMPLE, simple_path)
    build_pdf(CV_DENSE, dense_path)
    build_scanned_pdf(dense_path, scanned_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())

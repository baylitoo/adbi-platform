#!/bin/sh
# Exécuté une seule fois, au tout premier démarrage du conteneur postgres
# (volume postgres-data vide) — l'image officielle lance tout script de
# /docker-entrypoint-initdb.d/ dans cet état, avec POSTGRES_USER déjà créé.
#
# Une base par service plutôt qu'une base partagée avec des schémas : isolation
# plus simple (permissions, sauvegarde/restauration indépendantes par service),
# et un service ne peut pas accidentellement lire/écrire les tables d'un autre.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE adbi_contrats;
    CREATE DATABASE adbi_cv_parser;
    CREATE DATABASE adbi_one_pager;
EOSQL

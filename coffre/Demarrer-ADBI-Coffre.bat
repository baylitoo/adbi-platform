@echo off
REM ============================================================
REM   ADBI Coffre - chiffrement local de documents
REM   Double-cliquez sur ce fichier (ou passez par ADBI Factory)
REM ============================================================
chcp 65001 >nul
title ADBI Coffre
cd /d "%~dp0"

echo.
echo   ADBI Coffre
echo   -----------
echo.

REM --- Choix du moteur Node ---------------------------------------------
REM Un eventuel paquet portable embarque son propre node.exe : il est
REM prioritaire, ce qui garantit un fonctionnement identique d'un poste
REM a l'autre, meme si Node est absent ou dans une version differente.
set "NODE_EXE="
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"

if not defined NODE_EXE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=node"
)

if not defined NODE_EXE (
  echo   [ERREUR] Node.js est introuvable sur ce poste.
  echo   Installez Node.js LTS depuis https://nodejs.org
  echo.
  pause
  exit /b 1
)

REM --- Aucune dependance npm : rien a installer -------------------------

REM --- Ouvrir le navigateur des que le serveur est pret (sans bloquer) ---
start "" cmd /c "timeout /t 2 >nul & start http://localhost:4300"

echo   Serveur demarre sur http://localhost:4300
echo   Le navigateur va s'ouvrir automatiquement.
echo.
echo   ^>^>^> Laissez cette fenetre OUVERTE pendant l'utilisation. ^<^<^<
echo   ^>^>^> Fermez-la pour arreter l'outil.                       ^<^<^<
echo.

REM --- Demarrer le serveur (bloquant : garde la console et ses logs visibles)
"%NODE_EXE%" server.js

echo.
echo   Le serveur s'est arrete.
pause

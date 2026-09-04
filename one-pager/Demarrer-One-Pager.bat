@echo off
REM ============================================================
REM   One pager - generateur de dossiers de competences ADBI
REM   Double-cliquez sur ce fichier (ou sur le raccourci bureau)
REM ============================================================
chcp 65001 >nul
title One pager - ADBI
cd /d "%~dp0"

echo.
echo   One pager
echo   ---------
echo.

REM --- Choix du moteur Node ---------------------------------------------
REM Le paquet portable embarque son propre node.exe : il est prioritaire,
REM ce qui garantit un fonctionnement identique d'un poste a l'autre, meme
REM si Node est absent ou dans une version differente.
set "NODE_EXE="
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"

if not defined NODE_EXE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=node"
)

if not defined NODE_EXE (
  echo   [ERREUR] Node.js est introuvable sur ce poste, et ce dossier
  echo   ne contient pas de moteur embarque ^(runtime\node.exe^).
  echo.
  echo   Deux solutions :
  echo     - utilisez le paquet "One-pager-portable" fourni par ADBI ;
  echo     - ou installez Node.js LTS depuis https://nodejs.org
  echo.
  pause
  exit /b 1
)

REM --- Installer les dependances si elles manquent ----------------------
if not exist "node_modules\express" (
  echo   Premiere utilisation : installation des dependances...
  echo   ^(cela peut prendre une minute, une seule fois^)
  echo.
  call npm install
  if errorlevel 1 (
    echo   [ERREUR] L'installation des dependances a echoue.
    echo   Si ce poste n'a pas d'acces Internet, utilisez le paquet portable.
    pause
    exit /b 1
  )
  echo.
)

REM --- Ouvrir le navigateur des que le serveur est pret (sans bloquer) ---
start "" cmd /c "timeout /t 3 >nul & start http://localhost:4200"

echo   Serveur demarre sur http://localhost:4200
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

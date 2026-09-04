@echo off
REM ============================================================
REM   ADBI - Generateur de contrats   (lanceur Windows)
REM   Double-cliquez sur ce fichier (ou sur le raccourci bureau)
REM ============================================================
chcp 65001 >nul
title ADBI - Generateur de contrats
cd /d "%~dp0"

echo.
echo   ADBI - Generateur de contrats
echo   ------------------------------
echo.

REM --- Verifier que Node.js est installe ---
where node >nul 2>nul
if errorlevel 1 (
  echo   [ERREUR] Node.js est introuvable sur ce poste.
  echo   Installez Node.js ^(version LTS^) depuis https://nodejs.org puis relancez.
  echo.
  pause
  exit /b 1
)

REM --- Installer les dependances si elles manquent ---
if not exist "node_modules\express" (
  echo   Premiere utilisation : installation des dependances...
  echo   ^(cela peut prendre une minute, une seule fois^)
  echo.
  call npm install
  if errorlevel 1 (
    echo   [ERREUR] L'installation des dependances a echoue.
    pause
    exit /b 1
  )
  echo.
)

REM --- Ouvrir le navigateur des que le serveur est pret (sans bloquer) ---
start "" cmd /c "timeout /t 3 >nul & start http://localhost:4100"

echo   Serveur demarre sur http://localhost:4100
echo   Le navigateur va s'ouvrir automatiquement.
echo.
echo   >>> Laissez cette fenetre OUVERTE pendant l'utilisation. <<<
echo   >>> Fermez-la pour arreter l'outil.                       <<<
echo.

REM --- Demarrer le serveur (bloquant : garde la console et ses logs visibles) ---
node server.js

echo.
echo   Le serveur s'est arrete.
pause

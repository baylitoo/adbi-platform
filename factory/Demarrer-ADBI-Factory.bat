@echo off
REM ============================================================
REM   ADBI Factory - plateforme des outils internes ADBI
REM   Double-cliquez sur ce fichier (ou sur le raccourci bureau)
REM ============================================================
chcp 65001 >nul
title ADBI Factory
cd /d "%~dp0"

echo.
echo   ADBI Factory
echo   ------------
echo.

REM --- Choix du moteur Node ---------------------------------------------
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

REM --- Ouvrir le navigateur des que le serveur est pret (sans bloquer) ---
start "" cmd /c "timeout /t 2 >nul & start http://localhost:4000"

echo   Plateforme demarree sur http://localhost:4000
echo   Le navigateur va s'ouvrir automatiquement.
echo.
echo   Les modules (One pager, Contrats) sont lances automatiquement
echo   au premier clic sur leur tuile.
echo.
echo   ^>^>^> Laissez cette fenetre OUVERTE pendant l'utilisation. ^<^<^<
echo   ^>^>^> Fermez-la pour tout arreter.                          ^<^<^<
echo.

REM --- Demarrer la Factory (bloquant : garde la console et ses logs visibles)
"%NODE_EXE%" server.js

echo.
echo   La plateforme s'est arretee.
pause

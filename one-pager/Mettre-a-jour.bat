@echo off
REM ============================================================
REM   One pager - application d'une mise a jour
REM
REM   A lancer depuis le dossier decompresse de la mise a jour.
REM   Ne touche NI a la base de CV, NI au moteur Node, NI aux
REM   dependances : seuls les fichiers du programme sont remplaces.
REM ============================================================
chcp 65001 >nul
title One pager - mise a jour
cd /d "%~dp0"

echo.
echo   One pager - mise a jour
echo   -----------------------
echo.

REM --- Retrouver l'installation via le raccourci du Bureau --------------
set "CIBLE="
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command ^
  "$d=[Environment]::GetFolderPath('Desktop'); $l=Join-Path $d 'One pager.lnk'; if(Test-Path $l){(New-Object -ComObject WScript.Shell).CreateShortcut($l).WorkingDirectory}"`) do set "CIBLE=%%D"

if defined CIBLE (
  echo   Installation detectee :
  echo     %CIBLE%
  echo.
) else (
  echo   Le raccourci du Bureau est introuvable.
)

REM --- Verifier, ou demander le chemin ---------------------------------
:demander
if not defined CIBLE (
  echo   Indiquez le dossier de One pager ^(celui qui contient server.js^) :
  set /p "CIBLE=  > "
)

if not exist "%CIBLE%\server.js" (
  echo.
  echo   [ERREUR] "%CIBLE%" ne contient pas server.js.
  echo   Ce n'est pas le dossier de l'application.
  echo.
  set "CIBLE="
  goto demander
)

REM --- L'application doit etre fermee -----------------------------------
tasklist /fi "imagename eq node.exe" 2>nul | find /i "node.exe" >nul
if not errorlevel 1 (
  echo   [ATTENTION] One pager semble encore ouvert.
  echo   Fermez la fenetre noire de l'application, puis appuyez sur une touche.
  echo.
  pause >nul
)

REM --- Copie des fichiers du programme ----------------------------------
echo   Mise a jour des fichiers...
for %%F in (server.js package.json LISEZ-MOI.txt VERSION.txt) do (
  if exist "%%F" copy /y "%%F" "%CIBLE%\" >nul
)
for %%D in (lib public scripts) do (
  if exist "%%D" xcopy "%%D" "%CIBLE%\%%D\" /e /i /y /q >nul
)

if errorlevel 1 (
  echo.
  echo   [ERREUR] La copie a echoue. Le dossier est-il en lecture seule ?
  pause
  exit /b 1
)

echo.
echo   Mise a jour terminee.
if exist "VERSION.txt" (
  echo   Version installee :
  type "VERSION.txt"
)
echo.
echo   Vos CV enregistres n'ont pas ete touches.
echo   Relancez l'application par l'icone "One pager" du Bureau.
echo.
pause

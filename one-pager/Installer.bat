@echo off
REM ============================================================
REM   ONE PAGER - INSTALLATION
REM
REM   Double-cliquez sur ce fichier. C'est tout.
REM
REM   Il verifie que le poste a tout ce qu'il faut, installe ou
REM   repare ce qui manque, cree l'icone sur le Bureau, puis
REM   demarre l'outil.
REM ============================================================
chcp 65001 >nul
title One pager - installation
cd /d "%~dp0"

REM -ExecutionPolicy Bypass : evite le blocage des scripts PowerShell,
REM frequent sur les postes d'entreprise. La portee est limitee a ce
REM seul appel, la configuration du poste n'est pas modifiee.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Installer.ps1"

if errorlevel 1 (
  echo.
  echo   L'installation s'est interrompue. Lisez le message ci-dessus.
  echo.
  pause
)

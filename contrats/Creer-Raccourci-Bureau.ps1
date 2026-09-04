# ============================================================
#   ADBI - Generateur de contrats
#   Cree un raccourci sur le Bureau avec l'icone ADBI.
#   Clic droit sur ce fichier > "Executer avec PowerShell"
# ============================================================

$ErrorActionPreference = "Stop"

# Dossier ou se trouve ce script (= racine du projet)
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition

$bat  = Join-Path $here "Demarrer-ADBI-Contrats.bat"
$icon = Join-Path $here "icone.ico"

if (-not (Test-Path $bat)) {
    Write-Host "[ERREUR] Introuvable : $bat" -ForegroundColor Red
    Read-Host "Appuyez sur Entree pour fermer"
    exit 1
}

$desktop = [Environment]::GetFolderPath("Desktop")
$linkPath = Join-Path $desktop "ADBI - Contrats.lnk"

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($linkPath)
$sc.TargetPath       = $bat
$sc.WorkingDirectory = $here
$sc.Description       = "ADBI - Generateur de contrats (local, port 4100)"
if (Test-Path $icon) { $sc.IconLocation = $icon }
$sc.WindowStyle      = 1
$sc.Save()

Write-Host ""
Write-Host "  Raccourci cree sur le Bureau : 'ADBI - Contrats'" -ForegroundColor Green
Write-Host "  Double-cliquez dessus pour lancer l'outil."
Write-Host ""
Read-Host "Appuyez sur Entree pour fermer"

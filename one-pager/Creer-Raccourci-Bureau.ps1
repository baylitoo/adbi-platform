# ============================================================
#   One pager
#   Cree le raccourci « One pager » sur le Bureau, avec son icone.
#   Clic droit sur ce fichier > « Executer avec PowerShell »
# ============================================================

$ErrorActionPreference = "Stop"

# Dossier ou se trouve ce script (= racine du projet)
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition

$bat  = Join-Path $here "Demarrer-One-Pager.bat"
$icon = Join-Path $here "icone.ico"

if (-not (Test-Path $bat)) {
    Write-Host "[ERREUR] Introuvable : $bat" -ForegroundColor Red
    Read-Host "Appuyez sur Entree pour fermer"
    exit 1
}

# L'icone est regeneree si elle manque (aucune dependance externe requise).
if (-not (Test-Path $icon)) {
    $maker = Join-Path $here "scripts\make-icon.js"
    if (Test-Path $maker) { & node $maker | Out-Null }
}

$desktop  = [Environment]::GetFolderPath("Desktop")
$linkPath = Join-Path $desktop "One pager.lnk"

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($linkPath)
$sc.TargetPath       = $bat
$sc.WorkingDirectory = $here
$sc.Description      = "One pager - generateur de dossiers de competences (local, port 4200)"
if (Test-Path $icon) { $sc.IconLocation = "$icon,0" }
$sc.WindowStyle      = 1
$sc.Save()

Write-Host ""
Write-Host "  Raccourci cree sur le Bureau : 'One pager'" -ForegroundColor Green
Write-Host "  Double-cliquez dessus pour lancer l'outil."
Write-Host ""
Read-Host "Appuyez sur Entree pour fermer"

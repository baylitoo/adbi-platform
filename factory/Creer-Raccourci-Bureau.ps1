# ============================================================
#   ADBI Factory
#   Cree le raccourci « ADBI Factory » sur le Bureau, avec son icone.
#   Clic droit sur ce fichier > « Executer avec PowerShell »
# ============================================================

$ErrorActionPreference = "Stop"

# Dossier ou se trouve ce script (= racine du projet)
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition

$bat  = Join-Path $here "Demarrer-ADBI-Factory.bat"
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
$linkPath = Join-Path $desktop "ADBI Factory.lnk"

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($linkPath)
$sc.TargetPath       = $bat
$sc.WorkingDirectory = $here
$sc.Description      = "ADBI Factory - plateforme des outils internes ADBI (local, port 4000)"
if (Test-Path $icon) { $sc.IconLocation = "$icon,0" }
$sc.WindowStyle      = 1
$sc.Save()

Write-Host ""
Write-Host "  Raccourci cree sur le Bureau : 'ADBI Factory'" -ForegroundColor Green
Write-Host "  Double-cliquez dessus pour lancer la plateforme."
Write-Host ""
Read-Host "Appuyez sur Entree pour fermer"

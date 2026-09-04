# ============================================================
#   One pager — fabrication du paquet de MISE A JOUR
#
#   Produit "One-pager-mise-a-jour.zip" : uniquement le
#   programme (lib, public, server.js). Ni node_modules, ni
#   moteur Node, ni base de CV — donc quelques Mo au lieu de 68,
#   et aucun risque pour les donnees deja saisies sur le poste.
#
#   A n'utiliser que si les dependances n'ont pas change.
#   Sinon : Preparer-le-partage.ps1 (paquet complet).
#
#   Clic droit sur ce fichier > "Executer avec PowerShell"
# ============================================================

param([switch]$Auto)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host ""
Write-Host "  Fabrication du paquet de mise a jour" -ForegroundColor Cyan
Write-Host "  ------------------------------------"
Write-Host ""

$version = (Get-Content (Join-Path $here "package.json") -Raw | ConvertFrom-Json).version

# --- Garde-fou : une dependance ajoutee rend ce paquet insuffisant ------
# Le poste destinataire ne relancera pas npm install : si package.json
# reclame un paquet qu'il n'a pas, l'application ne demarrera plus.
$deps = (Get-Content (Join-Path $here "package.json") -Raw | ConvertFrom-Json).dependencies
foreach ($d in $deps.PSObject.Properties.Name) {
    if (-not (Test-Path (Join-Path $here "node_modules\$d"))) {
        Write-Host "  [ERREUR] La dependance '$d' n'est pas installee ici." -ForegroundColor Red
        Write-Host "  Lancez 'npm install', puis recommencez."
        if (-not $Auto) { Read-Host "Appuyez sur Entree pour fermer" }
        exit 1
    }
}

$stage = Join-Path $env:TEMP ("one-pager-maj-" + (Get-Random))
$zip   = Join-Path $here "One-pager-mise-a-jour.zip"
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# Le programme, et rien d'autre.
$aCopier = @("server.js", "package.json", "lib", "public", "scripts", "LISEZ-MOI.txt", "Mettre-a-jour.bat")

foreach ($item in $aCopier) {
    $src = Join-Path $here $item
    if (Test-Path $src) { Copy-Item $src -Destination $stage -Recurse -Force }
}

# --- Trace de version, lisible par le destinataire ---------------------
# Encodage ASCII, sans BOM : ce fichier est affiche par « type » dans une
# console cmd, ou un BOM apparaitrait comme un caractere parasite.
$maj = "One pager - version $version`r`nMise a jour du $(Get-Date -Format 'dd/MM/yyyy - HH:mm')"
$maj | Out-File (Join-Path $stage "VERSION.txt") -Encoding ascii

$notice = @"
MISE A JOUR DE ONE PAGER — version $version

1. Fermez l'application si elle est ouverte
   (la fenetre noire "One pager").

2. Double-cliquez sur "Mettre-a-jour.bat".
   Il retrouve tout seul votre installation grace au
   raccourci du Bureau, et remplace les fichiers du
   programme.

3. Relancez par l'icone "One pager" du Bureau.

Vos CV enregistres ne sont PAS touches : la mise a jour
ne contient aucune donnee et ne remplace que le programme.

Si le script ne trouve pas l'installation, il vous demande
le dossier : indiquez celui qui contient "server.js".
"@
$notice | Out-File (Join-Path $stage "LISEZ-MOI-MISE-A-JOUR.txt") -Encoding utf8

# --- Garde-fou : aucune donnee personnelle dans l'archive ---------------
$fuite = Get-ChildItem $stage -Recurse -Include "*.sqlite", "*.log" -ErrorAction SilentlyContinue
if ($fuite) {
    Write-Host "  [ERREUR] Le paquet contient des donnees : $($fuite.Name -join ', ')" -ForegroundColor Red
    Remove-Item $stage -Recurse -Force
    if (-not $Auto) { Read-Host "Appuyez sur Entree pour fermer" }
    exit 1
}

Write-Host "  Compression..."
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

$taille = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ""
Write-Host "  Paquet pret : $zip" -ForegroundColor Green
Write-Host "  Version $version   |   Taille : $taille Mo"
Write-Host ""
Write-Host "  A transmettre au collegue. Sur son poste :" -ForegroundColor Cyan
Write-Host "    1. fermer One pager"
Write-Host "    2. decompresser le ZIP n'importe ou"
Write-Host "    3. double-clic sur Mettre-a-jour.bat"
Write-Host ""
Write-Host "  Ses CV enregistres sont conserves."
Write-Host ""
if (-not $Auto) { Read-Host "Appuyez sur Entree pour fermer" }

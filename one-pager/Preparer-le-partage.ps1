# ============================================================
#   One pager — fabrication du paquet portable
#
#   Produit "One-pager-portable.zip" : l'application, ses
#   dependances ET un node.exe embarque. Le poste destinataire
#   n'a besoin de RIEN — ni Node, ni droits admin, ni Internet.
#
#   Clic droit sur ce fichier > "Executer avec PowerShell"
# ============================================================

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host ""
Write-Host "  Fabrication du paquet portable One pager" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"
Write-Host ""

# --- Verifications prealables ------------------------------------------
if (-not (Test-Path (Join-Path $here "node_modules\express"))) {
    Write-Host "  [ERREUR] node_modules est absent." -ForegroundColor Red
    Write-Host "  Lancez d'abord 'npm install' dans ce dossier."
    Read-Host "Appuyez sur Entree pour fermer"
    exit 1
}

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
    Write-Host "  [ERREUR] node.exe introuvable : impossible de l'embarquer." -ForegroundColor Red
    Read-Host "Appuyez sur Entree pour fermer"
    exit 1
}

# --- Dossier de travail ------------------------------------------------
$stage = Join-Path $env:TEMP ("one-pager-portable-" + (Get-Random))
$zip   = Join-Path $here "One-pager-portable.zip"
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# Ce qui part dans le paquet. « data » en est volontairement ABSENT :
# il contient les CV importes, donc des donnees personnelles de candidats,
# qui n'ont rien a faire sur le poste d'un collegue.
$aCopier = @(
    "server.js", "package.json", "package-lock.json",
    "Installer.bat", "Demarrer-One-Pager.bat", "Creer-Raccourci-Bureau.ps1",
    "icone.ico", "LISEZ-MOI.txt",
    "lib", "public", "scripts", "node_modules"
)

Write-Host "  Copie des fichiers..."
foreach ($item in $aCopier) {
    $src = Join-Path $here $item
    if (Test-Path $src) {
        Copy-Item $src -Destination $stage -Recurse -Force
    }
}

# --- Moteur Node embarque ----------------------------------------------
Write-Host "  Copie du moteur Node ($((Get-Item $nodeExe).Length / 1MB -as [int]) Mo)..."
$runtime = Join-Path $stage "runtime"
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Copy-Item $nodeExe -Destination $runtime -Force

# La version embarquee est tracee : utile pour savoir quand la rafraichir.
$version = (& $nodeExe -v)
"Moteur Node embarque : $version`r`nCopie le : $(Get-Date -Format 'dd/MM/yyyy')" |
    Out-File (Join-Path $runtime "VERSION.txt") -Encoding utf8

# --- Base vide, prete a l'emploi ---------------------------------------
New-Item -ItemType Directory -Path (Join-Path $stage "data") -Force | Out-Null
"" | Out-File (Join-Path $stage "data\.gitkeep") -Encoding utf8

# --- Menage : rien d'inutile ni de personnel dans l'archive -------------
foreach ($rebut in @("data\cvs.sqlite", "_out.log", "_err.log", ".claude", "One-pager-portable.zip")) {
    $c = Join-Path $stage $rebut
    if (Test-Path $c) { Remove-Item $c -Recurse -Force }
}

# Garde-fou : on refuse de livrer une archive contenant des CV.
if (Test-Path (Join-Path $stage "data\cvs.sqlite")) {
    Write-Host "  [ERREUR] La base de CV est encore presente. Paquet annule." -ForegroundColor Red
    Remove-Item $stage -Recurse -Force
    Read-Host "Appuyez sur Entree pour fermer"
    exit 1
}

# --- Mode d'emploi du destinataire -------------------------------------
$lisezMoi = Join-Path $here "LISEZ-MOI-INSTALLATION.txt"
if (Test-Path $lisezMoi) { Copy-Item $lisezMoi -Destination $stage -Force }

# --- Compression --------------------------------------------------------
Write-Host "  Compression (cela peut prendre une minute)..."
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

Remove-Item $stage -Recurse -Force

$taille = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ""
Write-Host "  Paquet pret : $zip" -ForegroundColor Green
Write-Host "  Taille : $taille Mo   |   Node embarque : $version"
Write-Host ""
Write-Host "  Sur le poste destinataire :" -ForegroundColor Cyan
Write-Host "    1. decompresser le ZIP dans un dossier (ex. C:\One-pager)"
Write-Host "    2. double-clic sur Installer.bat"
Write-Host ""
Write-Host "  L'installeur verifie le poste, repare ce qui manque, cree"
Write-Host "  l'icone du Bureau et demarre l'outil. Rien d'autre a faire."
Write-Host ""
Write-Host "  L'archive ne contient AUCUN CV : chaque poste part d'un vivier vide."
Write-Host ""
Read-Host "Appuyez sur Entree pour fermer"

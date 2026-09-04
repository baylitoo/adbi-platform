# ============================================================
#   One pager — installation et vérification du poste
#
#   Passe une liste de contrôle, répare ce qui peut l'être,
#   crée le raccourci Bureau, puis démarre l'outil.
#   Lancé par Installer.bat (double-clic).
# ============================================================

$ErrorActionPreference = "Stop"
$racine = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)

$global:Anomalies = @()
$global:Reparations = @()

function Titre($t) {
    Write-Host ""
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host "  $('-' * $t.Length)"
}

function Controle($libelle, $ok, $detail = "") {
    $marque = if ($ok) { "[OK]  " } else { "[!]   " }
    $couleur = if ($ok) { "Green" } else { "Yellow" }
    Write-Host ("  {0}{1,-42} {2}" -f $marque, $libelle, $detail) -ForegroundColor $couleur
    if (-not $ok) { $global:Anomalies += $libelle }
    return $ok
}

function Repare($quoi) {
    Write-Host "        -> $quoi" -ForegroundColor DarkGray
    $global:Reparations += $quoi
}

Clear-Host
Write-Host ""
Write-Host "  ONE PAGER — installation" -ForegroundColor White
Write-Host "  ========================"
Write-Host "  Dossier : $racine"

# ---------------------------------------------------------------- Poste ---
Titre "1. Poste"

Controle "Windows 64 bits" ([Environment]::Is64BitOperatingSystem) $env:PROCESSOR_ARCHITECTURE | Out-Null

$libre = try {
    $d = (Get-Item $racine).PSDrive.Name
    [math]::Round((Get-PSDrive $d).Free / 1GB, 1)
} catch { 99 }
Controle "Espace disque disponible" ($libre -ge 1) "$libre Go" | Out-Null

# Un dossier synchronise ralentit fortement l'outil (des milliers de fichiers).
$synchro = $racine -match "OneDrive|Dropbox|Google Drive"
Controle "Dossier hors synchronisation cloud" (-not $synchro) $(if ($synchro) { "OneDrive détecté — installation lente possible" } else { "" }) | Out-Null

try {
    $test = Join-Path $racine ".ecriture-test"
    "x" | Out-File $test -Encoding ascii
    Remove-Item $test -Force
    Controle "Droits d'écriture dans le dossier" $true | Out-Null
} catch {
    Controle "Droits d'écriture dans le dossier" $false "déplacez le dossier, ex. C:\One-pager" | Out-Null
}

# --------------------------------------------------------------- Moteur ---
Titre "2. Moteur d'exécution"

$nodeEmbarque = Join-Path $racine "runtime\node.exe"
$nodeExe = $null
if (Test-Path $nodeEmbarque) {
    $nodeExe = $nodeEmbarque
    Controle "Node embarqué (aucune installation requise)" $true (& $nodeExe -v) | Out-Null
} else {
    $sys = (Get-Command node -ErrorAction SilentlyContinue).Source
    if ($sys) {
        $nodeExe = $sys
        Controle "Node installé sur le poste" $true (& $nodeExe -v) | Out-Null
    } else {
        Controle "Moteur Node" $false "INTROUVABLE" | Out-Null
        Write-Host ""
        Write-Host "  [BLOQUANT] Ce dossier ne contient pas de moteur embarque" -ForegroundColor Red
        Write-Host "  et Node.js n'est pas installe sur ce poste." -ForegroundColor Red
        Write-Host ""
        Write-Host "  Redecompressez le paquet 'One-pager-portable' EN ENTIER"
        Write-Host "  (le dossier 'runtime' a du etre perdu), ou installez"
        Write-Host "  Node.js LTS depuis https://nodejs.org"
        Write-Host ""
        Read-Host "  Appuyez sur Entree pour fermer"
        exit 1
    }
}

# ------------------------------------------------------------- Fichiers ---
Titre "3. Fichiers de l'application"

$attendus = @("server.js", "lib\ingest.js", "lib\extract.js", "lib\onepager.js",
              "lib\render-pptx.js", "lib\taxonomy.js", "public\index.html", "public\app.js")
$manquants = $attendus | Where-Object { -not (Test-Path (Join-Path $racine $_)) }
if (-not (Controle "Fichiers du programme" ($manquants.Count -eq 0) "$($attendus.Count - $manquants.Count)/$($attendus.Count)")) {
    Write-Host ""
    Write-Host "  [BLOQUANT] Fichiers manquants : $($manquants -join ', ')" -ForegroundColor Red
    Write-Host "  Redecompressez le paquet en entier."
    Read-Host "  Appuyez sur Entree pour fermer"
    exit 1
}

# ---------------------------------------------------------- Dependances ---
Titre "4. Dépendances"

$paquets = @("express", "pdfjs-dist", "pptxgenjs", "sql.js", "mammoth")
$absents = $paquets | Where-Object { -not (Test-Path (Join-Path $racine "node_modules\$_")) }

if ($absents.Count -eq 0) {
    Controle "Bibliothèques" $true "$($paquets.Count)/$($paquets.Count) présentes" | Out-Null
} else {
    Controle "Bibliothèques" $false "manque : $($absents -join ', ')" | Out-Null
    $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
    if ($npm) {
        Repare "installation via npm (nécessite Internet, une minute environ)"
        Push-Location $racine
        try {
            & npm install --no-audit --no-fund 2>&1 | Out-Null
            $reste = $paquets | Where-Object { -not (Test-Path (Join-Path $racine "node_modules\$_")) }
            Controle "Bibliothèques après installation" ($reste.Count -eq 0) | Out-Null
        } catch {
            Controle "Bibliothèques après installation" $false "échec — poste sans Internet ?" | Out-Null
        } finally { Pop-Location }
    } else {
        Write-Host ""
        Write-Host "  [BLOQUANT] Dependances absentes et npm indisponible." -ForegroundColor Red
        Write-Host "  Utilisez le paquet 'One-pager-portable', qui les embarque."
        Read-Host "  Appuyez sur Entree pour fermer"
        exit 1
    }
}

# --------------------------------------------------------------- Images ---
Titre "5. Images du gabarit"

$assets = Join-Path $racine "public\assets"
$pastilles = @("pill-violet-large.png", "pill-violet-etroit.png", "chip-orange.png", "chip-orange2.png")
$pastillesKO = $pastilles | Where-Object { -not (Test-Path (Join-Path $assets $_)) }

if ($pastillesKO.Count -gt 0) {
    Controle "Pastilles dégradées" $false "manque $($pastillesKO.Count)" | Out-Null
    Repare "régénération (scripts\build-pills.js)"
    Push-Location $racine
    try { & $nodeExe "scripts\build-pills.js" | Out-Null } catch {} finally { Pop-Location }
    $reste = $pastilles | Where-Object { -not (Test-Path (Join-Path $assets $_)) }
    Controle "Pastilles dégradées" ($reste.Count -eq 0) | Out-Null
} else {
    Controle "Pastilles dégradées" $true "4/4" | Out-Null
}

$decor = @("fond-vagues.png", "logo-adbi.png")
$decorKO = $decor | Where-Object { -not (Test-Path (Join-Path $assets $_)) }
Controle "Fond et logo" ($decorKO.Count -eq 0) $(if ($decorKO) { "manque : $($decorKO -join ', ')" } else { "" }) | Out-Null

$avatars = @(Get-ChildItem (Join-Path $assets "avatar-*.png") -ErrorAction SilentlyContinue)
Controle "Avatars" ($avatars.Count -ge 1) "$($avatars.Count) disponible(s)" | Out-Null

$badges = @(Get-ChildItem (Join-Path $assets "badges\*.png") -ErrorAction SilentlyContinue)
Controle "Badges de certification" ($badges.Count -ge 1) "$($badges.Count) disponible(s)" | Out-Null

# --------------------------------------------------------------- Donnees ---
Titre "6. Espace de travail"

$data = Join-Path $racine "data"
if (-not (Test-Path $data)) {
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    Repare "création du dossier data"
}
$base = Join-Path $data "cvs.sqlite"
Controle "Dossier des données" (Test-Path $data) $(if (Test-Path $base) { "historique existant conservé" } else { "vide, prêt à l'emploi" }) | Out-Null

$occupe = @(Get-NetTCPConnection -LocalPort 4200 -State Listen -ErrorAction SilentlyContinue)
Controle "Port 4200 libre" ($occupe.Count -eq 0) $(if ($occupe.Count) { "déjà utilisé — l'outil tourne peut-être déjà" } else { "" }) | Out-Null

# ------------------------------------------------------------- Raccourci ---
Titre "7. Raccourci Bureau"

$bat  = Join-Path $racine "Demarrer-One-Pager.bat"
$icon = Join-Path $racine "icone.ico"
if (-not (Test-Path $icon)) {
    try { & $nodeExe (Join-Path $racine "scripts\make-icon.js") | Out-Null; Repare "génération de l'icône" } catch {}
}

try {
    $bureau = [Environment]::GetFolderPath("Desktop")
    $lien = Join-Path $bureau "One pager.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($lien)
    $sc.TargetPath       = $bat
    $sc.WorkingDirectory = $racine
    $sc.Description      = "One pager - dossiers de competences ADBI (local, port 4200)"
    if (Test-Path $icon) { $sc.IconLocation = "$icon,0" }
    $sc.WindowStyle      = 1
    $sc.Save()
    Controle "Icône « One pager » sur le Bureau" (Test-Path $lien) | Out-Null
} catch {
    Controle "Icône « One pager » sur le Bureau" $false "création impossible" | Out-Null
}

# --------------------------------------------------------------- Bilan ---
Write-Host ""
Write-Host "  =============================================" -ForegroundColor White
if ($global:Anomalies.Count -eq 0) {
    Write-Host "   Tout est en ordre." -ForegroundColor Green
} else {
    Write-Host "   $($global:Anomalies.Count) point(s) à signaler :" -ForegroundColor Yellow
    $global:Anomalies | ForEach-Object { Write-Host "     - $_" -ForegroundColor Yellow }
}
if ($global:Reparations.Count -gt 0) {
    Write-Host "   $($global:Reparations.Count) réparation(s) effectuée(s)." -ForegroundColor Cyan
}
Write-Host "  =============================================" -ForegroundColor White
Write-Host ""
Write-Host "  L'outil va demarrer. Le navigateur s'ouvrira seul."
Write-Host "  Ensuite, l'icone 'One pager' du Bureau suffira."
Write-Host ""
Start-Sleep -Seconds 3

Start-Process -FilePath $bat -WorkingDirectory $racine

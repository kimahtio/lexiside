param(
    [Parameter(Mandatory = $true, HelpMessage = "Path to the Obsidian vault")]
    [string]$VaultPath
)

$ErrorActionPreference = "Stop"

$resolvedVault = Resolve-Path -LiteralPath $VaultPath
$obsidianDir = Join-Path $resolvedVault ".obsidian"
if (-not (Test-Path -LiteralPath $obsidianDir -PathType Container)) {
    throw "Not an Obsidian vault (missing .obsidian): $resolvedVault"
}

# Prefer freshly built files in the project root; fall back to the packaged release.
$source = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $source "main.js") -PathType Leaf)) {
    $source = Join-Path $PSScriptRoot "release\lexiside"
}

$required = @("main.js", "manifest.json", "styles.css")
foreach ($file in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) {
        throw "Missing $file in $source. Build the plugin first with 'npm run build'."
    }
}

$destination = Join-Path $obsidianDir "plugins\lexiside"
New-Item -ItemType Directory -Force -Path $destination | Out-Null

foreach ($file in $required) {
    Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $destination $file) -Force
}

Write-Host "LexiSide installed to: $destination"
Write-Host "Open Obsidian -> Settings -> Community plugins, then enable LexiSide."
Write-Host "Existing data.json (API key, cache, vocabulary) was left untouched."

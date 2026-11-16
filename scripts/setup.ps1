[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [ValidateNotNullOrEmpty()]
    [string]$ComposeFile = 'compose.yaml',

    [ValidateNotNullOrEmpty()]
    [string]$SetupComposeFile = 'compose.setup.yaml'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path -Path $PSScriptRoot -ChildPath '..'))

if ([System.IO.Path]::IsPathRooted($ComposeFile)) {
    throw 'ComposeFile must be a path relative to the repository root.'
}

$composeFilePath = [System.IO.Path]::GetFullPath((Join-Path -Path $repositoryRoot -ChildPath $ComposeFile))
$relativeComposePath = [System.IO.Path]::GetRelativePath($repositoryRoot, $composeFilePath)
if ($relativeComposePath -match '^\.\.(?:[\\/]|$)') {
    throw 'ComposeFile must remain inside the repository.'
}
if (-not (Test-Path -LiteralPath $composeFilePath -PathType Leaf)) {
    throw "Compose file not found: $ComposeFile"
}

if ([System.IO.Path]::IsPathRooted($SetupComposeFile)) {
    throw 'SetupComposeFile must be a path relative to the repository root.'
}
$setupComposeFilePath = [System.IO.Path]::GetFullPath((Join-Path -Path $repositoryRoot -ChildPath $SetupComposeFile))
$relativeSetupComposePath = [System.IO.Path]::GetRelativePath($repositoryRoot, $setupComposeFilePath)
if ($relativeSetupComposePath -match '^\.\.(?:[\\/]|$)') {
    throw 'SetupComposeFile must remain inside the repository.'
}
if (-not (Test-Path -LiteralPath $setupComposeFilePath -PathType Leaf)) {
    throw "Compose file not found: $SetupComposeFile"
}

if (-not (Get-Command -Name docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found. Install Docker and ensure docker is on PATH.'
}

$composeArguments = @('compose', '--project-directory', $repositoryRoot, '-f', $composeFilePath)
& docker @composeArguments config --quiet
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose configuration validation failed for '$ComposeFile'."
}
$setupComposeArguments = @('compose', '--project-directory', $repositoryRoot, '-f', $setupComposeFilePath)
& docker @setupComposeArguments config --quiet
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose configuration validation failed for '$SetupComposeFile'."
}
if (-not $PSCmdlet.ShouldProcess('Route planner setup', "Build all Compose images, inspect OSM and Photon data, and update selected datasets")) {
    return
}

& docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker daemon is unavailable.'
}

$maintenanceComposeArguments = @('compose', '--profile', 'maintenance', '--project-directory', $repositoryRoot, '-f', $setupComposeFilePath)
& docker @maintenanceComposeArguments config --quiet
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose maintenance configuration validation failed for '$SetupComposeFile'."
}

& docker @composeArguments build powershell-base
if ($LASTEXITCODE -ne 0) {
    throw 'Could not build the shared PowerShell base image.'
}

& docker @composeArguments build photon check-addresses routeplanner-ui routeplanner-api
if ($LASTEXITCODE -ne 0) {
    throw 'Could not build the runtime application images.'
}

& docker @composeArguments pull traefik
if ($LASTEXITCODE -ne 0) {
    throw 'Could not pull the Traefik image.'
}

& docker @maintenanceComposeArguments build fetch-osm update-geocode-database
if ($LASTEXITCODE -ne 0) {
    throw 'Could not build the setup workflow images.'
}

$osmInspectionOutput = @(& docker @setupComposeArguments run --rm --no-deps fetch-osm inspect)
if ($LASTEXITCODE -ne 0) {
    throw 'Could not inspect the OSM extract.'
}
$osmStateLines = @($osmInspectionOutput | Where-Object { $_ -match '^OSM_(?:MISSING|PRESENT\|)' })
if ($osmStateLines.Count -ne 1) {
    throw 'The OSM inspection returned an unexpected result.'
}

$shouldUpdateOsm = $false
if ($osmStateLines[0] -eq 'OSM_MISSING') {
    Write-Output 'OSM-extract niet gevonden. De nieuwste extract wordt nu gedownload.'
    $shouldUpdateOsm = $true
}
elseif ($osmStateLines[0] -match '^OSM_PRESENT\|(?<UpdatedAt>.+)$') {
    $osmUpdatedAt = [DateTimeOffset]::Parse($Matches.UpdatedAt).ToLocalTime()
    Write-Output ('OSM-extract gevonden; laatst opgehaald: {0}.' -f $osmUpdatedAt.ToString('yyyy-MM-dd HH:mm:ss zzz'))
    $osmAnswer = Read-Host 'De nieuwste OSM-extract downloaden? (j/N)'
    $shouldUpdateOsm = $osmAnswer -match '^(?i:j|ja|y|yes)$'
}
else {
    throw 'The OSM inspection returned an invalid state.'
}

if ($shouldUpdateOsm) {
    & (Join-Path -Path $PSScriptRoot -ChildPath 'fetchOsm.ps1') -ComposeFile $SetupComposeFile -Confirm:$false
}
else {
    Write-Output 'De bestaande OSM-extract blijft behouden.'
}

$inspectionOutput = @(& docker @composeArguments run --rm --no-deps photon inspect-database)
if ($LASTEXITCODE -ne 0) {
    throw 'Could not inspect the Photon geocoder database.'
}

$databaseStateLines = @($inspectionOutput | Where-Object { $_ -match '^DATABASE_(?:MISSING|PRESENT\|)' })
if ($databaseStateLines.Count -ne 1) {
    throw 'The Photon database inspection returned an unexpected result.'
}

$shouldUpdateDatabase = $false
if ($databaseStateLines[0] -eq 'DATABASE_MISSING') {
    Write-Output 'Photon-database niet gevonden. Deze wordt nu bijgewerkt.'
    $shouldUpdateDatabase = $true
}
elseif ($databaseStateLines[0] -match '^DATABASE_PRESENT\|(?<UpdatedAt>.+)$') {
    $updatedAt = [DateTimeOffset]::Parse($Matches.UpdatedAt).ToLocalTime()
    Write-Output ('Photon-database gevonden; laatst bijgewerkt: {0}.' -f $updatedAt.ToString('yyyy-MM-dd HH:mm:ss zzz'))
    $updateAnswer = Read-Host 'Photon-database bijwerken? (j/N)'
    $shouldUpdateDatabase = $updateAnswer -match '^(?i:j|ja|y|yes)$'
}
else {
    throw 'The Photon database inspection returned an invalid state.'
}

if ($shouldUpdateDatabase) {
    & (Join-Path -Path $PSScriptRoot -ChildPath 'updateGeocodeDatabase.ps1') -ComposeFile $SetupComposeFile -PhotonComposeFile $ComposeFile -Confirm:$false
}
else {
    Write-Output 'De bestaande Photon-database blijft behouden.'
}

Write-Output 'Container images are ready. Start the long-running services with .\scripts\start.ps1.'
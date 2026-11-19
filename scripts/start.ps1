[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [ValidateNotNullOrEmpty()]
    [string]$ComposeFile = 'compose.yaml'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path -Path $PSScriptRoot -ChildPath '..'))

if (-not (Get-Command -Name docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found. Install Docker and ensure docker is on PATH.'
}

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

$composeArguments = @('compose', '--project-directory', $repositoryRoot, '-f', $composeFilePath)
& docker @composeArguments config --quiet
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose configuration validation failed for '$ComposeFile'."
}

if (-not $PSCmdlet.ShouldProcess('Photon, Valhalla, matrix worker, VROOM worker, PDF worker, review API, review website, and Traefik', 'Start existing images without building, pulling, or waiting for healthchecks')) {
    return
}

& docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker daemon is unavailable.'
}

$services = @('photon', 'valhalla', 'traefik', 'routeplanner-ui', 'routeplanner-api')
& docker @composeArguments up --no-build --pull never --remove-orphans --detach @services
if ($LASTEXITCODE -ne 0) {
    throw 'Could not start the services. Run .\scripts\setup.ps1 to build the required images first.'
}

& docker @composeArguments up --no-build --pull never --no-start --no-deps check-addresses extract-osm-geometry
if ($LASTEXITCODE -ne 0) {
    throw 'Could not prepare the address-check container.'
}

Write-Output 'Services are starting in the background.'
Write-Output 'Review website: http://routing.localtest.me'
Write-Output 'Review API: http://routing-api.localtest.me'
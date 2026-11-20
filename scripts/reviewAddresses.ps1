[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [ValidateNotNullOrEmpty()]
    [string]$ComposeFile = 'compose.yaml'
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
if (-not (Get-Command -Name docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found. Install Docker and ensure docker is on PATH.'
}

$composeArguments = @('compose', '--project-directory', $repositoryRoot, '-f', $composeFilePath)
& docker @composeArguments config --quiet
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose configuration validation failed for '$ComposeFile'."
}

if (-not $PSCmdlet.ShouldProcess('Local geocoding review stack', "Start existing images using '$ComposeFile'")) {
    return
}

& docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker daemon is unavailable.'
}

& docker @composeArguments up --no-build --detach --wait --wait-timeout 600 photon traefik routeplanner-ui routeplanner-api
if ($LASTEXITCODE -ne 0) {
    throw 'The local geocoding review stack did not start healthy.'
}

& docker @composeArguments up --no-build --pull never --detach valhalla
if ($LASTEXITCODE -ne 0) {
    throw 'Could not start Valhalla for matrix calculation.'
}

& docker @composeArguments up --no-build --pull never --no-start --no-deps check-addresses extract-osm-geometry render-route-maps
if ($LASTEXITCODE -ne 0) {
    throw 'Could not prepare the address-check container.'
}

Write-Output 'Review website: http://routing.localtest.me'
Write-Output 'Review API: http://routing-api.localtest.me'
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [ValidateNotNullOrEmpty()]
    [string]$ComposeFile = 'compose.setup.yaml'
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

$composeArguments = @('compose', '--profile', 'maintenance', '--project-directory', $repositoryRoot, '-f', $composeFilePath)
& docker @composeArguments config --quiet
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose configuration validation failed for '$ComposeFile'."
}

if ($PSCmdlet.ShouldProcess('Valhalla routing tiles', "Build tiles from the local OSM extract using '$ComposeFile'")) {
    & docker info --format '{{.ServerVersion}}' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker daemon is unavailable.'
    }

    & docker @composeArguments up --no-build --force-recreate --exit-code-from build-valhalla-tiles build-valhalla-tiles
    if ($LASTEXITCODE -ne 0) {
        throw "The Valhalla tile build container failed with exit code $LASTEXITCODE."
    }
}

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [ValidateNotNullOrEmpty()]
    [string]$ComposeFile = 'compose.setup.yaml',

    [ValidateNotNullOrEmpty()]
    [string]$PhotonComposeFile = 'compose.yaml'
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

if ([System.IO.Path]::IsPathRooted($PhotonComposeFile)) {
    throw 'PhotonComposeFile must be a path relative to the repository root.'
}
$photonComposeFilePath = [System.IO.Path]::GetFullPath((Join-Path -Path $repositoryRoot -ChildPath $PhotonComposeFile))
$relativePhotonComposePath = [System.IO.Path]::GetRelativePath($repositoryRoot, $photonComposeFilePath)
if ($relativePhotonComposePath -match '^\.\.(?:[\\/]|$)') {
    throw 'PhotonComposeFile must remain inside the repository.'
}
if (-not (Test-Path -LiteralPath $photonComposeFilePath -PathType Leaf)) {
    throw "Compose file not found: $PhotonComposeFile"
}
if (-not (Get-Command -Name docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found. Install Docker and ensure docker is on PATH.'
}

$composeArguments = @('compose', '--project-directory', $repositoryRoot, '-f', $composeFilePath)
& docker @composeArguments config --quiet
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose configuration validation failed for '$ComposeFile'."
}
$updateComposeArguments = @('compose', '--profile', 'maintenance', '--project-directory', $repositoryRoot, '-f', $composeFilePath)
& docker @updateComposeArguments config --quiet
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose maintenance configuration validation failed for '$ComposeFile'."
}
$photonComposeArguments = @('compose', '--project-directory', $repositoryRoot, '-f', $photonComposeFilePath)
& docker @photonComposeArguments config --quiet
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose configuration validation failed for '$PhotonComposeFile'."
}

& docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker daemon is unavailable.'
}

$runningPhotonContainers = & docker @photonComposeArguments ps --status running -q photon
if ($LASTEXITCODE -ne 0) {
    throw 'Could not determine whether the Photon service is running.'
}
$photonWasRunning = -not [string]::IsNullOrWhiteSpace(($runningPhotonContainers -join ''))

if ($PSCmdlet.ShouldProcess('Photon Belgium geocoder database', 'Stop Photon, import the Belgium dataset, and restart Photon if it was running')) {
    if ($photonWasRunning) {
        & docker @photonComposeArguments stop photon
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not stop Photon before updating its database.'
        }
    }

    try {
        & docker @updateComposeArguments up --no-build --force-recreate --exit-code-from update-geocode-database update-geocode-database
        $updateExitCode = $LASTEXITCODE
        if ($updateExitCode -ne 0) {
            throw "Photon database update failed with exit code $updateExitCode."
        }
    }
    finally {
        if ($photonWasRunning) {
            & docker @photonComposeArguments up --no-build -d --wait --wait-timeout 600 photon
            if ($LASTEXITCODE -ne 0) {
                throw 'The database update completed or failed, but Photon could not be restarted.'
            }
        }
    }
}
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [ValidateNotNullOrEmpty()]
    [string]$ComposeFile = 'compose.check-addresses.yaml',

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]*$')]
    [string]$ServiceName = 'check-addresses'
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

$composeArguments = @(
    'compose'
    '--project-directory'
    $repositoryRoot
    '-f'
    $composeFilePath
)

& docker @composeArguments config --quiet
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose configuration validation failed for '$ComposeFile'."
}

if ($PSCmdlet.ShouldProcess($ServiceName, "Start Docker Compose service using '$ComposeFile'")) {
    & docker info --format '{{.ServerVersion}}' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker daemon is unavailable.'
    }

    $runningPhotonContainers = & docker @composeArguments ps --status running -q photon
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not determine whether the Photon service is running.'
    }

    $photonWasRunning = -not [string]::IsNullOrWhiteSpace(($runningPhotonContainers -join ''))
    $photonStartedByLauncher = $false

    try {
        & docker @composeArguments up --build -d --wait --wait-timeout 600 photon
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not start or wait for the healthy Photon geocoder service.'
        }
        if (-not $photonWasRunning) {
            $photonStartedByLauncher = $true
        }

        & docker @composeArguments run --build --rm --no-deps $ServiceName
        $checkExitCode = $LASTEXITCODE
        if ($checkExitCode -ne 0) {
            throw "Docker Compose service '$ServiceName' failed with exit code $checkExitCode."
        }
    }
    finally {
        if ($photonStartedByLauncher) {
            & docker @composeArguments stop photon
            if ($LASTEXITCODE -ne 0) {
                throw 'The address check finished, but the Photon service started by this launcher could not be stopped.'
            }
        }
    }
}

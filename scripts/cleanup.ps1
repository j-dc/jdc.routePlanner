[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path -Path $PSScriptRoot -ChildPath '..'))

if (-not (Get-Command -Name docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found. Install Docker and ensure docker is on PATH.'
}

$runtimeComposeFile = Join-Path -Path $repositoryRoot -ChildPath 'compose.yaml'
$setupComposeFile = Join-Path -Path $repositoryRoot -ChildPath 'compose.setup.yaml'
$runtimeComposeArguments = @('compose', '--project-directory', $repositoryRoot, '-f', $runtimeComposeFile)
$setupComposeArguments = @('compose', '--profile', 'maintenance', '--project-directory', $repositoryRoot, '-f', $setupComposeFile)

foreach ($composeConfiguration in @(
        @{ Arguments = $runtimeComposeArguments; File = 'compose.yaml' },
        @{ Arguments = $setupComposeArguments; File = 'compose.setup.yaml (maintenance profile)' }
    )) {
    $composeArguments = $composeConfiguration.Arguments
    & docker @composeArguments config --quiet
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose configuration validation failed for '$($composeConfiguration.File)'."
    }
}

if (-not $PSCmdlet.ShouldProcess('Route planner runtime and setup containers', 'Remove containers and stack networks while preserving volumes and bind-mounted data')) {
    return
}

& docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker daemon is unavailable.'
}

& docker @setupComposeArguments down --remove-orphans
$setupExitCode = $LASTEXITCODE
& docker @runtimeComposeArguments down --remove-orphans
$runtimeExitCode = $LASTEXITCODE

if ($setupExitCode -ne 0 -or $runtimeExitCode -ne 0) {
    throw "Could not remove all Route Planner containers (setup exit code: $setupExitCode, runtime exit code: $runtimeExitCode)."
}

Write-Output 'Route Planner containers and stack networks removed. Volumes and bind-mounted data were not removed.'
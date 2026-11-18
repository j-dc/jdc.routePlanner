#Requires -Version 7.0
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$versionPattern = '^[0-9]{8}T[0-9]{13}Z$'
$objectPattern = '^([NWR])/([1-9][0-9]*)$'

function Get-EnvironmentValue {
    param([string]$Name, [string]$Default)
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ($null -eq $value) { return $Default }
    return $value
}

function Get-GeometryVersion {
    $version = Get-EnvironmentValue 'CHECK_ADDRESSES_VERSION' ''
    if (-not $version) {
        $versionFile = Get-EnvironmentValue 'CHECK_ADDRESSES_VERSION_FILE' ''
        $version = if ($versionFile) { (Get-Content -LiteralPath $versionFile -Raw -Encoding utf8).Trim() } else { 'legacy' }
    }
    if ($version -ne 'legacy') {
        if ($version -cnotmatch $versionPattern) { throw [System.ArgumentException]::new('Invalid version.') }
        $parsed = [datetime]::MinValue
        $isValidDate = [datetime]::TryParseExact($version.Substring(0, 21), "yyyyMMdd'T'HHmmssffffff",
            [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$parsed)
        if (-not $isValidDate) { throw [System.ArgumentException]::new('Invalid version.') }
    }
    return $version
}

function Get-Sha256Hex {
    param([byte[]]$Bytes)
    return [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($Bytes))
}

function Test-HasValue {
    param($Object, [string]$Name)
    return $null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name] -and $null -ne $Object.$Name
}

function Invoke-Osmium {
    param([string[]]$Arguments)
    [Console]::Out.WriteLine("osmium $($Arguments -join ' ')")
    # Output goes to the container log instead of the pipeline so the function still returns only the exit code.
    $outputLines = & osmium @Arguments 2>&1 | ForEach-Object { "$_" }
    $exitCode = $LASTEXITCODE
    foreach ($line in $outputLines) { [Console]::Out.WriteLine("osmium: $line") }
    [Console]::Out.WriteLine("|-> exitCode: $exitCode")
    return $exitCode
}

function Invoke-GeometryExtraction {
    $version = Get-GeometryVersion
    $suffix = if ($version -eq 'legacy') { '' } else { "-$version" }
    $reportPath = Join-Path (Get-EnvironmentValue 'GEOMETRY_REPORT_DIR' '/source') "address-check$suffix.json"
    $outputPath = Join-Path (Get-EnvironmentValue 'GEOMETRY_OUTPUT_DIR' '/output') "osm-geometry$suffix.geojson"
    $osmPath = Get-EnvironmentValue 'OSM_PBF_PATH' '/osm/belgium-latest.osm.pbf'
    $settingsFileName = if ($version -eq 'legacy') { 'settings.json' } else { "settings-$version.json" }
    $settingsPath = Join-Path (Get-EnvironmentValue 'GEOMETRY_SETTINGS_DIR' '/source') $settingsFileName

    $reportBytes = [System.IO.File]::ReadAllBytes($reportPath)
    $report = [System.Text.Encoding]::UTF8.GetString($reportBytes) | ConvertFrom-Json -Depth 100
    if (-not (Test-Path -LiteralPath $osmPath -PathType Leaf)) {
        throw [System.IO.FileNotFoundException]::new('The local OSM extract is unavailable.')
    }

    $startLocation = $null
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        $settings = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($settingsPath)) | ConvertFrom-Json -Depth 100
        if (Test-HasValue $settings 'StartLocation') {
            $startLocation = $settings.StartLocation
        }
    }

    $requested = [ordered]@{}
    $unidentifiable = [System.Collections.Generic.List[object]]::new()
    $selectedByRecord = [ordered]@{}

    foreach ($record in $report.Results) {
        if ($record.Status -ne 'valid') { continue }
        if ($null -eq $record.Longitude -or $null -eq $record.Latitude) { continue }
        foreach ($candidate in @($record.Candidates)) {
            if ($candidate.GeometryIsValid -eq $true -and
                $null -ne $candidate.Longitude -and $null -ne $candidate.Latitude -and
                $candidate.Longitude -eq $record.Longitude -and $candidate.Latitude -eq $record.Latitude) {
                $selectedByRecord[[long]$record.CsvRecordNumber] = [string]$candidate.CandidateId
                break
            }
        }
    }

    $reviewPath = Join-Path (Get-EnvironmentValue 'GEOMETRY_REVIEW_DIR' '/review') "address-review$suffix.json"
    if (Test-Path -LiteralPath $reviewPath -PathType Leaf) {
        $inputPath = Join-Path (Get-EnvironmentValue 'GEOMETRY_INPUT_DIR' '/input') "ritten$suffix.csv"
        $review = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($reviewPath)) | ConvertFrom-Json -Depth 100
        $fingerprint = Get-Sha256Hex ([byte[]]($reportBytes + [System.IO.File]::ReadAllBytes($inputPath)))
        $reviewFingerprint = if (Test-HasValue $review 'sourceFingerprint') { [string]$review.sourceFingerprint } else { '' }
        if ($reviewFingerprint.ToUpperInvariant() -eq $fingerprint) {
            foreach ($record in @($review.records)) {
                $recordNumber = [long]$record.csvRecordNumber
                $selectedByRecord.Remove($recordNumber)
                if ($record.decision -notin @('auto_accepted', 'accepted')) { continue }
                $candidateId = $record.selectedCandidateId
                $candidate = @($record.candidates) | Where-Object {
                    $_.candidateId -eq $candidateId -and $_.geometryIsValid -eq $true -and
                    $null -ne $_.latitude -and $null -ne $_.longitude
                } | Select-Object -First 1
                if ($null -ne $candidate) { $selectedByRecord[$recordNumber] = [string]$candidateId }
            }
        }
    }

    foreach ($recordNumber in $selectedByRecord.Keys) {
        $candidateId = $selectedByRecord[$recordNumber]
        $match = [regex]::Match($candidateId, $objectPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        $idValue = [long]0
        if (-not $match.Success -or -not [long]::TryParse($match.Groups[2].Value, [ref]$idValue)) {
            $unidentifiable.Add([ordered]@{ recordNumber = $recordNumber; candidateId = $candidateId })
            continue
        }
        $objectId = "$($match.Groups[1].Value.ToUpperInvariant())/$($match.Groups[2].Value)"
        if (-not $requested.Contains($objectId)) {
            $requested[$objectId] = [System.Collections.Generic.List[long]]::new()
        }
        if (-not $requested[$objectId].Contains($recordNumber)) { $requested[$objectId].Add($recordNumber) }
    }

    $featuresById = [ordered]@{}
    $temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "osm-geometry-$([guid]::NewGuid().ToString('N'))"
    [void][System.IO.Directory]::CreateDirectory($temporaryDirectory)
    try {
        if ($requested.Count -gt 0) {
            $idPath = Join-Path $temporaryDirectory 'ids.txt'
            $idLines = foreach ($objectId in $requested.Keys) { "$($objectId[0].ToString().ToLowerInvariant())$($objectId.Substring(2))" }
            [System.IO.File]::WriteAllText($idPath, (($idLines -join "`n") + "`n"), [System.Text.Encoding]::ASCII)
            $selectedPath = Join-Path $temporaryDirectory 'selected.osm.pbf'
            $extractExitCode = Invoke-Osmium @('getid', '--add-referenced', '--remove-tags', '--no-progress',
                '--id-file', $idPath, '--output', $selectedPath, $osmPath)
            if ($extractExitCode -notin 0, 1 -or -not (Test-Path -LiteralPath $selectedPath -PathType Leaf)) {
                throw [System.InvalidOperationException]::new('The local OSM objects could not be extracted.')
            }
            if ($extractExitCode -eq 1 -and (Invoke-Osmium @('fileinfo', '--extended', '--no-progress', $osmPath)) -ne 0) {
                throw [System.InvalidOperationException]::new('The local OSM extract is invalid.')
            }
            $exportedPath = Join-Path $temporaryDirectory 'features.geojson'
            if ((Invoke-Osmium @('export', '--keep-untagged', '--add-unique-id', 'type_id', '--no-progress',
                        '--output', $exportedPath, $selectedPath)) -ne 0) {
                throw [System.InvalidOperationException]::new('The local OSM objects could not be exported.')
            }
            $exported = [System.IO.File]::ReadAllText($exportedPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json -Depth 100
            foreach ($feature in @($exported.features)) {
                $rawId = if (Test-HasValue $feature 'id') { [string]$feature.id } else { '' }
                if ($rawId -cnotmatch '^[nwa][1-9][0-9]*$') { continue }
                if ($rawId[0] -eq 'a') {
                    $areaId = [long]$rawId.Substring(1)
                    $objectId = "$(if ($areaId % 2) { 'R' } else { 'W' })/$([long][math]::Floor($areaId / 2))"
                }
                else {
                    $objectId = "$($rawId[0].ToString().ToUpperInvariant())/$($rawId.Substring(1))"
                }
                if (-not $requested.Contains($objectId) -or -not (Test-HasValue $feature 'geometry')) { continue }
                if ($featuresById.Contains($objectId) -and $feature.geometry.type -notin @('Polygon', 'MultiPolygon')) { continue }
                $featuresById[$objectId] = [ordered]@{
                    type       = 'Feature'
                    id         = $objectId
                    geometry   = $feature.geometry
                    properties = [ordered]@{
                        candidateId   = $objectId
                        recordNumbers = @($requested[$objectId] | Sort-Object)
                    }
                }
            }
        }
    }
    finally {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }

    $missingIds = [System.Collections.Generic.List[string]]::new()
    foreach ($objectId in $requested.Keys) {
        if (-not $featuresById.Contains($objectId)) { $missingIds.Add($objectId) }
    }
    $missingIds.Sort([System.StringComparer]::Ordinal)
    $missingObjects = foreach ($objectId in $missingIds) {
        [ordered]@{ candidateId = $objectId; recordNumbers = @($requested[$objectId] | Sort-Object) }
    }

    $features = @($featuresById.Values)
    if ($null -ne $startLocation -and $null -ne $startLocation.Latitude -and $null -ne $startLocation.Longitude) {
        $startLocationFeature = [ordered]@{
            type       = 'Feature'
            id         = 'start-location'
            geometry   = [ordered]@{
                type        = 'Point'
                coordinates = @([double]$startLocation.Longitude, [double]$startLocation.Latitude)
            }
            properties = [ordered]@{
                candidateId = 'start-location'
                label       = $startLocation.Label
                street      = $startLocation.Street
                houseNumber = $startLocation.HouseNumber
                postcode    = $startLocation.Postcode
                municipality = $startLocation.Municipality
                osmType     = $startLocation.OsmType
                osmId       = $startLocation.OsmId
                isStartLocation = $true
            }
        }
        $features = @($startLocationFeature) + $features
    }

    $result = [ordered]@{
        type     = 'FeatureCollection'
        features = $features
        metadata = [ordered]@{
            version                  = $version
            sourceReportSha256       = Get-Sha256Hex $reportBytes
            inputSha256              = if (Test-HasValue $report 'InputSha256') { $report.InputSha256 } else { $null }
            createdAtUtc             = [datetime]::UtcNow.ToString('o')
            hasStartLocation         = $null -ne $startLocation -and $null -ne $startLocation.Latitude -and $null -ne $startLocation.Longitude
            missingObjects           = @($missingObjects)
            unidentifiableCandidates = @($unidentifiable)
        }
    }

    $outputDirectory = Split-Path -Parent $outputPath
    [void][System.IO.Directory]::CreateDirectory($outputDirectory)
    $temporaryPath = Join-Path $outputDirectory ".osm-geometry-$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $json = $result | ConvertTo-Json -Depth 100 -Compress
        [System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.UTF8Encoding]::new($false))
        # The API container runs as another user and must be able to read the result.
        [System.IO.File]::SetUnixFileMode($temporaryPath, [System.IO.UnixFileMode]'UserRead, UserWrite, GroupRead, OtherRead')
        [System.IO.File]::Move($temporaryPath, $outputPath, $true)
    }
    finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
    $missingCount = $requested.Count - $featuresById.Count
    Write-Output "OSM geometry completed: $($featuresById.Count) features, $missingCount missing objects, $($unidentifiable.Count) unidentified candidates."
}

try {
    Invoke-GeometryExtraction
}
catch {
    [Console]::Error.WriteLine("OSM geometry failed: $($_.Exception.GetType().Name)")
    Write-Verbose $_.Exception.Message
    exit 1
}

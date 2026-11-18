#Requires -Modules Pester
# Runs inside the extract-osm-geometry image (needs osmium); see README.md.

BeforeAll {
    $script:Entrypoint = if ($env:EXTRACT_ENTRYPOINT) { $env:EXTRACT_ENTRYPOINT } else { '/app/entrypoint.ps1' }
    $script:Version = '20261117T1234561234567Z'
    $script:OsmXml = @'
<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="50.0" lon="3.0"><tag k="addr:housenumber" v="1"/></node>
  <node id="2" lat="50.0" lon="3.01"/><node id="3" lat="50.01" lon="3.01"/><node id="4" lat="50.01" lon="3.0"/>
  <node id="5" lat="50.02" lon="3.02"/><node id="6" lat="50.02" lon="3.03"/><node id="7" lat="50.03" lon="3.03"/><node id="8" lat="50.03" lon="3.02"/>
  <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/><tag k="building" v="yes"/></way>
  <way id="11"><nd ref="5"/><nd ref="6"/><nd ref="7"/><nd ref="8"/><nd ref="5"/></way>
  <relation id="20"><member type="way" ref="11" role="outer"/><tag k="type" v="multipolygon"/><tag k="building" v="yes"/></relation>
</osm>
'@

    function New-TestDirectory {
        $path = Join-Path ([System.IO.Path]::GetTempPath()) "geometry-test-$([guid]::NewGuid().ToString('N'))"
        [void](New-Item -ItemType Directory -Path $path)
        return $path
    }

    function Invoke-Extraction {
        param([string]$Directory, [hashtable]$Environment)
        $names = @('CHECK_ADDRESSES_VERSION', 'CHECK_ADDRESSES_VERSION_FILE', 'GEOMETRY_REPORT_DIR', 'GEOMETRY_OUTPUT_DIR',
            'GEOMETRY_INPUT_DIR', 'GEOMETRY_REVIEW_DIR', 'OSM_PBF_PATH')
        foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $null) }
        foreach ($name in $Environment.Keys) { [Environment]::SetEnvironmentVariable($name, $Environment[$name]) }
        & pwsh -NoLogo -NoProfile -File $script:Entrypoint *> $null
        return $LASTEXITCODE
    }
}

Describe 'extract-osm-geometry entrypoint' {
    It 'extracts local objects, reports missing ids and ignores a stale review' {
        $directory = New-TestDirectory
        try {
            Set-Content -LiteralPath "$directory/synthetic.osm" -Value $script:OsmXml -Encoding utf8
            & osmium cat "$directory/synthetic.osm" -o "$directory/synthetic.osm.pbf"
            $report = @{ InputSha256 = 'INPUT'; Results = @(
                    @{ CsvRecordNumber = 2; Status = 'valid'; Longitude = 3.01; Latitude = 50.0; Candidates = @(
                            @{ CandidateId = 'N/1'; GeometryIsValid = $true; Longitude = 3.0; Latitude = 50.0 },
                            @{ CandidateId = 'W/10'; GeometryIsValid = $true; Longitude = 3.01; Latitude = 50.0 }) },
                    @{ CsvRecordNumber = 3; Status = 'ambiguous'; Candidates = @(@{ CandidateId = 'R/20' }) },
                    @{ CsvRecordNumber = 4; Status = 'valid'; Longitude = 3.0; Latitude = 50.0; Candidates = @(
                            @{ CandidateId = 'W/999'; GeometryIsValid = $true; Longitude = 3.0; Latitude = 50.0 }) },
                    @{ CsvRecordNumber = 5; Status = 'valid'; Longitude = 3.0; Latitude = 50.0; Candidates = @(
                            @{ CandidateId = 'fallback'; GeometryIsValid = $true; Longitude = 3.0; Latitude = 50.0 }) }) }
            $reportPath = "$directory/address-check-$script:Version.json"
            $inputPath = "$directory/ritten-$script:Version.csv"
            [System.IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 10))
            [System.IO.File]::WriteAllBytes($inputPath, [System.Text.Encoding]::UTF8.GetBytes('synthetic input'))
            $fingerprint = [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData(
                    [byte[]]([System.IO.File]::ReadAllBytes($reportPath) + [System.IO.File]::ReadAllBytes($inputPath))))
            $review = @{ sourceFingerprint = $fingerprint; records = @(@{
                        csvRecordNumber = 2; decision = 'accepted'; selectedCandidateId = 'N/5'
                        candidates = @(@{ candidateId = 'N/5'; geometryIsValid = $true; longitude = 3.0; latitude = 50.0 }) }) }
            $reviewPath = "$directory/address-review-$script:Version.json"
            [System.IO.File]::WriteAllText($reviewPath, ($review | ConvertTo-Json -Depth 10))
            $environment = @{ CHECK_ADDRESSES_VERSION = $script:Version; GEOMETRY_REPORT_DIR = $directory; GEOMETRY_OUTPUT_DIR = $directory
                GEOMETRY_INPUT_DIR = $directory; GEOMETRY_REVIEW_DIR = $directory; OSM_PBF_PATH = "$directory/synthetic.osm.pbf" }

            Invoke-Extraction $directory $environment | Should -Be 0
            $outputPath = "$directory/osm-geometry-$script:Version.geojson"
            $data = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
            @($data.features).id | Should -Be @('N/5')
            $data.features[0].geometry.type | Should -Be 'Point'
            @($data.features[0].properties.recordNumbers) | Should -Be @(2)
            @($data.metadata.missingObjects).Count | Should -Be 1
            $data.metadata.missingObjects[0].candidateId | Should -Be 'W/999'
            @($data.metadata.missingObjects[0].recordNumbers) | Should -Be @(4)
            $data.metadata.unidentifiableCandidates[0].candidateId | Should -Be 'fallback'
            [System.IO.File]::GetUnixFileMode($outputPath).HasFlag([System.IO.UnixFileMode]::OtherRead) | Should -BeTrue

            $review.sourceFingerprint = 'STALE'
            [System.IO.File]::WriteAllText($reviewPath, ($review | ConvertTo-Json -Depth 10))
            Invoke-Extraction $directory $environment | Should -Be 0
            $staleIds = @((Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json).features).id
            $staleIds | Should -Not -Contain 'N/5'
            $staleIds | Should -Contain 'W/10'
        }
        finally { Remove-Item -LiteralPath $directory -Recurse -Force }
    }

    It 'preserves the existing geojson when the extract is missing' {
        $directory = New-TestDirectory
        try {
            Set-Content -LiteralPath "$directory/address-check-$script:Version.json" -Value '{"Results":[]}'
            $output = "$directory/osm-geometry-$script:Version.geojson"
            Set-Content -LiteralPath $output -Value 'existing'
            $exitCode = Invoke-Extraction $directory @{ CHECK_ADDRESSES_VERSION = $script:Version; GEOMETRY_REPORT_DIR = $directory
                GEOMETRY_OUTPUT_DIR = $directory; OSM_PBF_PATH = "$directory/missing.pbf" }
            $exitCode | Should -Not -Be 0
            (Get-Content -LiteralPath $output -Raw).Trim() | Should -Be 'existing'
        }
        finally { Remove-Item -LiteralPath $directory -Recurse -Force }
    }

    It 'rejects an invalid version in the version file' {
        $directory = New-TestDirectory
        try {
            Set-Content -LiteralPath "$directory/version" -Value '20269999T1234561234567Z'
            Invoke-Extraction $directory @{ CHECK_ADDRESSES_VERSION_FILE = "$directory/version" } | Should -Not -Be 0
        }
        finally { Remove-Item -LiteralPath $directory -Recurse -Force }
    }

    It 'includes the start location in the geojson when settings are present' {
        $directory = New-TestDirectory
        try {
            Set-Content -LiteralPath "$directory/synthetic.osm" -Value $script:OsmXml -Encoding utf8
            & osmium cat "$directory/synthetic.osm" -o "$directory/synthetic.osm.pbf"
            $report = @{ InputSha256 = 'INPUT'; Results = @(
                    @{ CsvRecordNumber = 2; Status = 'valid'; Longitude = 3.01; Latitude = 50.0; Candidates = @(
                            @{ CandidateId = 'W/10'; GeometryIsValid = $true; Longitude = 3.01; Latitude = 50.0 }) }) }
            $reportPath = "$directory/address-check-$script:Version.json"
            $inputPath = "$directory/ritten-$script:Version.csv"
            [System.IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 10))
            [System.IO.File]::WriteAllBytes($inputPath, [System.Text.Encoding]::UTF8.GetBytes('synthetic input'))
            $settings = @{ StartLocation = @{
                    Label = 'Test Location'
                    Street = 'Test Street'
                    HouseNumber = '123'
                    Postcode = '1234'
                    Municipality = 'Test City'
                    Latitude = 50.5
                    Longitude = 3.5
                    OsmType = 'node'
                    OsmId = 999 } }
            $settingsPath = "$directory/settings-$script:Version.json"
            [System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 10))
            $environment = @{ CHECK_ADDRESSES_VERSION = $script:Version; GEOMETRY_REPORT_DIR = $directory; GEOMETRY_OUTPUT_DIR = $directory
                GEOMETRY_INPUT_DIR = $directory; GEOMETRY_REVIEW_DIR = $directory; GEOMETRY_SETTINGS_DIR = $directory; OSM_PBF_PATH = "$directory/synthetic.osm.pbf" }

            Invoke-Extraction $directory $environment | Should -Be 0
            $outputPath = "$directory/osm-geometry-$script:Version.geojson"
            $data = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
            $data.features[0].id | Should -Be 'start-location'
            $data.features[0].geometry.type | Should -Be 'Point'
            $data.features[0].geometry.coordinates | Should -Be @(3.5, 50.5)
            $data.features[0].properties.isStartLocation | Should -Be $true
            $data.features[0].properties.label | Should -Be 'Test Location'
            $data.metadata.hasStartLocation | Should -Be $true
        }
        finally { Remove-Item -LiteralPath $directory -Recurse -Force }
    }

    It 'does not include start location when settings file is missing' {
        $directory = New-TestDirectory
        try {
            Set-Content -LiteralPath "$directory/synthetic.osm" -Value $script:OsmXml -Encoding utf8
            & osmium cat "$directory/synthetic.osm" -o "$directory/synthetic.osm.pbf"
            $report = @{ InputSha256 = 'INPUT'; Results = @(
                    @{ CsvRecordNumber = 2; Status = 'valid'; Longitude = 3.01; Latitude = 50.0; Candidates = @(
                            @{ CandidateId = 'W/10'; GeometryIsValid = $true; Longitude = 3.01; Latitude = 50.0 }) }) }
            $reportPath = "$directory/address-check-$script:Version.json"
            $inputPath = "$directory/ritten-$script:Version.csv"
            [System.IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 10))
            [System.IO.File]::WriteAllBytes($inputPath, [System.Text.Encoding]::UTF8.GetBytes('synthetic input'))
            $environment = @{ CHECK_ADDRESSES_VERSION = $script:Version; GEOMETRY_REPORT_DIR = $directory; GEOMETRY_OUTPUT_DIR = $directory
                GEOMETRY_INPUT_DIR = $directory; GEOMETRY_REVIEW_DIR = $directory; GEOMETRY_SETTINGS_DIR = $directory; OSM_PBF_PATH = "$directory/synthetic.osm.pbf" }

            Invoke-Extraction $directory $environment | Should -Be 0
            $outputPath = "$directory/osm-geometry-$script:Version.geojson"
            $data = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
            $data.features[0].id | Should -Not -Be 'start-location'
            $data.metadata.hasStartLocation | Should -Be $false
        }
        finally { Remove-Item -LiteralPath $directory -Recurse -Force }
    }

    It 'does not replace the output when the PBF is invalid' {
        $directory = New-TestDirectory
        try {
            $report = @{ Results = @(@{ CsvRecordNumber = 2; Status = 'valid'; Longitude = 3.01; Latitude = 50.0
                        Candidates = @(@{ CandidateId = 'W/10'; GeometryIsValid = $true; Longitude = 3.01; Latitude = 50.0 }) }) }
            [System.IO.File]::WriteAllText("$directory/address-check-$script:Version.json", ($report | ConvertTo-Json -Depth 10))
            Set-Content -LiteralPath "$directory/invalid.pbf" -Value 'invalid'
            $output = "$directory/osm-geometry-$script:Version.geojson"
            Set-Content -LiteralPath $output -Value 'existing'
            $exitCode = Invoke-Extraction $directory @{ CHECK_ADDRESSES_VERSION = $script:Version; GEOMETRY_REPORT_DIR = $directory
                GEOMETRY_OUTPUT_DIR = $directory; OSM_PBF_PATH = "$directory/invalid.pbf" }
            $exitCode | Should -Not -Be 0
            (Get-Content -LiteralPath $output -Raw).Trim() | Should -Be 'existing'
        }
        finally { Remove-Item -LiteralPath $directory -Recurse -Force }
    }
}


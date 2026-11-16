[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$inputPath = $env:CHECK_ADDRESSES_INPUT
$reportPath = $env:CHECK_ADDRESSES_REPORT
$geocoderBaseUrl = $env:GEOCODER_BASE_URL
$geocodingModulePath = Join-Path -Path $PSScriptRoot -ChildPath 'Geocoding.psm1'
$expectedHeaders = [string[]]@(
    'rit', 'naam', 'straat', 'nr.', 'postcode', 'gemeente',
    'aantal', 'bellen', 'Opmerking', 'opmerking', 'klas'
)
$parser = $null

try {
    if ([string]::IsNullOrWhiteSpace($inputPath) -or [string]::IsNullOrWhiteSpace($reportPath)) {
        throw 'Input and report paths must be configured.'
    }
    if ([string]::IsNullOrWhiteSpace($geocoderBaseUrl)) {
        throw 'GEOCODER_BASE_URL must point to an approved internal Photon-compatible endpoint.'
    }
    if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
        tree /private
        throw "The mounted input CSV was not found. ($inputPath)"
    }

    $geocoderUri = [uri]::new($geocoderBaseUrl, [System.UriKind]::Absolute)
    if ($geocoderUri.Scheme -notin @('http', 'https')) {
        throw 'GEOCODER_BASE_URL must use HTTP or HTTPS.'
    }
    Import-Module -Name $geocodingModulePath -Force -ErrorAction Stop

    Add-Type -AssemblyName Microsoft.VisualBasic
    $parser = [Microsoft.VisualBasic.FileIO.TextFieldParser]::new($inputPath)
    $parser.TextFieldType = [Microsoft.VisualBasic.FileIO.FieldType]::Delimited
    $parser.SetDelimiters(';')
    $parser.HasFieldsEnclosedInQuotes = $true
    $parser.TrimWhiteSpace = $false

    if ($parser.EndOfData) {
        throw 'The input CSV is empty.'
    }

    $headers = $parser.ReadFields()
    if ($headers.Count -ne $expectedHeaders.Count) {
        throw 'The input CSV header does not match the required schema.'
    }
    for ($headerIndex = 0; $headerIndex -lt $expectedHeaders.Count; $headerIndex++) {
        if (-not [string]::Equals($headers[$headerIndex], $expectedHeaders[$headerIndex], [System.StringComparison]::Ordinal)) {
            throw 'The input CSV header does not match the required schema.'
        }
    }

    $results = [System.Collections.Generic.List[object]]::new()
    $addressCache = @{}
    $csvRecordNumber = 1
    $consecutiveTransientFailures = 0
    $geocoderCircuitOpen = $false
    while (-not $parser.EndOfData) {
        $fields = $parser.ReadFields()
        $csvRecordNumber++

        $result = [ordered]@{
            CsvRecordNumber = $csvRecordNumber
            Rit = ''
            Address = $null
            Status = ''
            Reason = ''
            CandidateCount = 0
            Candidates = @()
            Latitude = $null
            Longitude = $null
            GeocoderAttempts = 0
            FromCache = $false
        }

        if ($null -eq $fields -or $fields.Count -ne $expectedHeaders.Count) {
            $result.Status = 'malformed_row'
            $result.Reason = 'field_count_mismatch'
            $results.Add([pscustomobject]$result)
            continue
        }

        $result.Rit = $fields[0].Trim()
        $addressParts = @($fields[2].Trim(), $fields[3].Trim(), $fields[4].Trim(), $fields[5].Trim())
        $result.Address = [ordered]@{
            Street = $addressParts[0]
            HouseNumber = $addressParts[1]
            Postcode = $addressParts[2]
            Municipality = $addressParts[3]
        }
        if (@($addressParts | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
            $result.Status = 'invalid_address'
            $result.Reason = 'required_address_field_missing'
            $results.Add([pscustomobject]$result)
            continue
        }

        if ($geocoderCircuitOpen) {
            $result.Status = 'geocoder_error'
            $result.Reason = 'circuit_open_after_consecutive_transient_failures'
            $results.Add([pscustomobject]$result)
            continue
        }

        $address = @{
            Street = $addressParts[0]
            HouseNumber = $addressParts[1]
            Postcode = $addressParts[2]
            Municipality = $addressParts[3]
        }
        $resolution = Resolve-PhotonAddress -GeocoderUri $geocoderUri -Address $address -Cache $addressCache
        $result.Status = $resolution.Status
        $result.Reason = $resolution.Reason
        $result.CandidateCount = $resolution.CandidateCount
        $result.Candidates = $resolution.Candidates
        $result.GeocoderAttempts = $resolution.GeocoderAttempts
        $result.FromCache = $resolution.FromCache
        $result.Latitude = $resolution.Latitude
        $result.Longitude = $resolution.Longitude

        if (-not $resolution.FromCache -and $resolution.GeocoderAttempts -gt 0) {
            if ($resolution.IsTransientFailure) {
                $consecutiveTransientFailures++
                if ($consecutiveTransientFailures -ge 3) {
                    $geocoderCircuitOpen = $true
                }
            }
            else {
                $consecutiveTransientFailures = 0
            }
        }

        $results.Add([pscustomobject]$result)
    }

    $parser.Close()
    $parser = $null

    $validCount = @($results | Where-Object Status -eq 'valid').Count
    $geocoderErrorCount = @($results | Where-Object Status -eq 'geocoder_error').Count
    $problemCount = $results.Count - $validCount - $geocoderErrorCount
    $statusCounts = [ordered]@{}
    foreach ($statusGroup in ($results | Group-Object -Property Status)) {
        $statusCounts[$statusGroup.Name] = $statusGroup.Count
    }
    $report = [ordered]@{
        CreatedAtUtc = [DateTime]::UtcNow.ToString('o')
        TotalRecords = $results.Count
        Valid = $validCount
        Problems = $problemCount
        GeocoderErrors = $geocoderErrorCount
        StatusCounts = $statusCounts
        Results = $results.ToArray()
    }

    $reportJson = $report | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($reportPath, $reportJson, [System.Text.UTF8Encoding]::new($false))
    [Console]::Out.WriteLine('Address check completed: {0} records, {1} valid, {2} problems, {3} geocoder errors.', $results.Count, $validCount, $problemCount, $geocoderErrorCount)

    if ($geocoderErrorCount -gt 0) {
        exit 3
    }
    if ($problemCount -gt 0) {
        exit 2
    }
    exit 0
}
catch {
    [Console]::Error.WriteLine('CheckAddresses failed: {0}', $_.Exception.Message)
    exit 1
}
finally {
    if ($null -ne $parser) {
        $parser.Close()
    }
}
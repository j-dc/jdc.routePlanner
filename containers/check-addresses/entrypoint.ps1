[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$inputPath = $env:CHECK_ADDRESSES_INPUT
$reportPath = $env:CHECK_ADDRESSES_REPORT
$geocoderBaseUrl = $env:GEOCODER_BASE_URL
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
    $csvRecordNumber = 1
    while (-not $parser.EndOfData) {
        $fields = $parser.ReadFields()
        $csvRecordNumber++

        $result = [ordered]@{
            CsvRecordNumber = $csvRecordNumber
            Rit = ''
            Status = ''
            CandidateCount = 0
            Latitude = $null
            Longitude = $null
        }

        if ($null -eq $fields -or $fields.Count -ne $expectedHeaders.Count) {
            $result.Status = 'malformed_row'
            $results.Add([pscustomobject]$result)
            continue
        }

        $result.Rit = $fields[0].Trim()
        $addressParts = @($fields[2].Trim(), $fields[3].Trim(), $fields[4].Trim(), $fields[5].Trim())
        if (@($addressParts | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
            $result.Status = 'invalid_address'
            $results.Add([pscustomobject]$result)
            continue
        }

        $addressQuery = $addressParts -join ', '
        $requestBuilder = [System.UriBuilder]::new($geocoderUri)
        $requestBuilder.Query = 'q={0}&limit=2' -f [uri]::EscapeDataString($addressQuery)

        try {
            $geocoderResponse = Invoke-RestMethod `
                -Uri $requestBuilder.Uri `
                -Method Get `
                -TimeoutSec 30 `
                -Headers @{ Accept = 'application/geo+json'; 'User-Agent' = 'jdc.routePlanner/1.0' }
        }
        catch {
            $result.Status = 'geocoder_error'
            $results.Add([pscustomobject]$result)
            continue
        }

        $features = @($geocoderResponse.features)
        $result.CandidateCount = $features.Count
        if ($features.Count -eq 0) {
            $result.Status = 'unresolved'
        }
        elseif ($features.Count -gt 1) {
            $result.Status = 'ambiguous'
        }
        else {
            $coordinates = @($features[0].geometry.coordinates)
            if ($coordinates.Count -lt 2) {
                $result.Status = 'invalid_geocoder_result'
            }
            else {
                $longitude = [double]$coordinates[0]
                $latitude = [double]$coordinates[1]
                if ([double]::IsNaN($longitude) -or [double]::IsInfinity($longitude) -or
                    [double]::IsNaN($latitude) -or [double]::IsInfinity($latitude) -or
                    $longitude -lt -180 -or $longitude -gt 180 -or
                    $latitude -lt -90 -or $latitude -gt 90) {
                    $result.Status = 'invalid_geocoder_result'
                }
                else {
                    $result.Status = 'valid'
                    $result.Longitude = $longitude
                    $result.Latitude = $latitude
                }
            }
        }

        $results.Add([pscustomobject]$result)
    }

    $parser.Close()
    $parser = $null

    $validCount = @($results | Where-Object Status -eq 'valid').Count
    $geocoderErrorCount = @($results | Where-Object Status -eq 'geocoder_error').Count
    $problemCount = $results.Count - $validCount - $geocoderErrorCount
    $report = [ordered]@{
        CreatedAtUtc = [DateTime]::UtcNow.ToString('o')
        TotalRecords = $results.Count
        Valid = $validCount
        Problems = $problemCount
        GeocoderErrors = $geocoderErrorCount
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
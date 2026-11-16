function ConvertTo-PhotonMatchValue {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) {
        return ''
    }

    $normalizedValue = ([string]$Value).Normalize([System.Text.NormalizationForm]::FormKC)
    return [regex]::Replace($normalizedValue.Trim().ToLowerInvariant(), '\s+', ' ')
}

function ConvertTo-PhotonHouseNumberValue {
    param([AllowNull()][object]$Value)

    return (ConvertTo-PhotonMatchValue $Value) -replace '\s+', ''
}

function Test-PhotonCoordinates {
    param([AllowNull()][object[]]$Coordinates)

    if ($null -eq $Coordinates -or $Coordinates.Count -lt 2) {
        return $false
    }

    $longitude = 0.0
    $latitude = 0.0
    $numberStyle = [System.Globalization.NumberStyles]::Float
    $culture = [System.Globalization.CultureInfo]::InvariantCulture
    if (-not [double]::TryParse([string]$Coordinates[0], $numberStyle, $culture, [ref]$longitude) -or
        -not [double]::TryParse([string]$Coordinates[1], $numberStyle, $culture, [ref]$latitude)) {
        return $false
    }

    return -not ([double]::IsNaN($longitude) -or [double]::IsInfinity($longitude) -or
        [double]::IsNaN($latitude) -or [double]::IsInfinity($latitude) -or
        $longitude -lt -180 -or $longitude -gt 180 -or
        $latitude -lt -90 -or $latitude -gt 90)
}

function ConvertTo-PhotonCandidate {
    param(
        [Parameter(Mandatory)][object]$Feature,
        [Parameter(Mandatory)][hashtable]$Address
    )

    $properties = $Feature.properties
    if ($null -eq $properties) {
        $properties = @{}
    }

    $matchedFields = [System.Collections.Generic.List[string]]::new()
    foreach ($field in @(
        @{ Address = 'Street'; Photon = 'street' }
        @{ Address = 'HouseNumber'; Photon = 'housenumber' }
        @{ Address = 'Postcode'; Photon = 'postcode' }
        @{ Address = 'Municipality'; Photon = 'city' }
    )) {
        if ($field.Address -eq 'HouseNumber') {
            $expectedValue = ConvertTo-PhotonHouseNumberValue $Address[$field.Address]
            $actualValue = ConvertTo-PhotonHouseNumberValue $properties.($field.Photon)
        }
        else {
            $expectedValue = ConvertTo-PhotonMatchValue $Address[$field.Address]
            $actualValue = ConvertTo-PhotonMatchValue $properties.($field.Photon)
        }
        if ($expectedValue -and $expectedValue -eq $actualValue) {
            $matchedFields.Add($field.Address)
        }
    }

    $coreAddressMatches = @('Street', 'HouseNumber', 'Postcode' | Where-Object { $matchedFields.Contains($_) }).Count -eq 3
    $expectedMunicipality = ConvertTo-PhotonMatchValue $Address.Municipality
    $actualMunicipality = ConvertTo-PhotonMatchValue $properties.city
    $municipalityMatchState = if (-not $actualMunicipality) { 'missing' } elseif ($expectedMunicipality -eq $actualMunicipality) { 'match' } else { 'mismatch' }

    $coordinates = @($Feature.geometry.coordinates)
    $geometryIsValid = Test-PhotonCoordinates $coordinates
    $longitude = $null
    $latitude = $null
    if ($geometryIsValid) {
        $longitude = [double]::Parse([string]$coordinates[0], [System.Globalization.CultureInfo]::InvariantCulture)
        $latitude = [double]::Parse([string]$coordinates[1], [System.Globalization.CultureInfo]::InvariantCulture)
    }

    $countryCode = [string]$properties.countrycode
    $candidateId = '{0}/{1}' -f $properties.osm_type, $properties.osm_id
    if ($candidateId -eq '/') {
        $candidateId = '{0}|{1}|{2}' -f $longitude, $latitude, $properties.name
    }

    [pscustomobject]@{
        CandidateId = $candidateId
        Name = [string]$properties.name
        Street = [string]$properties.street
        HouseNumber = [string]$properties.housenumber
        Postcode = [string]$properties.postcode
        Municipality = [string]$properties.city
        CountryCode = $countryCode
        MatchedFields = $matchedFields.ToArray()
        MatchedFieldCount = $matchedFields.Count
        IsExactAddressMatch = ($matchedFields.Count -eq 4 -and $countryCode -eq 'be')
        IsStrongAddressMatch = ($coreAddressMatches -and $countryCode -eq 'be')
        MunicipalityMatchState = $municipalityMatchState
        GeometryIsValid = $geometryIsValid
        Longitude = $longitude
        Latitude = $latitude
    }
}

function Invoke-PhotonQuery {
    param(
        [Parameter(Mandatory)][uri]$GeocoderUri,
        [Parameter(Mandatory)][string]$Query,
        [ValidateRange(1, 10)][int]$Limit = 5
    )

    $requestBuilder = [System.UriBuilder]::new($GeocoderUri)
    $requestBuilder.Query = 'q={0}&limit={1}' -f [uri]::EscapeDataString($Query), $Limit

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $response = Invoke-RestMethod `
                -Uri $requestBuilder.Uri `
                -Method Get `
                -TimeoutSec 30 `
                -Headers @{ Accept = 'application/geo+json'; 'User-Agent' = 'jdc.routePlanner/1.0' }

            return [pscustomobject]@{
                Succeeded = $true
                Features = @($response.features)
                Attempts = $attempt
                ErrorCode = ''
                IsTransientFailure = $false
            }
        }
        catch {
            $statusCode = 0
            try {
                $statusCode = [int]$_.Exception.Response.StatusCode
            }
            catch {
                $statusCode = 0
            }

            $isTransient = ($statusCode -eq 0 -or $statusCode -eq 429 -or $statusCode -ge 500)
            if ($statusCode -eq 429) {
                $errorCode = 'http_429'
            }
            elseif ($statusCode -ge 500) {
                $errorCode = 'http_5xx'
            }
            elseif ($statusCode -eq 0) {
                $errorCode = 'network_error'
            }
            else {
                $errorCode = 'http_non_retryable'
            }

            if (-not $isTransient -or $attempt -eq 3) {
                return [pscustomobject]@{
                    Succeeded = $false
                    Features = @()
                    Attempts = $attempt
                    ErrorCode = $errorCode
                    IsTransientFailure = $isTransient
                }
            }

            Start-Sleep -Seconds $attempt
        }
    }
}

function Resolve-PhotonAddress {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][uri]$GeocoderUri,
        [Parameter(Mandatory)][hashtable]$Address,
        [Parameter(Mandatory)][hashtable]$Cache
    )

    $cacheKey = @(
        (ConvertTo-PhotonMatchValue $Address.Street)
        (ConvertTo-PhotonMatchValue $Address.HouseNumber)
        (ConvertTo-PhotonMatchValue $Address.Postcode)
        (ConvertTo-PhotonMatchValue $Address.Municipality)
    ) -join '|'

    if ($Cache.ContainsKey($cacheKey)) {
        $cached = $Cache[$cacheKey]
        return [pscustomobject]@{
            Status = $cached.Status
            Reason = $cached.Reason
            CandidateCount = $cached.CandidateCount
            Candidates = $cached.Candidates
            Longitude = $cached.Longitude
            Latitude = $cached.Latitude
            GeocoderAttempts = 0
            IsTransientFailure = $cached.IsTransientFailure
            FromCache = $true
        }
    }

    $queries = @(
        '{0} {1}, {2} {3}' -f $Address.Street, $Address.HouseNumber, $Address.Postcode, $Address.Municipality
        '{0} {1}, {2} {3}' -f $Address.HouseNumber, $Address.Street, $Address.Postcode, $Address.Municipality
        '{0}, {1} {2}' -f $Address.Street, $Address.Postcode, $Address.Municipality
    )
    $evaluatedCandidates = [System.Collections.Generic.List[object]]::new()
    $seenCandidateIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $seenQueries = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $totalAttempts = 0

    foreach ($query in $queries) {
        $queryKey = ConvertTo-PhotonMatchValue $query
        if (-not $seenQueries.Add($queryKey)) {
            continue
        }

        $queryResult = Invoke-PhotonQuery -GeocoderUri $GeocoderUri -Query $query -Limit 5
        $totalAttempts += $queryResult.Attempts
        if (-not $queryResult.Succeeded) {
            $resolution = [pscustomobject]@{
                Status = 'geocoder_error'
                Reason = $queryResult.ErrorCode
                CandidateCount = $evaluatedCandidates.Count
                Candidates = $evaluatedCandidates.ToArray()
                Longitude = $null
                Latitude = $null
                GeocoderAttempts = $totalAttempts
                IsTransientFailure = $queryResult.IsTransientFailure
                FromCache = $false
            }
            $Cache[$cacheKey] = $resolution
            return $resolution
        }

        foreach ($feature in $queryResult.Features) {
            $candidate = ConvertTo-PhotonCandidate -Feature $feature -Address $Address
            if ($seenCandidateIds.Add($candidate.CandidateId)) {
                $evaluatedCandidates.Add($candidate)
            }
        }

        $exactCandidates = @($evaluatedCandidates | Where-Object IsExactAddressMatch)
        $strongCandidates = @($evaluatedCandidates | Where-Object IsStrongAddressMatch)
        if ($strongCandidates.Count -gt 0) {
            break
        }
    }

    $exactCandidates = @($evaluatedCandidates | Where-Object IsExactAddressMatch)
    $strongCandidates = @($evaluatedCandidates | Where-Object IsStrongAddressMatch)
    $status = 'unresolved'
    $reason = 'no_candidates'
    $longitude = $null
    $latitude = $null

    if ($strongCandidates.Count -gt 1) {
        $municipalityMatches = @($strongCandidates | Where-Object MunicipalityMatchState -eq 'match')
        if ($municipalityMatches.Count -gt 0) {
            $strongCandidates = $municipalityMatches
        }
    }

    if ($strongCandidates.Count -gt 1) {
        $status = 'ambiguous'
        $reason = 'multiple_strong_address_candidates'
    }
    elseif ($strongCandidates.Count -eq 1) {
        if ($strongCandidates[0].GeometryIsValid) {
            $status = 'valid'
            if ($strongCandidates[0].IsExactAddressMatch) {
                $reason = 'exact_address_match'
            }
            elseif ($strongCandidates[0].MunicipalityMatchState -eq 'mismatch') {
                $reason = 'strong_address_match_municipality_differs'
            }
            else {
                $reason = 'strong_address_match_municipality_missing'
            }
            $longitude = $strongCandidates[0].Longitude
            $latitude = $strongCandidates[0].Latitude
        }
        else {
            $status = 'invalid_geocoder_result'
            $reason = 'strong_match_has_invalid_geometry'
        }
    }
    elseif ($evaluatedCandidates.Count -gt 0) {
        $status = 'needs_review'
        $reason = 'no_unique_strong_address_match'
    }

    $resolution = [pscustomobject]@{
        Status = $status
        Reason = $reason
        CandidateCount = $evaluatedCandidates.Count
        Candidates = $evaluatedCandidates.ToArray()
        Longitude = $longitude
        Latitude = $latitude
        GeocoderAttempts = $totalAttempts
        IsTransientFailure = $false
        FromCache = $false
    }
    $Cache[$cacheKey] = $resolution
    return $resolution
}

Export-ModuleMember -Function Resolve-PhotonAddress
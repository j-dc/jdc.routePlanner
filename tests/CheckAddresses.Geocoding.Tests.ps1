Import-Module (Join-Path $PSScriptRoot '..\containers\check-addresses\Geocoding.psm1') -Force

Describe 'Resolve-PhotonAddress' {
    It 'accepts a unique exact Belgian address match' {
        InModuleScope Geocoding {
            $address = @{ Street = 'Kerkstraat'; HouseNumber = '12'; Postcode = '8000'; Municipality = 'Brugge' }
            $cache = @{}
            Mock Invoke-RestMethod {
                [pscustomobject]@{
                    features = @([pscustomobject]@{
                        properties = @{ osm_type = 'N'; osm_id = 1; name = 'Kerkstraat 12'; street = 'Kerkstraat'; housenumber = '12'; postcode = '8000'; city = 'Brugge'; countrycode = 'be' }
                        geometry = @{ coordinates = @(3.2247, 51.2093) }
                    })
                }
            }

            $result = Resolve-PhotonAddress -GeocoderUri ([uri]'http://photon:2322/api/') -Address $address -Cache $cache

            $result.Status | Should Be 'valid'
            $result.Longitude | Should Be 3.2247
            Assert-MockCalled Invoke-RestMethod -Times 1 -Exactly
        }
    }

    It 'sends a single candidate with a mismatched postcode to review' {
        InModuleScope Geocoding {
            $address = @{ Street = 'Kerkstraat'; HouseNumber = '12'; Postcode = '8000'; Municipality = 'Brugge' }
            $cache = @{}
            Mock Invoke-RestMethod {
                [pscustomobject]@{
                    features = @([pscustomobject]@{
                        properties = @{ osm_type = 'N'; osm_id = 2; name = 'Kerkstraat 12'; street = 'Kerkstraat'; housenumber = '12'; postcode = '8200'; city = 'Brugge'; countrycode = 'be' }
                        geometry = @{ coordinates = @(3.2247, 51.2093) }
                    })
                }
            }

            $result = Resolve-PhotonAddress -GeocoderUri ([uri]'http://photon:2322/api/') -Address $address -Cache $cache

            $result.Status | Should Be 'needs_review'
            $result.Reason | Should Be 'no_unique_strong_address_match'
        }
    }

    It 'accepts a unique street, house, and postcode match when Photon omits municipality' {
        InModuleScope Geocoding {
            $address = @{ Street = 'Kerkstraat'; HouseNumber = '3 A'; Postcode = '8000'; Municipality = 'Brugge' }
            $cache = @{}
            Mock Invoke-RestMethod {
                [pscustomobject]@{
                    features = @([pscustomobject]@{
                        properties = @{ osm_type = 'N'; osm_id = 6; street = 'Kerkstraat'; housenumber = '3A'; postcode = '8000'; city = ''; countrycode = 'be' }
                        geometry = @{ coordinates = @(3.2247, 51.2093) }
                    })
                }
            }

            $result = Resolve-PhotonAddress -GeocoderUri ([uri]'http://photon:2322/api/') -Address $address -Cache $cache

            $result.Status | Should Be 'valid'
            $result.Reason | Should Be 'strong_address_match_municipality_missing'
            $result.Candidates[0].MatchedFieldCount | Should Be 3
        }
    }

    It 'accepts a unique core address match when the returned municipality is a different locality label' {
        InModuleScope Geocoding {
            $address = @{ Street = 'Kerkstraat'; HouseNumber = '12'; Postcode = '8791'; Municipality = 'Beveren-Leie' }
            $cache = @{}
            Mock Invoke-RestMethod {
                [pscustomobject]@{
                    features = @([pscustomobject]@{
                        properties = @{ osm_type = 'W'; osm_id = 7; street = 'Kerkstraat'; housenumber = '12'; postcode = '8791'; city = 'Waregem'; countrycode = 'be' }
                        geometry = @{ coordinates = @(3.3, 50.9) }
                    })
                }
            }

            $result = Resolve-PhotonAddress -GeocoderUri ([uri]'http://photon:2322/api/') -Address $address -Cache $cache

            $result.Status | Should Be 'valid'
            $result.Reason | Should Be 'strong_address_match_municipality_differs'
            $result.Candidates[0].MunicipalityMatchState | Should Be 'mismatch'
        }
    }

    It 'marks multiple exact matches as ambiguous' {
        InModuleScope Geocoding {
            $address = @{ Street = 'Kerkstraat'; HouseNumber = '12'; Postcode = '8000'; Municipality = 'Brugge' }
            $cache = @{}
            Mock Invoke-RestMethod {
                [pscustomobject]@{
                    features = @(
                        [pscustomobject]@{ properties = @{ osm_type = 'N'; osm_id = 3; street = 'Kerkstraat'; housenumber = '12'; postcode = '8000'; city = 'Brugge'; countrycode = 'be' }; geometry = @{ coordinates = @(3.2, 51.2) } }
                        [pscustomobject]@{ properties = @{ osm_type = 'W'; osm_id = 4; street = 'Kerkstraat'; housenumber = '12'; postcode = '8000'; city = 'Brugge'; countrycode = 'be' }; geometry = @{ coordinates = @(3.3, 51.3) } }
                    )
                }
            }

            $result = Resolve-PhotonAddress -GeocoderUri ([uri]'http://photon:2322/api/') -Address $address -Cache $cache

            $result.Status | Should Be 'ambiguous'
            $result.CandidateCount | Should Be 2
        }
    }

    It 'retries transient failures and caches duplicate addresses' {
        InModuleScope Geocoding {
            $script:photonRequestCount = 0
            $address = @{ Street = 'Kerkstraat'; HouseNumber = '12'; Postcode = '8000'; Municipality = 'Brugge' }
            $cache = @{}
            Mock Start-Sleep {}
            Mock Invoke-RestMethod {
                $script:photonRequestCount++
                if ($script:photonRequestCount -lt 3) {
                    throw [System.TimeoutException]::new('temporary failure')
                }

                [pscustomobject]@{
                    features = @([pscustomobject]@{
                        properties = @{ osm_type = 'N'; osm_id = 5; street = 'Kerkstraat'; housenumber = '12'; postcode = '8000'; city = 'Brugge'; countrycode = 'be' }
                        geometry = @{ coordinates = @(3.2247, 51.2093) }
                    })
                }
            }

            $firstResult = Resolve-PhotonAddress -GeocoderUri ([uri]'http://photon:2322/api/') -Address $address -Cache $cache
            $secondResult = Resolve-PhotonAddress -GeocoderUri ([uri]'http://photon:2322/api/') -Address $address -Cache $cache

            $firstResult.Status | Should Be 'valid'
            $firstResult.GeocoderAttempts | Should Be 3
            $secondResult.Status | Should Be 'valid'
            $secondResult.FromCache | Should Be $true
            $secondResult.GeocoderAttempts | Should Be 0
            $script:photonRequestCount | Should Be 3
        }
    }
}
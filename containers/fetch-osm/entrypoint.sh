#!/bin/sh
set -eu

mode="${1:-fetch}"

fail() {
    printf 'FetchOsm failed: %s\n' "$1" >&2
    exit 1
}

log() {
    printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

data_root="${OSM_DATA_ROOT:-}"
[ -n "$data_root" ] && [ -d "$data_root" ] || fail 'The OSM data volume is not mounted.'

extract_url='https://download.geofabrik.de/europe/belgium-latest.osm.pbf'
extract_name='belgium-latest.osm.pbf'
extract_path="$data_root/$extract_name"
partial_path="$data_root/.$extract_name.partial"
checksum_partial_path="$data_root/.$extract_name.md5.partial"
metadata_path="$data_root/fetch-metadata.json"
metadata_partial_path="$data_root/.fetch-metadata.json.partial"

if [ "$mode" = 'inspect' ]; then
    if [ ! -s "$extract_path" ]; then
        printf 'OSM_MISSING\n'
        exit 0
    fi

    fetched_at=''
    if [ -f "$metadata_path" ]; then
        fetched_at="$(sed -n 's/.*"fetchedAtUtc": "\([^"]*\)".*/\1/p' "$metadata_path")"
    fi
    if [ -z "$fetched_at" ]; then
        fetched_at="$(date -u -r "$extract_path" +%Y-%m-%dT%H:%M:%SZ)" \
            || fail 'Could not determine the OSM extract date.'
    fi
    printf 'OSM_PRESENT|%s\n' "$fetched_at"
    exit 0
fi

if [ "$mode" != 'fetch' ]; then
    fail "Unsupported mode '$mode'. Expected 'inspect' or 'fetch'."
fi

cleanup() {
    rm -f "$partial_path" "$checksum_partial_path" "$metadata_partial_path"
}
trap cleanup EXIT

log 'Fetching the Geofabrik Belgium extract checksum.'
checksum_text="$(curl --fail --location --silent --show-error --retry 3 "$extract_url.md5")" \
    || fail 'Could not download the extract checksum.'
expected_md5="$(printf '%s\n' "$checksum_text" | grep -Eo '[[:xdigit:]]{32}' | head -n 1)" \
    || fail 'The extract checksum response did not contain an MD5 checksum.'
[ -n "$expected_md5" ] || fail 'The extract checksum response was empty.'

log 'Downloading the latest Geofabrik Belgium extract; curl progress follows.'
curl --fail --location --show-error --progress-bar --retry 3 --output "$partial_path" "$extract_url" \
    || fail 'Could not download the Geofabrik Belgium extract.'

actual_md5="$(md5sum "$partial_path" | cut -d ' ' -f 1)"
if [ "${actual_md5}" != "${expected_md5}" ]; then
    fail 'The downloaded extract failed its MD5 integrity check.'
fi

fetched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{\n  "source": "%s",\n  "coverage": "Belgium (includes West Flanders)",\n  "fetchedAtUtc": "%s",\n  "md5": "%s"\n}\n' \
    "$extract_url" "$fetched_at" "$actual_md5" > "$metadata_partial_path"

mv -f "$partial_path" "$extract_path" \
    || fail 'Could not activate the verified OSM extract.'
mv -f "$metadata_partial_path" "$metadata_path" \
    || fail 'The OSM extract was updated, but its metadata could not be written.'

log "Verified extract stored at $extract_path."
printf 'FetchOsm completed: %s (%s; MD5 %s).\n' "$extract_name" "$fetched_at" "$actual_md5"
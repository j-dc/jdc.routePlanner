#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:-serve}"
photon_jar="${PHOTON_JAR:-/app/photon.jar}"

fail() {
    printf 'Photon container failed: %s\n' "$1" >&2
    exit 1
}

log() {
    printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

update_database() {
    local data_root="${GEOCODER_DATA_ROOT:-}"
    [[ -n "$data_root" && -d "$data_root" ]] || fail 'The geocoder data volume is not mounted.'

    local dump_url='https://download1.graphhopper.com/public/europe/photon-dump-europe-1.0-latest.jsonl.zst'
    local dump_file_name="${dump_url##*/}"
    local download_dir="$data_root/downloads"
    local dump_path="$download_dir/$dump_file_name"
    local partial_path="$dump_path.partial"
    local current_path="$data_root/current"
    local backup_path="$data_root/previous-$(date -u +%Y%m%dT%H%M%SZ)"
    local staging_path=''
    local current_moved=0

    mkdir -p "$download_dir"
    staging_path="$(mktemp -d "$data_root/staging.XXXXXX")"

    cleanup() {
        if [[ -n "$staging_path" && -d "$staging_path" ]]; then
            rm -rf -- "$staging_path"
        fi
        if [[ -f "$partial_path" ]]; then
            rm -f -- "$partial_path"
        fi
    }
    trap cleanup EXIT

    local checksum_text expected_md5 actual_md5
    log 'Fetching the Photon dump checksum.'
    checksum_text="$(curl --fail --location --silent --show-error --max-time 60 "$dump_url.md5")" \
        || fail 'Could not download the Photon dump checksum.'
    expected_md5="$(printf '%s\n' "$checksum_text" | grep -Eo '[[:xdigit:]]{32}' | head -n 1 || true)"
    [[ -n "$expected_md5" ]] || fail 'The Photon dump checksum endpoint returned an invalid response.'

    if [[ -f "$dump_path" ]]; then
        log 'Validating the existing Photon dump checksum.'
        actual_md5="$(md5sum "$dump_path" | cut -d ' ' -f 1)"
        if [[ "${actual_md5,,}" != "${expected_md5,,}" ]]; then
            log 'Existing Photon dump checksum is invalid; removing the cached file.'
            rm -f -- "$dump_path"
        fi
    fi

    if [[ ! -f "$dump_path" ]]; then
        log "Downloading Photon Europe dump to $partial_path; curl percentage progress follows."
        curl --fail --location --show-error --progress-bar --retry 3 --output "$partial_path" "$dump_url" \
            || fail 'Could not download the Photon Europe dump.'
        log 'Download finished; verifying the Photon dump checksum.'
        actual_md5="$(md5sum "$partial_path" | cut -d ' ' -f 1)"
        if [[ "${actual_md5,,}" != "${expected_md5,,}" ]]; then
            rm -f -- "$partial_path"
            fail 'The downloaded Photon dump failed its MD5 integrity check.'
        fi
        mv -- "$partial_path" "$dump_path"
    else
        log 'Using the checksum-verified cached Photon dump.'
    fi

    local dump_size
    dump_size="$(stat -c '%s' "$dump_path")"
    log 'Importing Belgium-only records into a staging database; pv reports progress as the compressed dump is consumed by Photon.'
    (
        cd "$staging_path"
        pv --force --interval 5 --size "$dump_size" "$dump_path" \
            | zstd --decompress --stdout \
            | java -jar "$photon_jar" import -import-file - -country-codes BE
    ) || fail 'Photon Belgium database import failed.'

    log 'Photon import process finished; validating the staging database.'
    local staged_database="$staging_path/photon_data"
    [[ -d "$staged_database" && -n "$(find "$staged_database" -mindepth 1 -maxdepth 1 -print -quit)" ]] \
        || fail 'Photon import finished without producing a database.'

    if [[ -e "$current_path" ]]; then
        log 'Moving the current Photon database to its rollback location.'
        mv -- "$current_path" "$backup_path"
        current_moved=1
    fi

    if ! mv -- "$staging_path" "$current_path"; then
        if (( current_moved == 1 )) && [[ ! -e "$current_path" && -e "$backup_path" ]]; then
            mv -- "$backup_path" "$current_path"
        fi
        fail 'Could not activate the new Photon database; the previous database was restored.'
    fi

    staging_path=''
    trap - EXIT
    log 'Belgium-only Photon database activated successfully.'
    printf 'Photon database updated with Belgium-only data. Previous database, if any, remains available for rollback.\n'
}

case "$mode" in
    serve)
        log 'Starting the Photon server.'
        data_root="${PHOTON_DATA_ROOT:-}"
        [[ -n "$data_root" ]] || fail 'PHOTON_DATA_ROOT is not configured.'
        [[ -d "$data_root/current/photon_data" ]] \
            || fail 'Photon database is not initialized. Run ./scripts/updateGeocodeDatabase.ps1 first.'
        cd "$data_root/current"
        exec java -jar "$photon_jar" serve -listen-ip 0.0.0.0 -listen-port 2322
        ;;
    update)
        update_database
        ;;
    *)
        fail "Unsupported mode '$mode'. Expected 'serve' or 'update'."
        ;;
esac
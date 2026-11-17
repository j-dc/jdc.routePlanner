import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


VERSION_PATTERN = re.compile(r"^[0-9]{8}T[0-9]{13}Z$")
OBJECT_PATTERN = re.compile(r"^([NWR])/([1-9][0-9]*)$", re.IGNORECASE)


def get_version():
    version = os.environ.get("CHECK_ADDRESSES_VERSION", "")
    if not version:
        version_file = os.environ.get("CHECK_ADDRESSES_VERSION_FILE", "")
        version = Path(version_file).read_text(encoding="utf-8").strip() if version_file else "legacy"
    if version != "legacy":
        if not VERSION_PATTERN.fullmatch(version):
            raise ValueError("Invalid version.")
        datetime.datetime.strptime(version[:21] + "Z", "%Y%m%dT%H%M%S%fZ")
    return version


def main():
    version = get_version()
    suffix = "" if version == "legacy" else f"-{version}"
    report_path = Path(os.environ.get("GEOMETRY_REPORT_DIR", "/source")) / f"address-check{suffix}.json"
    output_path = Path(os.environ.get("GEOMETRY_OUTPUT_DIR", "/output")) / f"osm-geometry{suffix}.geojson"
    osm_path = Path(os.environ.get("OSM_PBF_PATH", "/osm/belgium-latest.osm.pbf"))
    report_bytes = report_path.read_bytes()
    report = json.loads(report_bytes)
    if not osm_path.is_file():
        raise FileNotFoundError("The local OSM extract is unavailable.")

    requested = {}
    unidentifiable = []
    seen_candidates = set()

    def collect_candidates(record_number, candidates, key):
        for candidate in candidates:
            candidate_id = candidate.get(key, "")
            if (record_number, candidate_id) in seen_candidates:
                continue
            seen_candidates.add((record_number, candidate_id))
            match = OBJECT_PATTERN.fullmatch(candidate_id)
            if not match or int(match.group(2)) > 9223372036854775807:
                unidentifiable.append({"recordNumber": record_number, "candidateId": candidate_id})
                continue
            object_id = f"{match.group(1).upper()}/{match.group(2)}"
            requested.setdefault(object_id, set()).add(record_number)

    for record in report["Results"]:
        collect_candidates(record["CsvRecordNumber"], record.get("Candidates", []), "CandidateId")

    review_path = Path(os.environ.get("GEOMETRY_REVIEW_DIR", "/review")) / f"address-review{suffix}.json"
    if review_path.is_file():
        input_path = Path(os.environ.get("GEOMETRY_INPUT_DIR", "/input")) / f"ritten{suffix}.csv"
        review = json.loads(review_path.read_bytes())
        fingerprint = hashlib.sha256(report_bytes + input_path.read_bytes()).hexdigest().upper()
        if review.get("sourceFingerprint", "").upper() == fingerprint:
            for record in review.get("records", []):
                collect_candidates(record["csvRecordNumber"], record.get("candidates", []), "candidateId")

    features_by_id = {}
    found = set()
    with tempfile.TemporaryDirectory(prefix="osm-geometry-") as temporary_directory:
        temporary = Path(temporary_directory)
        if requested:
            id_path = temporary / "ids.txt"
            id_path.write_text("".join(f"{object_id[0].lower()}{object_id[2:]}\n" for object_id in requested), encoding="ascii")
            selected_path = temporary / "selected.osm.pbf"
            extract = subprocess.run(
                ["osmium", "getid", "--add-referenced", "--remove-tags", "--no-progress", "--id-file", str(id_path),
                 "--output", str(selected_path), str(osm_path)],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=False,
            )
            if extract.returncode not in (0, 1) or not selected_path.is_file():
                raise RuntimeError("The local OSM objects could not be extracted.")
            if extract.returncode == 1:
                subprocess.run(["osmium", "fileinfo", "--extended", "--no-progress", str(osm_path)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
            exported_path = temporary / "features.geojson"
            subprocess.run(
                ["osmium", "export", "--keep-untagged", "--add-unique-id", "type_id", "--no-progress",
                 "--output", str(exported_path), str(selected_path)],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True,
            )
            exported = json.loads(exported_path.read_text(encoding="utf-8"))
            for feature in exported["features"]:
                raw_id = str(feature.get("id", ""))
                if not re.fullmatch(r"[nwa][1-9][0-9]*", raw_id):
                    continue
                if raw_id[0] == "a":
                    area_id = int(raw_id[1:])
                    object_id = f"{'R' if area_id % 2 else 'W'}/{area_id // 2}"
                else:
                    object_id = f"{raw_id[0].upper()}/{raw_id[1:]}"
                if object_id not in requested or not feature.get("geometry"):
                    continue
                existing = features_by_id.get(object_id)
                if existing and feature["geometry"]["type"] not in ("Polygon", "MultiPolygon"):
                    continue
                features_by_id[object_id] = {"type": "Feature", "id": object_id, "geometry": feature["geometry"],
                                             "properties": {"candidateId": object_id, "recordNumbers": sorted(requested[object_id])}}
                found.add(object_id)

    result = {
        "type": "FeatureCollection",
        "features": list(features_by_id.values()),
        "metadata": {
            "version": version,
            "sourceReportSha256": hashlib.sha256(report_bytes).hexdigest().upper(),
            "inputSha256": report.get("InputSha256"),
            "createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "missingObjects": [{"candidateId": object_id, "recordNumbers": sorted(requested[object_id])}
                               for object_id in sorted(requested.keys() - found)],
            "unidentifiableCandidates": unidentifiable,
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output_path.parent, delete=False) as output:
            temporary_path = Path(output.name)
            json.dump(result, output, ensure_ascii=False, separators=(",", ":"))
        os.replace(temporary_path, output_path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    print(f"OSM geometry completed: {len(features_by_id)} features, {len(requested) - len(found)} missing objects, {len(unidentifiable)} unidentified candidates.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError, RuntimeError) as error:
        print(f"OSM geometry failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
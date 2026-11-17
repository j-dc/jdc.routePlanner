import json
import hashlib
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


VERSION = "20261117T1234561234567Z"
OSM = """<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="50.0" lon="3.0"><tag k="addr:housenumber" v="1"/></node>
  <node id="2" lat="50.0" lon="3.01"/><node id="3" lat="50.01" lon="3.01"/><node id="4" lat="50.01" lon="3.0"/>
  <node id="5" lat="50.02" lon="3.02"/><node id="6" lat="50.02" lon="3.03"/><node id="7" lat="50.03" lon="3.03"/><node id="8" lat="50.03" lon="3.02"/>
  <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/><tag k="building" v="yes"/></way>
  <way id="11"><nd ref="5"/><nd ref="6"/><nd ref="7"/><nd ref="8"/><nd ref="5"/></way>
  <relation id="20"><member type="way" ref="11" role="outer"/><tag k="type" v="multipolygon"/><tag k="building" v="yes"/></relation>
</osm>"""


class ExtractOsmGeometryTests(unittest.TestCase):
    def test_extracts_local_objects_and_reports_missing_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            xml_path = root / "synthetic.osm"
            pbf_path = root / "synthetic.osm.pbf"
            xml_path.write_text(OSM, encoding="utf-8")
            subprocess.run(["osmium", "cat", str(xml_path), "-o", str(pbf_path)], check=True)
            report = {"InputSha256": "INPUT", "Results": [
                {"CsvRecordNumber": 2, "Candidates": [{"CandidateId": "N/1"}, {"CandidateId": "W/10"}]},
                {"CsvRecordNumber": 3, "Candidates": [{"CandidateId": "W/10"}, {"CandidateId": "R/20"},
                                                      {"CandidateId": "W/999"}, {"CandidateId": "fallback"}]},
            ]}
            report_path = root / f"address-check-{VERSION}.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            input_path = root / f"ritten-{VERSION}.csv"
            input_path.write_bytes(b"synthetic input")
            review_path = root / f"address-review-{VERSION}.json"
            review = {"sourceFingerprint": hashlib.sha256(report_path.read_bytes() + input_path.read_bytes()).hexdigest(),
                      "records": [{"csvRecordNumber": 2, "candidates": [{"candidateId": "N/5"}]}]}
            review_path.write_text(json.dumps(review), encoding="utf-8")
            environment = dict(os.environ, CHECK_ADDRESSES_VERSION=VERSION, GEOMETRY_REPORT_DIR=directory,
                               GEOMETRY_OUTPUT_DIR=directory, GEOMETRY_INPUT_DIR=directory,
                               GEOMETRY_REVIEW_DIR=directory, OSM_PBF_PATH=str(pbf_path))
            subprocess.run(["python3", "/app/entrypoint.py"], env=environment, check=True)
            data = json.loads((root / f"osm-geometry-{VERSION}.geojson").read_text(encoding="utf-8"))
            features = {feature["id"]: feature for feature in data["features"]}
            self.assertEqual(set(features), {"N/1", "N/5", "W/10", "R/20"})
            self.assertEqual(features["N/1"]["geometry"]["type"], "Point")
            self.assertIn(features["W/10"]["geometry"]["type"], ("Polygon", "MultiPolygon"))
            self.assertEqual(features["R/20"]["geometry"]["type"], "MultiPolygon")
            self.assertEqual(features["W/10"]["properties"]["recordNumbers"], [2, 3])
            self.assertEqual(data["metadata"]["missingObjects"], [{"candidateId": "W/999", "recordNumbers": [3]}])
            self.assertEqual(data["metadata"]["unidentifiableCandidates"][0]["candidateId"], "fallback")
            review["sourceFingerprint"] = "STALE"
            review_path.write_text(json.dumps(review), encoding="utf-8")
            subprocess.run(["python3", "/app/entrypoint.py"], env=environment, check=True)
            stale_data = json.loads((root / f"osm-geometry-{VERSION}.geojson").read_text(encoding="utf-8"))
            self.assertNotIn("N/5", {feature["id"] for feature in stale_data["features"]})

    def test_missing_extract_preserves_existing_geojson(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / f"address-check-{VERSION}.json").write_text(json.dumps({"Results": []}), encoding="utf-8")
            output = root / f"osm-geometry-{VERSION}.geojson"
            output.write_text("existing", encoding="utf-8")
            environment = dict(os.environ, CHECK_ADDRESSES_VERSION=VERSION, GEOMETRY_REPORT_DIR=directory,
                               GEOMETRY_OUTPUT_DIR=directory, OSM_PBF_PATH=str(root / "missing.pbf"))
            result = subprocess.run(["python3", "/app/entrypoint.py"], env=environment, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_text(encoding="utf-8"), "existing")

    def test_version_file_and_invalid_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version_file = root / "version"
            version_file.write_text("20269999T1234561234567Z", encoding="utf-8")
            environment = dict(os.environ, CHECK_ADDRESSES_VERSION="", CHECK_ADDRESSES_VERSION_FILE=str(version_file))
            result = subprocess.run(["python3", "/app/entrypoint.py"], env=environment, capture_output=True)
            self.assertNotEqual(result.returncode, 0)

    def test_invalid_pbf_does_not_replace_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / f"address-check-{VERSION}.json").write_text(json.dumps({"Results": [
                {"CsvRecordNumber": 2, "Candidates": [{"CandidateId": "W/10"}]},
            ]}), encoding="utf-8")
            pbf = root / "invalid.pbf"
            pbf.write_text("invalid", encoding="utf-8")
            output = root / f"osm-geometry-{VERSION}.geojson"
            output.write_text("existing", encoding="utf-8")
            environment = dict(os.environ, CHECK_ADDRESSES_VERSION=VERSION, GEOMETRY_REPORT_DIR=directory,
                               GEOMETRY_OUTPUT_DIR=directory, OSM_PBF_PATH=str(pbf))
            result = subprocess.run(["python3", "/app/entrypoint.py"], env=environment, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_text(encoding="utf-8"), "existing")


if __name__ == "__main__":
    unittest.main()
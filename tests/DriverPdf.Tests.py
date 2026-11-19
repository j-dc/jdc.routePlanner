import base64
import http.client
import json
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import zlib

from reportlab.pdfgen.canvas import Canvas

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "containers" / "driver-pdf"))
import renderer
import server


def snapshot():
    return {
        "version": "legacy",
        "locations": [
            {"csvRecordNumber": None, "latitude": 50.0, "longitude": 4.0},
            {"csvRecordNumber": 2, "latitude": 50.001, "longitude": 4.001},
            {"csvRecordNumber": 3, "latitude": 50.001, "longitude": 4.001},
        ],
        "deliveries": [
            {"csvRecordNumber": number, "name": f"Test {number} Élodie", "street": "Teststraat",
             "houseNumber": "1", "postcode": "1000", "municipality": "Test",
             "packageCount": number, "bellen": "Ja", "remarkUpper": "A" * 2500 + " EIND",
             "remarkLower": "Tweede noot"}
            for number in (2, 3)
        ],
        "routes": [{"driver": 1, "trips": [
            {"stops": [{"csvRecordNumber": 2, "matrixIndex": 1, "packageCount": 2},
                       {"csvRecordNumber": 3, "matrixIndex": 2, "packageCount": 3}]}]}],
    }


class DriverPdfTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="driver-pdf-test-", dir=Path.cwd())
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def test_pdf_contains_ordered_deliveries_without_maps(self):
        output = self.root / "output"
        output.mkdir()
        with self.assertLogs("driver_pdf", level="INFO") as logs:
            renderer.render(snapshot(), output)
        messages = "\n".join(logs.output)
        for expected in ("PDF-invoer geldig", "Chauffeur 1: PDF voltooid"):
            self.assertIn(expected, messages)
        for private_value in ("Élodie", "Teststraat", "50.001", "4.001"):
            self.assertNotIn(private_value, messages)
        files = list(output.iterdir())
        self.assertEqual([p.name for p in files], ["chauffeur-1.pdf"])
        pdf = files[0].read_bytes()
        self.assertTrue(pdf.startswith(b"%PDF-"))
        self.assertEqual(pdf.count(b"geo:50.001,4.001"), 2)
        self.assertNotIn(b"/Subtype /Image", pdf)
        streams = re.findall(rb"/ASCII85Decode\s*/FlateDecode.*?stream\r?\n(.*?)endstream", pdf, re.S)
        content = b"\n".join(zlib.decompress(base64.a85decode(stream.strip(), adobe=True))
                             for stream in streams)
        self.assertLess(content.index(b"Test 2"), content.index(b"Test 3"))
        for expected in (b"Chauffeur 1", b"Teststraat 1", b"2 Pakketten", b"3 Pakketten",
                         b"Bellen", b"Opmerking:"):
            self.assertIn(expected, content)
        self.assertEqual(content.count(b"EIND"), 2)
        self.assertNotIn(b"Tweede noot", content)
        self.assertNotIn(b"(opmerking:)", content)
        self.assertNotIn(b"OpenStreetMap", content)

    def test_delivery_columns_are_side_by_side(self):
        data = snapshot()
        for delivery in data["deliveries"]:
            delivery["remarkUpper"] = "Korte notitie"
        output = self.root / "output"
        output.mkdir()
        renderer.render(data, output)
        pdf = (output / "chauffeur-1.pdf").read_bytes()
        streams = re.findall(rb"/ASCII85Decode\s*/FlateDecode.*?stream\r?\n(.*?)endstream", pdf, re.S)
        content = b"\n".join(zlib.decompress(base64.a85decode(stream.strip(), adobe=True))
                             for stream in streams)

        def position(label):
            pattern = (rb"1 0 0 1 ([0-9.]+) ([0-9.]+) cm\s+q\s+"
                       rb"(?:0 0 0 rg\s+)?BT [^\n]*\(" + re.escape(label) + rb"[^)]*\)")
            match = re.search(pattern, content)
            self.assertIsNotNone(match, label)
            return float(match.group(1)), float(match.group(2))

        stop_x, stop_y = position(b"Stop 1")
        name_x, _ = position(b"Test 2")
        packages_x, packages_y = position(b"2 Pakketten")
        bellen_x, _ = position(b"Bellen:")
        remark_x, _ = position(b"Opmerking:")
        self.assertEqual(stop_x, name_x)
        self.assertGreater(packages_x - stop_x, 200)
        self.assertLess(abs(packages_y - stop_y), 15)
        self.assertEqual((packages_x, packages_x), (bellen_x, remark_x))

    def test_horizontal_line_between_deliveries_in_different_trips(self):
        data = snapshot()
        for delivery in data["deliveries"]:
            delivery["remarkUpper"] = "Bovenste veld"
        second_stop = data["routes"][0]["trips"][0]["stops"].pop()
        data["routes"][0]["trips"].append({"stops": [second_stop]})
        output = self.root / "output"
        output.mkdir()
        lines = []
        original_line = Canvas.line

        def record_line(canvas, x1, y1, x2, y2):
            lines.append((x1, y1, x2, y2))
            return original_line(canvas, x1, y1, x2, y2)

        with mock.patch.object(Canvas, "line", autospec=True, side_effect=record_line):
            renderer.render(data, output)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0][1], lines[0][3])
        self.assertGreater(lines[0][2], lines[0][0])

    def test_rejects_bad_snapshots(self):
        output = self.root / "output"
        output.mkdir()
        cases = []
        bad = snapshot()
        bad["routes"][0]["trips"][0]["stops"].pop()
        cases.append(bad)
        bad = snapshot()
        bad["locations"][1]["latitude"] = float("nan")
        cases.append(bad)
        bad = snapshot()
        bad["deliveries"][0]["packageCount"] = 99
        cases.append(bad)
        for bad in cases:
            with self.subTest(bad=bad), self.assertRaises(renderer.InvalidSnapshot):
                renderer.render(bad, output)
        self.assertEqual(list(output.iterdir()), [])

    def test_driver_files_keep_their_own_stops_and_navigation(self):
        data = snapshot()
        data["locations"][2]["latitude"] = 50.002
        data["locations"][2]["longitude"] = 4.002
        second_stop = data["routes"][0]["trips"][0]["stops"].pop()
        data["routes"].append({"driver": 2, "trips": [{"stops": [second_stop]}]})
        output = self.root / "output"
        output.mkdir()
        renderer.render(data, output)
        first = (output / "chauffeur-1.pdf").read_bytes()
        second = (output / "chauffeur-2.pdf").read_bytes()
        self.assertIn(b"geo:50.001,4.001", first)
        self.assertNotIn(b"geo:50.002,4.002", first)
        self.assertIn(b"geo:50.002,4.002", second)
        self.assertNotIn(b"geo:50.001,4.001", second)

    def test_server_lifecycle_and_freshness(self):
        root = self.root / "driver-pdfs"
        initial = json.dumps(snapshot()).encode()
        started = threading.Event()
        proceed = threading.Event()
        changed = [False]

        def fake_api(version, endpoint):
            if endpoint == "route-calculation":
                return b'{"state":"completed"}'
            if endpoint == "driver-pdf-data":
                return initial + (b" " if changed[0] else b"")
            self.fail(f"Unexpected endpoint: {endpoint}")

        def fake_render(data, directory):
            started.set()
            self.assertTrue(proceed.wait(5))
            (directory / "driver.pdf").write_bytes(b"synthetic")

        with mock.patch.object(server, "ROOT", root), mock.patch.object(server, "api_get", fake_api), \
             mock.patch.object(server, "render", fake_render):
            server.ACTIVE = None
            httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            thread = threading.Thread(target=httpd.serve_forever)
            thread.start()
            def request(method, path, body=None):
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                connection.request(method, path, body, {"Content-Type": "application/json"})
                response = connection.getresponse()
                result = response.status, json.loads(response.read())
                connection.close()
                return result
            try:
                self.assertEqual(request("POST", "/start", '{"version":"../x"}')[0], 400)
                self.assertEqual(request("POST", "/start", '{"version":"legacy"}')[0], 202)
                self.assertTrue(started.wait(5))
                self.assertEqual(request("GET", "/status/legacy")[1]["state"], "running")
                self.assertEqual(request("POST", "/start", '{"version":"legacy"}')[0], 409)
                proceed.set()
                self.wait_for_state(request, "completed")
                result = request("GET", "/status/legacy")[1]
                completed = self.root / result["outputDirectory"]
                self.assertTrue((completed / "driver.pdf").is_file())
                started.clear()
                changed[0] = False
                proceed.clear()
                self.assertEqual(request("POST", "/start", '{"version":"legacy"}')[0], 202)
                self.assertTrue(started.wait(5))
                changed[0] = True
                proceed.set()
                self.wait_for_state(request, "failed")
                self.assertTrue(completed.exists())
                self.assertFalse(any(p.name.startswith(".staging-") for p in (root / "legacy").iterdir()))
                server.write_status("legacy", {"state": "running"})
                self.assertEqual(request("GET", "/status/legacy")[1]["state"], "failed")
            finally:
                proceed.set()
                httpd.shutdown()
                httpd.server_close()
                thread.join()
                server.ACTIVE = None

    def test_failure_logs_phase_and_type_without_exception_details(self):
        root = self.root / "driver-pdfs"
        (root / "legacy").mkdir(parents=True)
        with mock.patch.object(server, "ROOT", root), \
             mock.patch.object(server, "api_get", side_effect=ValueError("private address")), \
             self.assertLogs("driver_pdf", level="INFO") as logs:
            server.generate("legacy")
            self.assertEqual(server.read_status("legacy")["state"], "failed")
        messages = "\n".join(logs.output)
        self.assertIn("routestatus controleren (ValueError)", messages)
        self.assertNotIn("private address", messages)

    def wait_for_state(self, request, state):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if request("GET", "/status/legacy")[1]["state"] == state:
                return
            time.sleep(.02)
        self.fail(f"Status did not become {state}")


if __name__ == "__main__":
    unittest.main()

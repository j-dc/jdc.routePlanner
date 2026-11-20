import base64
import hashlib
import http.client
from io import BytesIO
import json
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit
import zlib

from reportlab.pdfgen.canvas import Canvas
from PIL import Image

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
        "routes": [{"driver": 1, "distanceMeters": 12345, "totalDurationSeconds": 3601, "trips": [
            {"stops": [{"csvRecordNumber": 2, "matrixIndex": 1, "packageCount": 2},
                       {"csvRecordNumber": 3, "matrixIndex": 2, "packageCount": 3}]}]}],
    }


def maps_for(data):
    maps = {}
    for route in data["routes"]:
        buffer = BytesIO()
        Image.new("RGB", (20, 10), (route["driver"], 50, 100)).save(buffer, format="PNG")
        maps[route["driver"]] = buffer.getvalue()
    return maps


def write_maps(directory, data, raw):
    directory.mkdir()
    maps = maps_for(data)
    for driver, image in maps.items():
        (directory / f"chauffeur-{driver}.png").write_bytes(image)
    manifest = {"snapshotSha256": hashlib.sha256(raw).hexdigest(),
                "maps": {str(driver): hashlib.sha256(image).hexdigest() for driver, image in maps.items()}}
    (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return maps


class DriverPdfTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="driver-pdf-test-", dir=Path.cwd())
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def test_pdf_contains_map_between_summary_and_route_links(self):
        output = self.root / "output"
        output.mkdir()
        with self.assertLogs("driver_pdf", level="INFO") as logs:
            renderer.render(snapshot(), output, maps_for(snapshot()))
        messages = "\n".join(logs.output)
        for expected in ("PDF-invoer geldig", "Chauffeur 1: PDF voltooid"):
            self.assertIn(expected, messages)
        for private_value in ("Élodie", "Teststraat", "50.001", "4.001"):
            self.assertNotIn(private_value, messages)
        files = list(output.iterdir())
        self.assertEqual([p.name for p in files], ["chauffeur-1.pdf"])
        pdf = files[0].read_bytes()
        self.assertTrue(pdf.startswith(b"%PDF-"))
        self.assertEqual(pdf.count(b"https://www.google.com/maps/dir/?api=1&destination=50.001%2C4.001&travelmode=driving"), 2)
        self.assertEqual(pdf.count(b"https://maps.apple.com/?daddr=50.001%2C4.001"), 2)
        self.assertNotIn(b"geo:", pdf)
        self.assertIn(b"/Subtype /Image", pdf)
        streams = re.findall(rb"/ASCII85Decode\s*/FlateDecode.*?stream\r?\n(.*?)endstream", pdf, re.S)
        content = b"\n".join(zlib.decompress(base64.a85decode(stream.strip(), adobe=True))
                             for stream in streams)
        self.assertLess(content.index(b"Test 2"), content.index(b"Test 3"))
        for expected in (b"Chauffeur 1", b"Teststraat 1", b"Google maps", b"Apple maps",
                         b"Totaal aantal pakketten: 5", b"Aantal adressen: 2",
                         b"Geschatte afstand: 12,3 km", b"Geschatte tijd: 61 minuten",
                         b"2 Pakketten", b"3 Pakketten",
                         b"Bellen", b"Opmerking:"):
            self.assertIn(expected, content)
        self.assertLess(content.index(b"Chauffeur 1"), content.index(b"Totaal aantal pakketten: 5"))
        self.assertLess(content.index(b"Totaal aantal pakketten: 5"), content.index(b"Aantal adressen: 2"))
        self.assertLess(content.index(b"Geschatte tijd: 61 minuten"), content.index(b"/FormXob."))
        self.assertLess(content.index(b"/FormXob."), content.index(b"Google Maps route deel"))
        self.assertIn(b"OpenStreetMap contributors", content)
        self.assertIn(b"https://www.openstreetmap.org/copyright", pdf)
        self.assertEqual(content.count(b"EIND"), 2)
        self.assertNotIn(b"Tweede noot", content)
        self.assertNotIn(b"(opmerking:)", content)

    def test_delivery_columns_are_side_by_side(self):
        data = snapshot()
        for delivery in data["deliveries"]:
            delivery["remarkUpper"] = "Korte notitie"
        output = self.root / "output"
        output.mkdir()
        renderer.render(data, output, maps_for(data))
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

    def test_route_links_cover_all_trips_in_order_with_mobile_waypoint_limit(self):
        data = snapshot()
        data["locations"] = [data["locations"][0]]
        data["deliveries"] = []
        stops = []
        for number in range(1, 7):
            data["locations"].append({"csvRecordNumber": number + 1,
                                      "latitude": 50 + number / 1000, "longitude": 4.0})
            data["deliveries"].append({"csvRecordNumber": number + 1, "name": f"Test {number}",
                                       "street": "Teststraat", "houseNumber": "1", "postcode": "1000",
                                       "municipality": "Test", "packageCount": 1, "bellen": "",
                                       "remarkUpper": ""})
            stops.append({"csvRecordNumber": number + 1, "matrixIndex": number, "packageCount": 1})
        data["routes"][0]["trips"] = [{"stops": stops[:4]}, {"stops": stops[4:]}]
        _, points = renderer.validate(data)
        links = renderer._route_navigation_links(data["routes"][0], points)
        self.assertEqual(len(links), 2)
        segments = []
        for _, url in links:
            params = parse_qs(urlsplit(url).query)
            self.assertEqual(params["api"], ["1"])
            self.assertEqual(params["travelmode"], ["driving"])
            self.assertEqual(params["dir_action"], ["navigate"])
            waypoints = params.get("waypoints", [""])[0].split("|") if "waypoints" in params else []
            self.assertLessEqual(len(waypoints), 3)
            segments.append([params["origin"][0], *waypoints, params["destination"][0]])
        self.assertEqual(segments, [
            ["50.0,4.0", "50.001,4.0", "50.002,4.0", "50.003,4.0", "50.004,4.0"],
            ["50.004,4.0", "50.0,4.0", "50.005,4.0", "50.006,4.0", "50.0,4.0"],
        ])
        self.assertIn("Depot na rit 1", links[1][0])
        output = self.root / "output"
        output.mkdir()
        annotations = []
        original_link = Canvas.linkURL

        def record_link(canvas, url, rect, *args, **kwargs):
            annotations.append((url, rect, kwargs.get("relative", 0)))
            return original_link(canvas, url, rect, *args, **kwargs)

        with mock.patch.object(Canvas, "linkURL", autospec=True, side_effect=record_link):
            renderer.render(data, output, maps_for(data))
        pdf = (output / "chauffeur-1.pdf").read_bytes()
        for _, url in links:
            self.assertIn(url.encode(), pdf)
        full_url = renderer._google_maps_url(renderer._route_itinerary(data["routes"][0], points))
        self.assertNotIn(full_url.encode(), pdf)
        for _, url in links:
            matches = [(rect, relative) for target, rect, relative in annotations if target == url]
            self.assertEqual(len(matches), 1)
            rect, relative = matches[0]
            self.assertEqual(relative, 1)
            self.assertEqual(rect[:2], (0, 0))
            self.assertGreater(rect[2], 400)
            self.assertGreater(rect[3], 28)
        streams = re.findall(rb"/ASCII85Decode\s*/FlateDecode.*?stream\r?\n(.*?)endstream", pdf, re.S)
        content = b"\n".join(zlib.decompress(base64.a85decode(stream.strip(), adobe=True))
                             for stream in streams)
        self.assertNotIn(b"Google Maps volledige route", content)
        self.assertNotIn(b"Google Maps kan bij veel stops of een lange link", content)
        self.assertLess(content.index(b"Google Maps route deel 1/2"), content.index(b"Rit 1"))
        self.assertLess(content.index(b"Google Maps route deel 2/2"), content.index(b"Rit 1"))

    def test_long_route_uses_sequential_links_without_full_route_link(self):
        data = snapshot()
        data["locations"] = [data["locations"][0]]
        delivery = data["deliveries"][0]
        data["deliveries"] = []
        stops = []
        for number in range(1, 121):
            data["locations"].append({"csvRecordNumber": number + 1,
                                      "latitude": 50 + number / 100000, "longitude": 4.123456})
            data["deliveries"].append(dict(delivery, csvRecordNumber=number + 1, remarkUpper=""))
            stops.append({"csvRecordNumber": number + 1, "matrixIndex": number,
                          "packageCount": delivery["packageCount"]})
        data["routes"][0]["trips"] = [{"stops": stops}]
        _, points = renderer.validate(data)
        full_url = renderer._google_maps_url(renderer._route_itinerary(data["routes"][0], points))
        self.assertGreater(len(full_url), 2048)
        links = renderer._route_navigation_links(data["routes"][0], points)
        self.assertTrue(all(len(url) <= 2048 for _, url in links))
        self.assertTrue(all(len(parse_qs(urlsplit(url).query).get("waypoints", [""])[0].split("|")) <= 3
                            for _, url in links))
        for number in range(1, 121):
            self.assertTrue(any(f"Stop {number}" in labels for labels, _ in links))
        output = self.root / "output"
        output.mkdir()
        renderer.render(data, output, maps_for(data))
        pdf = (output / "chauffeur-1.pdf").read_bytes()
        self.assertNotIn(full_url.encode(), pdf)
        for _, url in links:
            self.assertIn(url.encode(), pdf)

    def test_single_stop_route_link_returns_to_depot(self):
        data = snapshot()
        data["locations"].pop()
        data["deliveries"].pop()
        data["routes"][0]["trips"][0]["stops"].pop()
        _, points = renderer.validate(data)
        links = renderer._route_navigation_links(data["routes"][0], points)
        self.assertEqual(len(links), 1)
        params = parse_qs(urlsplit(links[0][1]).query)
        self.assertEqual(params["origin"], ["50.0,4.0"])
        self.assertEqual(params["destination"], ["50.0,4.0"])
        self.assertEqual(params["waypoints"], ["50.001,4.001"])

    def test_last_segment_can_be_direct_return_to_depot(self):
        data = snapshot()
        for number in (4, 5):
            data["locations"].append({"csvRecordNumber": number, "latitude": 50 + number / 1000, "longitude": 4.0})
            delivery = dict(data["deliveries"][0], csvRecordNumber=number)
            data["deliveries"].append(delivery)
            data["routes"][0]["trips"][0]["stops"].append(
                {"csvRecordNumber": number, "matrixIndex": number - 1, "packageCount": delivery["packageCount"]})
        _, points = renderer.validate(data)
        links = renderer._route_navigation_links(data["routes"][0], points)
        self.assertEqual(len(links), 2)
        last = parse_qs(urlsplit(links[-1][1]).query)
        self.assertEqual(last["origin"], ["50.005,4.0"])
        self.assertEqual(last["destination"], ["50.0,4.0"])
        self.assertNotIn("waypoints", last)

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
            renderer.render(data, output, maps_for(data))
        separators = [line for line in lines if line[2] - line[0] > 400]
        self.assertEqual(len(separators), 1)
        self.assertEqual(separators[0][1], separators[0][3])
        self.assertGreater(separators[0][2], separators[0][0])

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
                renderer.render(bad, output, maps_for(bad))
        self.assertEqual(list(output.iterdir()), [])

    def test_driver_files_keep_their_own_stops_and_navigation_links(self):
        data = snapshot()
        data["locations"][2]["latitude"] = 50.002
        data["locations"][2]["longitude"] = 4.002
        second_stop = data["routes"][0]["trips"][0]["stops"].pop()
        data["routes"][0]["distanceMeters"] = 1000
        data["routes"][0]["totalDurationSeconds"] = 600
        data["routes"].append({"driver": 2, "distanceMeters": 2000, "totalDurationSeconds": 1200,
                               "trips": [{"stops": [second_stop]}]})
        output = self.root / "output"
        output.mkdir()
        renderer.render(data, output, maps_for(data))
        first = (output / "chauffeur-1.pdf").read_bytes()
        second = (output / "chauffeur-2.pdf").read_bytes()
        self.assertIn(b"destination=50.001%2C4.001", first)
        self.assertNotIn(b"destination=50.002%2C4.002", first)
        self.assertIn(b"daddr=50.001%2C4.001", first)
        self.assertNotIn(b"daddr=50.002%2C4.002", first)
        self.assertIn(b"destination=50.002%2C4.002", second)
        self.assertNotIn(b"destination=50.001%2C4.001", second)
        self.assertIn(b"daddr=50.002%2C4.002", second)
        self.assertNotIn(b"daddr=50.001%2C4.001", second)
        for pdf, driver in ((first, 1), (second, 2)):
            streams = re.findall(rb"/ASCII85Decode\s*/FlateDecode.*?stream\r?\n(.*?)endstream", pdf, re.S)
            decoded = [zlib.decompress(base64.a85decode(stream.strip(), adobe=True)) for stream in streams]
            self.assertIn(bytes((driver, 50, 100)) * 200, decoded)
            self.assertNotIn(bytes((3 - driver, 50, 100)) * 200, decoded)

    def test_map_manifest_rejects_missing_stale_or_corrupt_maps(self):
        data = snapshot()
        raw = json.dumps(data).encode()
        directory = self.root / "route-maps"
        maps = write_maps(directory, data, raw)
        self.assertEqual(server.load_route_maps(data, raw, directory), maps)
        with self.assertRaises(server.InvalidRouteMaps):
            server.load_route_maps(data, raw + b" ", directory)
        (directory / "chauffeur-1.png").write_bytes(b"not a PNG")
        with self.assertRaises(server.InvalidRouteMaps):
            server.load_route_maps(data, raw, directory)
        manifest_path = directory / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["maps"]["1"] = hashlib.sha256(b"not a PNG").hexdigest()
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaises(server.InvalidRouteMaps):
            server.load_route_maps(data, raw, directory)
        (directory / "chauffeur-1.png").unlink()
        with self.assertRaises(server.InvalidRouteMaps):
            server.load_route_maps(data, raw, directory)
        (directory / "manifest.json").unlink()
        with self.assertRaises(server.InvalidRouteMaps):
            server.load_route_maps(data, raw, directory)

    def test_worker_publishes_pdf_with_current_map(self):
        data = snapshot()
        raw = json.dumps(data).encode()
        directory = self.root / "legacy"
        directory.mkdir()
        write_maps(directory / "route-maps", data, raw)

        def fake_api(version, endpoint):
            return b'{"state":"completed"}' if endpoint == "route-calculation" else raw

        with mock.patch.object(server, "ROOT", self.root), mock.patch.object(server, "api_get", fake_api):
            server.generate("legacy")
            self.assertEqual(server.read_status("legacy")["state"], "completed")
        pdf = (directory / "driver-pdf" / "chauffeur-1.pdf").read_bytes()
        self.assertIn(b"/Subtype /Image", pdf)

    def test_missing_maps_fail_without_replacing_previous_pdfs(self):
        directory = self.root / "legacy"
        output = directory / "driver-pdf"
        output.mkdir(parents=True)
        (output / "chauffeur-1.pdf").write_bytes(b"previous")
        raw = json.dumps(snapshot()).encode()

        def fake_api(version, endpoint):
            return b'{"state":"completed"}' if endpoint == "route-calculation" else raw

        with mock.patch.object(server, "ROOT", self.root), mock.patch.object(server, "api_get", fake_api):
            server.generate("legacy")
            status = server.read_status("legacy")
        self.assertEqual(status["state"], "failed")
        self.assertIn("Render de routekaarten opnieuw", status["message"])
        self.assertEqual((output / "chauffeur-1.pdf").read_bytes(), b"previous")
        self.assertFalse(any(path.name.startswith(".driver-pdf-staging-") for path in directory.iterdir()))

    def test_server_lifecycle_and_freshness(self):
        root = self.root
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

        def fake_render(data, directory, maps):
            started.set()
            self.assertTrue(proceed.wait(5))
            (directory / "driver.pdf").write_bytes(b"synthetic")

        with mock.patch.object(server, "ROOT", root), mock.patch.object(server, "api_get", fake_api), \
             mock.patch.object(server, "load_route_maps", return_value=maps_for(snapshot())), \
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
                self.assertEqual(result["outputDirectory"], "legacy/driver-pdf")
                started.clear()
                changed[0] = False
                proceed.clear()
                self.assertEqual(request("POST", "/start", '{"version":"legacy"}')[0], 202)
                self.assertTrue(started.wait(5))
                changed[0] = True
                proceed.set()
                self.wait_for_state(request, "failed")
                self.assertTrue(completed.exists())
                self.assertFalse(any(p.name.startswith(".driver-pdf-staging-") for p in (root / "legacy").iterdir()))
                server.write_status("legacy", {"state": "running"})
                self.assertEqual(request("GET", "/status/legacy")[1]["state"], "failed")
            finally:
                proceed.set()
                httpd.shutdown()
                httpd.server_close()
                thread.join()
                server.ACTIVE = None

    def test_failure_logs_phase_and_type_without_exception_details(self):
        root = self.root
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

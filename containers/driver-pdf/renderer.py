"""Generate driver delivery lists without contacting external services."""

import logging
import math
import os
from io import BytesIO
from pathlib import Path
import time
from urllib.parse import urlencode
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from PIL import Image as PillowImage
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Flowable, HRFlowable, Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

logger = logging.getLogger("driver_pdf")


class InvalidSnapshot(ValueError):
    pass


def _require(condition, message):
    if not condition:
        raise InvalidSnapshot(message)


def _integer(value, minimum=1):
    return type(value) is int and value >= minimum


def _point(location):
    lon, lat = location.get("longitude"), location.get("latitude")
    _require(all(type(value) in (int, float) and math.isfinite(value) for value in (lon, lat))
             and -180 <= lon <= 180 and -90 <= lat <= 90, "Invalid coordinate.")
    return float(lon), float(lat)


def validate(snapshot):
    _require(isinstance(snapshot, dict) and isinstance(snapshot.get("version"), str), "Invalid snapshot.")
    locations, deliveries, routes = (snapshot.get(key) for key in ("locations", "deliveries", "routes"))
    _require(all(isinstance(value, list) and value for value in (locations, deliveries, routes)), "Missing records or routes.")
    by_record, location_records = {}, set()
    for delivery in deliveries:
        _require(isinstance(delivery, dict), "Invalid delivery.")
        record = delivery.get("csvRecordNumber")
        _require(_integer(record) and record not in by_record and _integer(delivery.get("packageCount")), "Invalid delivery.")
        for field in ("name", "street", "houseNumber", "postcode", "municipality", "bellen", "remarkUpper"):
            _require(isinstance(delivery.get(field), str), "Invalid delivery text.")
        by_record[record] = delivery
    points = []
    for index, location in enumerate(locations):
        _require(isinstance(location, dict), "Invalid location.")
        points.append(_point(location))
        record = location.get("csvRecordNumber")
        if index == 0:
            _require("csvRecordNumber" in location and record is None, "Missing depot.")
        else:
            _require(_integer(record) and record in by_record and record not in location_records, "Invalid location record.")
            location_records.add(record)
    _require(location_records == set(by_record), "Incomplete locations.")
    seen, drivers = set(), set()
    for route in routes:
        _require(isinstance(route, dict) and _integer(route.get("driver")) and route["driver"] not in drivers,
                 "Invalid driver.")
        _require(_integer(route.get("distanceMeters"), 0) and _integer(route.get("totalDurationSeconds"), 0),
                 "Invalid route summary.")
        drivers.add(route["driver"])
        trips = route.get("trips")
        _require(isinstance(trips, list) and trips, "Missing trips.")
        for trip in trips:
            _require(isinstance(trip, dict) and isinstance(trip.get("stops"), list) and trip["stops"], "Missing stops.")
            for stop in trip["stops"]:
                _require(isinstance(stop, dict), "Invalid stop.")
                index, record = stop.get("matrixIndex"), stop.get("csvRecordNumber")
                _require(_integer(index) and index < len(locations) and _integer(record)
                         and record not in seen and locations[index]["csvRecordNumber"] == record
                         and _integer(stop.get("packageCount"))
                         and stop["packageCount"] == by_record[record]["packageCount"], "Invalid stop assignment.")
                seen.add(record)
    _require(seen == set(by_record), "Incomplete delivery coverage.")
    return by_record, points


def _register_fonts():
    font_dir = Path("/usr/share/fonts/truetype/dejavu")
    pdfmetrics.registerFont(TTFont("DejaVu", str(font_dir / "DejaVuSans.ttf")))
    pdfmetrics.registerFont(TTFont("DejaVuBold", str(font_dir / "DejaVuSans-Bold.ttf")))
    pdfmetrics.registerFontFamily("DejaVu", normal="DejaVu", bold="DejaVuBold")


def _text(value):
    return escape(value).replace("\n", "<br/>").replace("\r", "")


def _route_itinerary(route, points):
    depot = points[0]
    itinerary = [("Start", depot)]
    number = 0
    for trip_number, trip in enumerate(route["trips"], 1):
        for stop in trip["stops"]:
            number += 1
            itinerary.append((f"Stop {number}", points[stop["matrixIndex"]]))
        itinerary.append((f"Depot na rit {trip_number}", depot))
    return itinerary


def _google_maps_url(itinerary):
    def coordinates(point):
        lon, lat = point
        return f"{lat},{lon}"

    parameters = {
        "api": "1",
        "origin": coordinates(itinerary[0][1]),
        "destination": coordinates(itinerary[-1][1]),
        "travelmode": "driving",
        "dir_action": "navigate",
    }
    if len(itinerary) > 2:
        parameters["waypoints"] = "|".join(coordinates(point) for _, point in itinerary[1:-1])
    return "https://www.google.com/maps/dir/?" + urlencode(parameters)


def _route_navigation_links(route, points):
    itinerary = _route_itinerary(route, points)
    links = []
    for start in range(0, len(itinerary) - 1, 4):
        segment = itinerary[start:start + 5]
        labels = " - ".join(label for label, _ in segment)
        links.append((labels, _google_maps_url(segment)))
    return links


class RouteButton(Flowable):
    def __init__(self, label, url, style):
        super().__init__()
        self.paragraph = Paragraph(_text(label), style)
        self.url = url
        self.spaceAfter = 2 * mm

    def wrap(self, available_width, available_height):
        self.width = min(165 * mm, available_width)
        _, self.text_height = self.paragraph.wrap(self.width - 8 * mm, available_height)
        self.height = max(10 * mm, self.text_height + 4 * mm)
        return self.width, self.height

    def draw(self):
        self.canv.setFillColor(colors.HexColor("#2867B2"))
        self.canv.roundRect(0, 0, self.width, self.height, 2 * mm, fill=1, stroke=0)
        self.paragraph.drawOn(self.canv, 4 * mm, (self.height - self.text_height) / 2)
        self.canv.linkURL(self.url, (0, 0, self.width, self.height), relative=1)


def render(snapshot, output_dir, maps):
    """Write one PDF per driver to an existing, empty staging directory."""
    logger.info("PDF-invoer valideren.")
    deliveries, points = validate(snapshot)
    _require(set(maps) == {route["driver"] for route in snapshot["routes"]}, "Missing driver maps.")
    logger.info("PDF-invoer geldig: %d chauffeurs, %d leveringen.", len(snapshot["routes"]), len(deliveries))
    output = Path(output_dir)
    _require(output.is_dir() and not any(output.iterdir()), "Output must be an empty staging directory.")
    _register_fonts()
    regular = ParagraphStyle("regular", fontName="DejaVu", fontSize=10, leading=14, splitLongWords=True)
    attribution = ParagraphStyle("attribution", parent=regular, fontSize=8, leading=10)
    heading = ParagraphStyle("heading", parent=regular, fontName="DejaVuBold", fontSize=17, leading=22)
    summary_count = ParagraphStyle("summary_count", parent=regular, fontName="DejaVuBold", fontSize=20, leading=25)
    stop_heading = ParagraphStyle("stop", parent=regular, fontName="DejaVuBold", fontSize=12, leading=16)
    count = ParagraphStyle("count", parent=regular, fontName="DejaVuBold", fontSize=20, leading=25)
    navigation_button = ParagraphStyle("navigation_button", parent=regular, alignment=1)
    route_button = ParagraphStyle("route_button", parent=regular, fontName="DejaVuBold", textColor=colors.white)
    for route in snapshot["routes"]:
        driver = route["driver"]
        stops = [stop for trip in route["trips"] for stop in trip["stops"]]
        logger.info("Chauffeur %d: PDF voorbereiden voor %d leveringen.", driver, len(stops))
        package_count = sum(stop["packageCount"] for stop in stops)
        distance_kilometers = f"{route['distanceMeters'] / 1000:.1f}".replace(".", ",")
        estimated_minutes = math.ceil(route["totalDurationSeconds"] / 60)
        story = [
            Paragraph(f"Chauffeur {driver}", heading),
            Spacer(1, 4 * mm),
            Paragraph(f"Totaal aantal pakketten: {package_count}", summary_count),
            Spacer(1, 1 * mm),
            Paragraph(f"Aantal adressen: {len(stops)}<br/>"
                      f"Geschatte afstand: {distance_kilometers} km<br/>"
                      f"Geschatte tijd: {estimated_minutes} minuten", regular),
            Spacer(1, 4 * mm),
        ]
        image_data = BytesIO(maps[driver])
        with PillowImage.open(image_data) as image:
            width, height = image.size
        scale = min(165 * mm / width, 100 * mm / height)
        story.append(Image(image_data, width=width * scale, height=height * scale, hAlign="LEFT"))
        story.append(Paragraph('Kaartgegevens &copy; <link href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</link>', attribution))
        story.append(Spacer(1, 4 * mm))
        links = _route_navigation_links(route, points)
        for index, (labels, url) in enumerate(links, 1):
            story.append(RouteButton(f"Google Maps route deel {index}/{len(links)}: {labels}", url, route_button))
        story.append(Spacer(1, 4 * mm))
        number = 0
        for trip_number, trip in enumerate(route["trips"], 1):
            story.append(Paragraph(f"Rit {trip_number}", stop_heading))
            story.append(Spacer(1, 2 * mm))
            for stop in trip["stops"]:
                number += 1
                delivery = deliveries[stop["csvRecordNumber"]]
                lon, lat = points[stop["matrixIndex"]]
                coordinates = f"{lat}%2C{lon}"
                left = [
                    Paragraph(f"Stop {number}", stop_heading),
                    Paragraph(_text(delivery["name"]), regular),
                    Paragraph("<b>" + _text(delivery["street"] + " " + delivery["houseNumber"]) + "</b>", regular),
                    Paragraph(_text(delivery["postcode"] + " " + delivery["municipality"]), regular),
                ]
                navigation_buttons = Table([[
                    Paragraph(f'<link href="https://www.google.com/maps/dir/?api=1&amp;destination={coordinates}&amp;travelmode=driving"><font color="#FFFFFF">Google maps</font></link>', navigation_button),
                    Paragraph(f'<link href="https://maps.apple.com/?daddr={coordinates}"><font color="#FFFFFF">Apple maps</font></link>', navigation_button),
                ]], colWidths=[42 * mm, 42 * mm], hAlign="LEFT",
                    style=TableStyle([
                        ("BACKGROUND", (0, 0), (0, 0), "#4285F4"),
                        ("BACKGROUND", (1, 0), (1, 0), "#555555"),
                        ("BOX", (0, 0), (-1, -1), 0, "#FFFFFF"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 3),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                        ("TOPPADDING", (0, 0), (-1, -1), 4),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                    ]))
                right = [Paragraph(f"{delivery['packageCount']} Pakketten", count)]
                for label, key in (("Bellen", "bellen"), ("Opmerking", "remarkUpper")):
                    right.append(Paragraph(f"<b>{label}:</b> {_text(delivery[key])}", regular))
                story.append(Table([[left, right]], colWidths=[90 * mm, 75 * mm],
                                   hAlign="LEFT", splitByRow=1, splitInRow=1,
                                   style=TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"),
                                                     ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                                     ("RIGHTPADDING", (0, 0), (-1, -1), 6)])))
                story.append(navigation_buttons)
                if number < len(stops):
                    story.append(HRFlowable(width=165 * mm, thickness=0.5, hAlign="LEFT",
                                            spaceBefore=2 * mm, spaceAfter=3 * mm))
        path = output / f"chauffeur-{driver}.pdf"
        temporary = output / f".chauffeur-{driver}.pdf.part"
        try:
            logger.info("Chauffeur %d: PDF opbouwen.", driver)
            started = time.monotonic()
            descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, "wb") as file:
                SimpleDocTemplate(file, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm,
                                  topMargin=15 * mm, bottomMargin=15 * mm).build(story)
            os.replace(temporary, path)
            logger.info("Chauffeur %d: PDF voltooid in %.1f seconden.", driver, time.monotonic() - started)
        finally:
            if temporary.exists():
                temporary.unlink()

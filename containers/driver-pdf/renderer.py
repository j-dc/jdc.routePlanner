"""Generate driver delivery lists without contacting external services."""

import logging
import math
import os
from pathlib import Path
import time
from xml.sax.saxutils import escape

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import HRFlowable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

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


def render(snapshot, output_dir):
    """Write one PDF per driver to an existing, empty staging directory."""
    logger.info("PDF-invoer valideren.")
    deliveries, points = validate(snapshot)
    logger.info("PDF-invoer geldig: %d chauffeurs, %d leveringen.", len(snapshot["routes"]), len(deliveries))
    output = Path(output_dir)
    _require(output.is_dir() and not any(output.iterdir()), "Output must be an empty staging directory.")
    _register_fonts()
    regular = ParagraphStyle("regular", fontName="DejaVu", fontSize=10, leading=14, splitLongWords=True)
    heading = ParagraphStyle("heading", parent=regular, fontName="DejaVuBold", fontSize=17, leading=22)
    stop_heading = ParagraphStyle("stop", parent=regular, fontName="DejaVuBold", fontSize=12, leading=16)
    count = ParagraphStyle("count", parent=regular, fontName="DejaVuBold", fontSize=20, leading=25)
    for route in snapshot["routes"]:
        driver = route["driver"]
        stops = [stop for trip in route["trips"] for stop in trip["stops"]]
        logger.info("Chauffeur %d: PDF voorbereiden voor %d leveringen.", driver, len(stops))
        story = [Paragraph(f"Chauffeur {driver}", heading), Spacer(1, 4 * mm)]
        number = 0
        for trip_number, trip in enumerate(route["trips"], 1):
            story.append(Paragraph(f"Rit {trip_number}", stop_heading))
            story.append(Spacer(1, 2 * mm))
            for stop in trip["stops"]:
                number += 1
                delivery = deliveries[stop["csvRecordNumber"]]
                lon, lat = points[stop["matrixIndex"]]
                left = [
                    Paragraph(f"Stop {number}", stop_heading),
                    Paragraph(_text(delivery["name"]), regular),
                    Paragraph("<b>" + _text(delivery["street"] + " " + delivery["houseNumber"]) + "</b>", regular),
                    Paragraph(_text(delivery["postcode"] + " " + delivery["municipality"]), regular),
                    Paragraph(f'<link href="geo:{lat},{lon}">Open navigatie (geo:, geschikte app vereist)</link>', regular),
                ]
                right = [Paragraph(f"{delivery['packageCount']} Pakketten", count)]
                for label, key in (("Bellen", "bellen"), ("Opmerking", "remarkUpper")):
                    right.append(Paragraph(f"<b>{label}:</b> {_text(delivery[key])}", regular))
                story.append(Table([[left, right]], colWidths=[90 * mm, 75 * mm],
                                   hAlign="LEFT", splitByRow=1, splitInRow=1,
                                   style=TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"),
                                                     ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                                     ("RIGHTPADDING", (0, 0), (-1, -1), 6)])))
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

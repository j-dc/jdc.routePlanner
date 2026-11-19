"""Internal HTTP worker. Only the API is contacted; rendering itself is offline."""
import datetime
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shutil
import threading
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from renderer import render

API_URL = os.environ.get("DRIVER_PDF_API_URL", "http://routeplanner-api:8080").rstrip("/")
OUTPUT_ROOT = Path(os.environ.get("DRIVER_PDF_OUTPUT_DIR", "/output"))
ROOT = OUTPUT_ROOT / "driver-pdfs"
logger = logging.getLogger("driver_pdf")
LOCK = threading.Lock()
ACTIVE = None


def valid_version(value):
    if value == "legacy":
        return True
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{8}T[0-9]{13}Z", value):
        return False
    try:
        datetime.datetime.strptime(value[:21], "%Y%m%dT%H%M%S%f")
        return True
    except ValueError:
        return False


def write_status(version, status):
    directory = ROOT / version
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / (".status-" + uuid.uuid4().hex)
    try:
        with temporary.open("x", encoding="utf-8") as file:
            json.dump(status, file)
        os.replace(temporary, directory / "status.json")
    finally:
        temporary.unlink(missing_ok=True)


def read_status(version):
    try:
        with (ROOT / version / "status.json").open(encoding="utf-8") as file:
            status = json.load(file)
        if status.get("state") == "running" and ACTIVE != version:
            status = {"state": "failed", "message": "De PDF-generatie is onderbroken."}
            write_status(version, status)
        return status
    except FileNotFoundError:
        return {"state": "idle"}


def api_get(version, endpoint):
    request = urllib.request.Request(f"{API_URL}/api/versions/{version}/{endpoint}",
                                     headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=600) as response:
        return response.read()


def route_current(version):
    status = json.loads(api_get(version, "route-calculation"))
    if status.get("state") != "completed":
        raise RuntimeError("Route calculation is not current.")


def generate(version):
    global ACTIVE
    staging = ROOT / version / (".staging-" + uuid.uuid4().hex)
    phase = "voorbereiding"
    try:
        logger.info("PDF-generatie gestart voor versie %s.", version)
        staging.mkdir()
        phase = "routestatus controleren"
        logger.info("Actuele routestatus controleren.")
        route_current(version)
        phase = "PDF-invoer ophalen"
        logger.info("PDF-invoer ophalen.")
        initial = api_get(version, "driver-pdf-data")
        snapshot = json.loads(initial)
        if snapshot.get("version") != version:
            raise ValueError("Version mismatch.")
        phase = "PDF's maken"
        logger.info("PDF-invoer opgehaald; PDF's maken.")
        render(snapshot, staging)
        phase = "actualiteit controleren"
        logger.info("Controleren of route en invoer nog actueel zijn.")
        if hashlib.sha256(initial).digest() != hashlib.sha256(api_get(version, "driver-pdf-data")).digest():
            raise RuntimeError("Snapshot changed.")
        route_current(version)
        phase = "PDF's publiceren"
        generation = "generation-" + uuid.uuid4().hex
        os.rename(staging, ROOT / version / generation)
        write_status(version, {"state": "completed", "outputDirectory": f"driver-pdfs/{version}/{generation}"})
        logger.info("PDF-generatie voltooid voor versie %s.", version)
    except Exception as error:
        logger.error("PDF-generatie mislukt tijdens %s (%s).", phase, type(error).__name__)
        try:
            if staging.exists():
                shutil.rmtree(staging)
        except OSError as cleanup_error:
            logger.error("Tijdelijke PDF-bestanden konden niet worden verwijderd (%s).", type(cleanup_error).__name__)
        try:
            write_status(version, {"state": "failed", "message": "PDF-generatie mislukt of gegevens zijn gewijzigd."})
        except OSError as status_error:
            logger.error("PDF-foutstatus kon niet worden opgeslagen (%s).", type(status_error).__name__)
    finally:
        with LOCK:
            ACTIVE = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"state": "ok"})
        if self.path.startswith("/status/"):
            version = self.path[len("/status/"):]
            if not valid_version(version):
                return self.reply(400, {"state": "failed", "message": "Ongeldige versie."})
            try:
                with LOCK:
                    if ACTIVE is not None and ACTIVE != version:
                        return self.reply(200, {"state": "busy"})
                    status = read_status(version)
                return self.reply(200, status)
            except (OSError, ValueError) as error:
                logger.error("PDF-status kon niet worden gelezen (%s).", type(error).__name__)
                return self.reply(500, {"state": "failed", "message": "Status niet beschikbaar."})
        self.reply(404, {"state": "failed"})

    def do_POST(self):
        global ACTIVE
        if self.path != "/start":
            return self.reply(404, {"state": "failed"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096 or self.headers.get_content_type() != "application/json":
                raise ValueError()
            payload = json.loads(self.rfile.read(length))
            version = payload["version"]
            if not valid_version(version):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            return self.reply(400, {"state": "failed", "message": "Ongeldig verzoek."})
        try:
            with LOCK:
                if ACTIVE is not None:
                    return self.reply(409, {"state": "busy"})
                write_status(version, {"state": "running"})
                ACTIVE = version
                try:
                    threading.Thread(target=generate, args=(version,), daemon=True).start()
                except Exception:
                    ACTIVE = None
                    write_status(version, {"state": "failed", "message": "PDF-generatie kon niet starten."})
                    raise
        except OSError as error:
            logger.error("PDF-generatie kon niet worden gestart (%s).", type(error).__name__)
            return self.reply(500, {"state": "failed", "message": "PDF-generatie kon niet starten."})
        self.reply(202, {"state": "running"})


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    os.umask(0o077)
    logger.info("PDF-worker gestart en gereed.")
    ThreadingHTTPServer(("0.0.0.0", 8084), Handler).serve_forever()

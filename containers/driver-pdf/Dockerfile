# ReportLab's native dependencies on the shared Alpine PowerShell image are not verified.
FROM ubuntu:24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-reportlab fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 driverpdf \
    && useradd --system --uid 10001 --gid driverpdf --no-create-home driverpdf

WORKDIR /app
COPY containers/driver-pdf/renderer.py containers/driver-pdf/server.py /app/
ENV DRIVER_PDF_API_URL=http://routeplanner-api:8080 \
    DRIVER_PDF_OUTPUT_DIR=/output \
    PYTHONDONTWRITEBYTECODE=1
USER 10001:10001
EXPOSE 8084
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8084/health', timeout=3).close()"]
CMD ["python3", "/app/server.py"]

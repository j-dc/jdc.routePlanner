# Driver PDF worker

This isolated component uses Ubuntu 24.04, Python 3, ReportLab and DejaVu Sans.
Build from the repository root:

```powershell
docker build -f containers\driver-pdf\Dockerfile -t driver-pdf:local .
```

Run the image on an isolated application network with a private writable output
mount at `/output`, writable by UID/GID 10001. No OSM, input or review
mount is needed. The service runs as UID/GID 10001, listens on port 8084 and
should not be exposed publicly. Restrict its network access to the trusted
routeplanner API. Configure `DRIVER_PDF_API_URL` (default
`http://routeplanner-api:8080`) and `DRIVER_PDF_OUTPUT_DIR` (default `/output`).

`GET /health`, `GET /status/{version}` and `POST /start` with JSON
`{"version":"legacy"}` are the service interface. Only `legacy` or a valid
`yyyyMMddTHHmmssfffffffZ` version is accepted. A start returns 202 or 409 if
another job is active. Status `state` is `idle`, `running`, `busy`,
`completed` or `failed`, with an optional `message` and, on completion,
`outputDirectory` relative to the output root. A restart reports interrupted
running jobs as failed when their status is requested. Completed generations
are immutable and retained; deletion and retention are an operator's
responsibility. A failed job removes only its own staging directory.

The API must provide `driver-pdf-data` and
`route-calculation` under `/api/versions/{version}/`. The first is a stable,
byte-identical JSON snapshot while all relevant inputs and route calculation
remain unchanged.
Route calculation must report `{"state":"completed"}` only when current.
The worker checks both again before publishing; the snapshot must change when
any relevant data changes, including route recalculation.

The service logs its progress and failure phase to the container log, including
per-driver PDF completion.
The log contains no delivery names, addresses, or coordinates.

The importable `renderer.render(snapshot, output_dir)` requires an
existing empty private staging directory. Snapshot fields are the camelCase
contract: `version`, `routes`, `locations`, `deliveries`.
The first location is the depot (`csvRecordNumber: null`);
each other location and delivery must occur exactly once in the trips, indexed
by `matrixIndex`. Delivery text fields are strings, missing notes use empty
strings, and package counts are positive integers. PDFs do not contain maps,
and no geocoder, map or route-geometry request is made. PDF files are written
atomically, and failures raise exceptions.
The `geo:latitude,longitude` link requires a mobile app that handles `geo:`
URIs; its behavior depends on that app. The worker does not automatically
contact third-party navigation or map services.

To run focused tests with synthetic data (the working tree must be writable
for short-lived test fixtures), after building the image:

```powershell
docker run --rm --entrypoint python3 -v "${PWD}:/work" -w /work driver-pdf:local tests/DriverPdf.Tests.py
```

The tests use synthetic data to check PDF content, stop order, links, input
validation and worker lifecycle.

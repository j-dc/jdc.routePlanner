FROM jdc-route-planner/powershell-base:7.6.6-alpine-3.24.3 AS certificates
FROM ubuntu:24.04

COPY --from=certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 osmium-tool \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 geometry \
    && useradd --system --uid 10001 --gid geometry --no-create-home geometry

WORKDIR /app
COPY containers/extract-osm-geometry/entrypoint.py /app/entrypoint.py
USER 10001:10001
ENTRYPOINT ["python3", "/app/entrypoint.py"]
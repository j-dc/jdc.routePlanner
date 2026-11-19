FROM jdc-route-planner/powershell-base:7.7.0-alpine-3.24.4

USER root
RUN mkdir -p /jobs && chmod 1777 /jobs
USER 10001:10001
WORKDIR /app
COPY containers/check-addresses/entrypoint.ps1 /app/entrypoint.ps1
COPY containers/check-addresses/Geocoding.psm1 /app/Geocoding.psm1

ENTRYPOINT ["pwsh", "-NoLogo", "-NoProfile", "-File", "/app/entrypoint.ps1"]
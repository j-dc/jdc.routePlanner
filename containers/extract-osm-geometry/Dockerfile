FROM jdc-route-planner/powershell-base:7.7.0-alpine-3.24.4 AS certificates
FROM ubuntu:24.04

ARG POWERSHELL_VERSION=7.7.0
ARG POWERSHELL_SHA256=c89d9c682d2c403dfe726f3df948e359675235a5bd6fab535776de69729ca0cb

COPY --from=certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends curl osmium-tool \
    && curl --fail --location --silent --show-error \
        "https://github.com/PowerShell/PowerShell/releases/download/v${POWERSHELL_VERSION}/powershell-${POWERSHELL_VERSION}-linux-x64.tar.gz" \
        --output /tmp/powershell.tar.gz \
    && echo "${POWERSHELL_SHA256}  /tmp/powershell.tar.gz" | sha256sum -c --quiet \
    && mkdir -p /opt/microsoft/powershell/7 \
    && tar -xzf /tmp/powershell.tar.gz -C /opt/microsoft/powershell/7 \
    && chmod +x /opt/microsoft/powershell/7/pwsh \
    && ln -s /opt/microsoft/powershell/7/pwsh /usr/bin/pwsh \
    && rm /tmp/powershell.tar.gz \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1654 geometry \
    && useradd --system --uid 1654 --gid geometry --no-create-home geometry

ENV HOME=/tmp \
    POWERSHELL_TELEMETRY_OPTOUT=1 \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1

WORKDIR /app
COPY containers/extract-osm-geometry/entrypoint.ps1 /app/entrypoint.ps1
USER 1654:1654
ENTRYPOINT ["pwsh", "-NoLogo", "-NoProfile", "-File", "/app/entrypoint.ps1"]

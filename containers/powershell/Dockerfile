FROM alpine:3.24.4

ARG POWERSHELL_VERSION=7.7.0
ARG POWERSHELL_SHA256=5a6408b1d196e9d6b6d1af71daa931834c5fea07d14a78cf369292c23944e78d
ARG TARGETARCH

RUN if [ "$TARGETARCH" != "amd64" ]; then \
        echo "PowerShell ${POWERSHELL_VERSION} musl archive is only configured for amd64; got ${TARGETARCH}." >&2; \
        exit 1; \
    fi \
    && apk add --no-cache \
        ca-certificates \
        curl \
        icu-libs \
        krb5-libs \
        less \
        libgcc \
        libintl \
        libssl3 \
        libstdc++ \
        ncurses-terminfo-base \
        openssh-client \
        tar \
        tzdata \
        userspace-rcu \
        zlib \
        lttng-ust \
    && curl --fail --location --silent --show-error \
        "https://github.com/PowerShell/PowerShell/releases/download/v${POWERSHELL_VERSION}/powershell-${POWERSHELL_VERSION}-linux-musl-x64.tar.gz" \
        --output /tmp/powershell.tar.gz \
    && echo "${POWERSHELL_SHA256}  /tmp/powershell.tar.gz" | sha256sum -c -s \
    && mkdir -p /opt/microsoft/powershell/7 \
    && tar -xzf /tmp/powershell.tar.gz -C /opt/microsoft/powershell/7 \
    && chmod +x /opt/microsoft/powershell/7/pwsh \
    && ln -s /opt/microsoft/powershell/7/pwsh /usr/bin/pwsh \
    && rm /tmp/powershell.tar.gz \
    && addgroup -S -g 10001 powershell \
    && adduser -S -D -H -u 10001 -G powershell powershell

ENV HOME=/tmp \
    POWERSHELL_TELEMETRY_OPTOUT=1

USER 10001:10001
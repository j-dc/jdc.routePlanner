FROM alpine:3.24.3

ARG PHOTON_VERSION=1.3.0
ARG PHOTON_SHA256=a89707c0045e4807b2a1180e132e68e108d998709f48b6c94b98a6e281f571a5

RUN apk add --no-cache \
    bash \
    ca-certificates \
    curl \
    openjdk21-jre-headless \
    pv \
    shadow \
    zstd

RUN curl --fail --location --silent --show-error \
        "https://github.com/komoot/photon/releases/download/${PHOTON_VERSION}/photon-${PHOTON_VERSION}.jar" \
        --output /app-photon.jar \
    && echo "${PHOTON_SHA256}  /app-photon.jar" | sha256sum -c -s

RUN addgroup -S -g 10001 photon \
    && adduser -S -D -H -u 10001 -G photon -s /sbin/nologin photon

WORKDIR /app
COPY containers/photon/entrypoint.sh /app/entrypoint.sh
RUN mv /app-photon.jar /app/photon.jar \
    && chmod +x /app/entrypoint.sh \
    && chown -R photon:photon /app

ENV HOME=/tmp \
    PHOTON_JAR=/app/photon.jar

USER 10001:10001
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["serve"]
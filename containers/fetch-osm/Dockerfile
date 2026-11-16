FROM alpine:3.24.3

RUN apk add --no-cache ca-certificates curl

WORKDIR /app
COPY containers/fetch-osm/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
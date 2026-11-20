FROM node:26.13.1-alpine

RUN apk add --no-cache chromium font-noto
RUN addgroup -S -g 1654 routemaps \
    && adduser -S -D -H -u 1654 -G routemaps routemaps
WORKDIR /app
COPY containers/render-route-maps/package.json containers/render-route-maps/package-lock.json ./
RUN npm ci --omit=dev
COPY containers/render-route-maps/entrypoint.mjs ./
ENV HOME=/tmp
USER 1654:1654
CMD ["node", "/app/entrypoint.mjs"]

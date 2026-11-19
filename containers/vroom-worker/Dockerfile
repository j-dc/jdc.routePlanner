FROM ghcr.io/vroom-project/vroom-docker:v1.15.0
WORKDIR /app
COPY containers/vroom-worker/*.mjs ./
USER 1654:1654
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:8083/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
ENTRYPOINT ["node", "/app/server.mjs"]

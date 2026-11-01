FROM powershell-base

WORKDIR /app
COPY containers/check-addresses/entrypoint.ps1 /app/entrypoint.ps1

ENTRYPOINT ["pwsh", "-NoLogo", "-NoProfile", "-File", "/app/entrypoint.ps1"]
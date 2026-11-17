FROM mcr.microsoft.com/dotnet/sdk:11.0.100-resolute-amd64 AS build
WORKDIR /src
COPY containers/routeplanner-api/RoutePlanner.Api.csproj ./
RUN dotnet restore RoutePlanner.Api.csproj
COPY containers/routeplanner-api/ ./
RUN dotnet publish RoutePlanner.Api.csproj --configuration Release --output /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:11.0.0-resolute-amd64 AS runtime
WORKDIR /app
COPY --from=build /app/publish ./
USER root
RUN mkdir -p /review /jobs && chown app:app /review && chmod 1777 /jobs
ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_EnableDiagnostics=0
EXPOSE 8080
USER app
ENTRYPOINT ["dotnet", "RoutePlanner.Api.dll"]
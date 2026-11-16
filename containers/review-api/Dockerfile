FROM mcr.microsoft.com/dotnet/sdk:11.0.100-resolute-amd64 AS build
WORKDIR /src
COPY containers/review-api/Review.Api.csproj ./
RUN dotnet restore Review.Api.csproj
COPY containers/review-api/ ./
RUN dotnet publish Review.Api.csproj --configuration Release --output /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:11.0.0-resolute-amd64 AS runtime
WORKDIR /app
COPY --from=build /app/publish ./
USER root
RUN mkdir -p /review && chown app:app /review
ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_EnableDiagnostics=0
EXPOSE 8080
USER app
ENTRYPOINT ["dotnet", "Review.Api.dll"]
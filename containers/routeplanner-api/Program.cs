using System.Text.Json;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Mvc;
using RoutePlanner.Api;

if (args.Length == 1 && args[0] == "--address-check-broker")
{
    await AddressCheckBroker.RunAsync();
    return 0;
}

if (args.Length == 1 && args[0] == "--health-check")
{
    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
    try
    {
        using var response = await client.GetAsync("http://127.0.0.1:8080/api/health");
        return response.IsSuccessStatusCode ? 0 : 1;
    }
    catch (HttpRequestException)
    {
        return 1;
    }
    catch (TaskCanceledException)
    {
        return 1;
    }
}

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://0.0.0.0:8080");
builder.Services.AddCors(options => options.AddPolicy("routeplanner-ui", policy =>
    policy.WithOrigins("http://routing.localtest.me")
        .AllowAnyHeader()
        .AllowAnyMethod()));

var reportPath = builder.Configuration["Review:SourceReportPath"] ?? "/source/address-check.json";
var inputCsvPath = builder.Configuration["Review:InputCsvPath"] ?? "/input/ritten.csv";
var reviewPath = builder.Configuration["Review:ReviewFilePath"] ?? "/review/address-review.json";
var photonApiBaseUrl = builder.Configuration["Review:PhotonApiBaseUrl"] ?? "http://photon:2322/api/";
var brokerUrl = builder.Configuration["AddressCheck:BrokerUrl"] ?? "http://address-check-broker:8081/";
var photonStatusUrl = builder.Configuration["AddressCheck:PhotonStatusUrl"] ?? "http://photon:2322/status";
builder.Services.AddSingleton(new HttpClient { Timeout = TimeSpan.FromSeconds(15) });

var app = builder.Build();
app.UseCors("routeplanner-ui");
var reviewStores = new ConcurrentDictionary<string, ReviewStore>(StringComparer.Ordinal);
ReviewStore? GetReviewStore(string version)
{
    if (!InputCsvStore.IsVersion(version) || !File.Exists(InputCsvStore.InputPath(inputCsvPath, version))) return null;
    return reviewStores.GetOrAdd(version, key => new ReviewStore(
        key == "legacy" ? reportPath : Path.Combine(Path.GetDirectoryName(Path.GetFullPath(reportPath))!, $"address-check-{key}.json"),
        InputCsvStore.InputPath(inputCsvPath, key),
        key == "legacy" ? reviewPath : Path.Combine(Path.GetDirectoryName(Path.GetFullPath(reviewPath))!, $"address-review-{key}.json"),
        app.Services.GetRequiredService<HttpClient>(),
        photonApiBaseUrl));
}

var settingsStores = new ConcurrentDictionary<string, SettingsStore>(StringComparer.Ordinal);
SettingsStore? GetSettingsStore(string version)
{
    if (!InputCsvStore.IsVersion(version) || !File.Exists(InputCsvStore.InputPath(inputCsvPath, version))) return null;
    return settingsStores.GetOrAdd(version, key => new SettingsStore(Path.Combine(
        Path.GetDirectoryName(Path.GetFullPath(reportPath))!,
        key == "legacy" ? "settings.json" : $"settings-{key}.json")));
}

IResult SettingsFailure(Exception exception) => exception switch
{
    ArgumentException => Results.Problem(exception.Message, statusCode: StatusCodes.Status400BadRequest),
    JsonException => Results.Problem("Het instellingenbestand bevat ongeldige JSON.", statusCode: StatusCodes.Status409Conflict),
    _ => Results.Problem("Het instellingenbestand kon niet worden gelezen of opgeslagen.", statusCode: StatusCodes.Status500InternalServerError)
};

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

app.MapGet("/api/versions/{version}/settings", async (string version, CancellationToken cancellationToken) =>
{
    var store = GetSettingsStore(version);
    if (store is null) return Results.NotFound();
    try { return Results.Ok(await store.GetAsync(cancellationToken)); }
    catch (Exception exception) when (exception is JsonException or IOException or UnauthorizedAccessException) { return SettingsFailure(exception); }
});

app.MapPost("/api/versions/{version}/start-location/search", async (string version, PhotonSearchRequest request, HttpClient client, CancellationToken cancellationToken) =>
{
    if (GetSettingsStore(version) is null) return Results.NotFound();
    try { return Results.Ok(await SettingsStore.SearchAsync(client, new Uri(photonApiBaseUrl, UriKind.Absolute), request.Query, cancellationToken)); }
    catch (ArgumentException exception) { return Results.Problem(exception.Message, statusCode: StatusCodes.Status400BadRequest); }
    catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or JsonException)
    {
        return Results.Problem("De lokale Photon-geocoder is niet beschikbaar.", statusCode: StatusCodes.Status502BadGateway);
    }
});

app.MapGet("/api/versions/{version}/start-location", async (string version, CancellationToken cancellationToken) =>
{
    var store = GetSettingsStore(version);
    if (store is null) return Results.NotFound();
    try
    {
        var location = (await store.GetAsync(cancellationToken)).StartLocation;
        return location is null ? Results.NotFound() : Results.Ok(location);
    }
    catch (Exception exception) when (exception is JsonException or IOException or UnauthorizedAccessException) { return SettingsFailure(exception); }
});

app.MapPut("/api/versions/{version}/start-location", async (string version, StartLocation location, CancellationToken cancellationToken) =>
{
    var store = GetSettingsStore(version);
    if (store is null) return Results.NotFound();
    try
    {
        await store.SetStartLocationAsync(location, cancellationToken);
        return Results.Ok(location);
    }
    catch (Exception exception) when (exception is ArgumentException or JsonException or IOException or UnauthorizedAccessException) { return SettingsFailure(exception); }
});

app.MapDelete("/api/versions/{version}/start-location", async (string version, CancellationToken cancellationToken) =>
{
    var store = GetSettingsStore(version);
    if (store is null) return Results.NotFound();
    try { return await store.RemoveStartLocationAsync(cancellationToken) ? Results.NoContent() : Results.NotFound(); }
    catch (Exception exception) when (exception is JsonException or IOException or UnauthorizedAccessException) { return SettingsFailure(exception); }
});

app.MapGet("/api/versions/{version}/settings/{key}", async (string version, string key, CancellationToken cancellationToken) =>
{
    var store = GetSettingsStore(version);
    if (store is null || !SettingsStore.IsKey(key)) return Results.NotFound();
    try
    {
        var settings = (await store.GetAsync(cancellationToken)).Settings;
        return settings.TryGetValue(key, out var value) ? Results.Ok(new { key, value }) : Results.NotFound();
    }
    catch (Exception exception) when (exception is JsonException or IOException or UnauthorizedAccessException) { return SettingsFailure(exception); }
});

app.MapPut("/api/versions/{version}/settings/{key}", async (string version, string key, SettingValueRequest request, CancellationToken cancellationToken) =>
{
    var store = GetSettingsStore(version);
    if (store is null) return Results.NotFound();
    if (request.Value is null) return Results.Problem("De waarde ontbreekt.", statusCode: StatusCodes.Status400BadRequest);
    try
    {
        await store.SetAsync(key, request.Value, cancellationToken);
        return Results.Ok(new { key, value = request.Value });
    }
    catch (Exception exception) when (exception is ArgumentException or JsonException or IOException or UnauthorizedAccessException) { return SettingsFailure(exception); }
});

app.MapDelete("/api/versions/{version}/settings/{key}", async (string version, string key, CancellationToken cancellationToken) =>
{
    var store = GetSettingsStore(version);
    if (store is null || !SettingsStore.IsKey(key)) return Results.NotFound();
    try { return await store.RemoveAsync(key, cancellationToken) ? Results.NoContent() : Results.NotFound(); }
    catch (Exception exception) when (exception is JsonException or IOException or UnauthorizedAccessException) { return SettingsFailure(exception); }
});

app.MapGet("/api/versions", () => Results.Ok(InputCsvStore.ListVersions(inputCsvPath)));
app.MapGet("/api/versions/{version}", (string version) =>
    InputCsvStore.IsVersion(version) && File.Exists(InputCsvStore.InputPath(inputCsvPath, version))
        ? Results.Ok(new { id = version })
        : Results.NotFound());

app.MapPost("/api/versions/{version}/matrix-calculation", (string version) =>
{
    if (!InputCsvStore.IsVersion(version) || !File.Exists(InputCsvStore.InputPath(inputCsvPath, version)))
        return Results.NotFound();
    return Results.Problem("Matrixberekening is nog niet beschikbaar.", statusCode: StatusCodes.Status501NotImplemented);
})
.WithName("CalculateMatrix")
.WithSummary("Start matrixberekening voor een planningsversie")
.WithDescription("Placeholder: matrixberekening is nog niet geïmplementeerd.")
.ProducesProblem(StatusCodes.Status501NotImplemented)
.Produces(StatusCodes.Status404NotFound);

app.MapPost("/api/versions/{version}/route-calculation", (string version) =>
{
    if (!InputCsvStore.IsVersion(version) || !File.Exists(InputCsvStore.InputPath(inputCsvPath, version)))
        return Results.NotFound();
    return Results.Problem("Routeberekening is nog niet beschikbaar.", statusCode: StatusCodes.Status501NotImplemented);
})
.WithName("CalculateRoute")
.WithSummary("Start routeberekening voor een planningsversie")
.WithDescription("Placeholder: routeberekening is nog niet geïmplementeerd.")
.ProducesProblem(StatusCodes.Status501NotImplemented)
.Produces(StatusCodes.Status404NotFound);

app.MapGet("/api/versions/{version}/address-check", async (string version, HttpClient client, CancellationToken cancellationToken) =>
{
    if (GetReviewStore(version) is null) return Results.NotFound();
    try
    {
        using var response = await client.GetAsync(new Uri(new Uri(brokerUrl), $"status/{version}"), cancellationToken);
        if (!response.IsSuccessStatusCode) return Results.Problem("De adrescontrole is momenteel niet beschikbaar.", statusCode: 503);
        var status = await response.Content.ReadFromJsonAsync<AddressCheckStatus>(cancellationToken);
        return status is null ? Results.Problem("De status van de adrescontrole is ongeldig.", statusCode: 502) : Results.Ok(status);
    }
    catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or JsonException)
    {
        return Results.Problem("De status van de adrescontrole is niet beschikbaar.", statusCode: 503);
    }
});

app.MapPost("/api/versions/{version}/address-check", async (string version, HttpRequest request, HttpClient client, CancellationToken cancellationToken) =>
{
    if (GetReviewStore(version) is null) return Results.NotFound();
    if (!request.HasJsonContentType() || (request.Headers.Origin.Count > 0 && request.Headers.Origin.ToString() != "http://routing.localtest.me"))
    {
        return Results.Problem("Invalid request origin or content type.", statusCode: 403);
    }
    try
    {
        using var photonResponse = await client.GetAsync(photonStatusUrl, cancellationToken);
        if (!photonResponse.IsSuccessStatusCode) return Results.Problem("De lokale geocoder is nog niet beschikbaar.", statusCode: 503);
        using var response = await client.PostAsync(new Uri(new Uri(brokerUrl), $"start/{version}"), null, cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.Conflict)
            return Results.Conflict(new { detail = "Er loopt al een adrescontrole." });
        if (!response.IsSuccessStatusCode) return Results.Problem("De adrescontrole kon niet worden gestart.", statusCode: 503);
        return Results.Accepted($"/api/versions/{version}/address-check", new AddressCheckStatus("running"));
    }
    catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
    {
        return Results.Problem("De lokale geocoder of adrescontrole is niet beschikbaar.", statusCode: 503);
    }
});

app.MapPost("/api/versions", async (HttpRequest request, CancellationToken cancellationToken) =>
{
    if (!string.Equals(request.ContentType?.Split(';')[0].Trim(), "text/csv", StringComparison.OrdinalIgnoreCase))
    {
        return Results.Problem("Expected a text/csv request body.", statusCode: StatusCodes.Status415UnsupportedMediaType);
    }

    try
    {
        var version = await InputCsvStore.SaveAsync(request.Body, inputCsvPath, cancellationToken);
        return Results.Created($"/api/versions/{version}", new { id = version });
    }
    catch (InvalidDataException exception)
    {
        return Results.Problem(exception.Message, statusCode: StatusCodes.Status400BadRequest);
    }
    catch (IOException)
    {
        return Results.Problem("The input CSV could not be saved.", statusCode: StatusCodes.Status500InternalServerError);
    }
    catch (UnauthorizedAccessException)
    {
        return Results.Problem("The input directory is not writable by the API.", statusCode: StatusCodes.Status500InternalServerError);
    }
}).WithMetadata(new RequestSizeLimitAttribute(10 * 1024 * 1024));

app.MapGet("/api/versions/{version}/review", async (string version, CancellationToken cancellationToken) =>
{
    var store = GetReviewStore(version);
    if (store is null) return Results.NotFound();
    try
    {
        return Results.Ok(await store.GetAsync(cancellationToken));
    }
    catch (FileNotFoundException exception)
    {
        return Results.Problem(exception.Message, statusCode: StatusCodes.Status404NotFound);
    }
    catch (InvalidDataException exception)
    {
        return Results.Problem(exception.Message, statusCode: StatusCodes.Status409Conflict);
    }
    catch (JsonException)
    {
        return Results.Problem("The geocoding report or review file contains invalid JSON.", statusCode: StatusCodes.Status409Conflict);
    }
});

app.MapGet("/api/versions/{version}/osm-geometry", async (string version, CancellationToken cancellationToken) =>
{
    var store = GetReviewStore(version);
    if (store is null) return Results.NotFound();
    var directory = Path.GetDirectoryName(Path.GetFullPath(reportPath))!;
    var selectedReport = version == "legacy" ? reportPath : Path.Combine(directory, $"address-check-{version}.json");
    var geometryPath = Path.Combine(directory, version == "legacy" ? "osm-geometry.geojson" : $"osm-geometry-{version}.geojson");
    try
    {
        await store.GetAsync(cancellationToken);
        var reportBytes = await File.ReadAllBytesAsync(selectedReport, cancellationToken);
        var geometryBytes = await File.ReadAllBytesAsync(geometryPath, cancellationToken);
        using var geometry = JsonDocument.Parse(geometryBytes);
        var root = geometry.RootElement;
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String || type.GetString() != "FeatureCollection" ||
            !root.TryGetProperty("features", out var features) || features.ValueKind != JsonValueKind.Array ||
            !root.TryGetProperty("metadata", out var metadata) || metadata.ValueKind != JsonValueKind.Object ||
            !metadata.TryGetProperty("sourceReportSha256", out var sourceHash) || sourceHash.ValueKind != JsonValueKind.String ||
            !string.Equals(sourceHash.GetString(), Convert.ToHexString(SHA256.HashData(reportBytes)), StringComparison.OrdinalIgnoreCase))
        {
            return Results.Problem("De OSM-geometrie past niet bij het huidige geocodingrapport.", statusCode: 409);
        }
        return Results.File(geometryBytes, "application/geo+json");
    }
    catch (FileNotFoundException)
    {
        return Results.Problem("Er is nog geen OSM-geometrie voor deze versie beschikbaar.", statusCode: 404);
    }
    catch (InvalidDataException exception)
    {
        return Results.Problem(exception.Message, statusCode: 409);
    }
    catch (JsonException)
    {
        return Results.Problem("De OSM-geometrie of het geocodingrapport is ongeldig.", statusCode: 409);
    }
});

app.MapGet("/api/versions/{version}/osm-geometry/status", async (string version, HttpClient client, CancellationToken cancellationToken) =>
{
    if (GetReviewStore(version) is null) return Results.NotFound();
    try
    {
        using var response = await client.GetAsync(new Uri(new Uri(brokerUrl), $"geometry/status/{version}"), cancellationToken);
        if (!response.IsSuccessStatusCode) return Results.Problem("De status van de geometrie is niet beschikbaar.", statusCode: 503);
        var status = await response.Content.ReadFromJsonAsync<AddressCheckStatus>(cancellationToken);
        return status is null ? Results.Problem("De status van de geometrie is ongeldig.", statusCode: 502) : Results.Ok(status);
    }
    catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or JsonException)
    {
        return Results.Problem("De status van de geometrie is niet beschikbaar.", statusCode: 503);
    }
});

app.MapPost("/api/versions/{version}/osm-geometry", async (string version, HttpRequest request, HttpClient client, CancellationToken cancellationToken) =>
{
    var store = GetReviewStore(version);
    if (store is null) return Results.NotFound();
    if (!request.HasJsonContentType() || (request.Headers.Origin.Count > 0 && request.Headers.Origin.ToString() != "http://routing.localtest.me"))
        return Results.Problem("Invalid request origin or content type.", statusCode: 403);
    try
    {
        await store.GetAsync(cancellationToken);
        using var response = await client.PostAsync(new Uri(new Uri(brokerUrl), $"geometry/start/{version}"), null, cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.Conflict)
            return Results.Conflict(new { detail = "Er loopt al een adrescontrole of geometrie-extractie." });
        if (!response.IsSuccessStatusCode) return Results.Problem("De lokale geometrie kon niet worden gestart.", statusCode: 503);
        return Results.Accepted($"/api/versions/{version}/osm-geometry/status", new AddressCheckStatus("running"));
    }
    catch (FileNotFoundException)
    {
        return Results.Problem("Het geocodingrapport ontbreekt.", statusCode: 404);
    }
    catch (InvalidDataException exception)
    {
        return Results.Problem(exception.Message, statusCode: 409);
    }
    catch (JsonException)
    {
        return Results.Problem("Het geocodingrapport of de review is ongeldig.", statusCode: 409);
    }
    catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
    {
        return Results.Problem("De geometrie-extractie is niet beschikbaar.", statusCode: 503);
    }
});

app.MapPost("/api/versions/{version}/review/{csvRecordNumber:int}/search", async (
    string version,
    int csvRecordNumber,
    PhotonSearchRequest request,
    CancellationToken cancellationToken) =>
{
    var store = GetReviewStore(version);
    if (store is null) return Results.NotFound();
    try
    {
        return Results.Ok(await store.SearchAsync(csvRecordNumber, request.Query, cancellationToken));
    }
    catch (FileNotFoundException exception)
    {
        return Results.Problem(exception.Message, statusCode: StatusCodes.Status404NotFound);
    }
    catch (KeyNotFoundException exception)
    {
        return Results.Problem(exception.Message, statusCode: StatusCodes.Status404NotFound);
    }
    catch (ArgumentException exception)
    {
        return Results.Problem(exception.Message, statusCode: StatusCodes.Status400BadRequest);
    }
    catch (HttpRequestException)
    {
        return Results.Problem("The local Photon geocoder is unavailable.", statusCode: StatusCodes.Status502BadGateway);
    }
    catch (JsonException)
    {
        return Results.Problem("The local Photon geocoder returned an invalid response.", statusCode: StatusCodes.Status502BadGateway);
    }
    catch (InvalidDataException exception)
    {
        return Results.Problem(exception.Message, statusCode: StatusCodes.Status409Conflict);
    }
});

app.MapPut("/api/versions/{version}/review/{csvRecordNumber:int}", async (
    string version,
    int csvRecordNumber,
    ReviewDecisionRequest request,
    CancellationToken cancellationToken) =>
{
    var store = GetReviewStore(version);
    if (store is null) return Results.NotFound();
    try
    {
        return Results.Ok(await store.UpdateAsync(csvRecordNumber, request, cancellationToken));
    }
    catch (FileNotFoundException exception)
    {
        return Results.Problem(exception.Message, statusCode: StatusCodes.Status404NotFound);
    }
    catch (KeyNotFoundException exception)
    {
        return Results.Problem(exception.Message, statusCode: StatusCodes.Status404NotFound);
    }
    catch (ArgumentException exception)
    {
        return Results.Problem(exception.Message, statusCode: StatusCodes.Status400BadRequest);
    }
    catch (InvalidDataException exception)
    {
        return Results.Problem(exception.Message, statusCode: StatusCodes.Status409Conflict);
    }
    catch (JsonException)
    {
        return Results.Problem("The geocoding report or review file contains invalid JSON.", statusCode: StatusCodes.Status409Conflict);
    }
});

await app.RunAsync();
return 0;
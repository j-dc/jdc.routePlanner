using System.Text.Json;
using System.Globalization;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Mvc;
using RoutePlanner.Api;

if (args.Length == 1 && args[0] == "--matrix-worker")
{
    await MatrixWorker.RunAsync();
    return 0;
}

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
var outputDirectory = Path.GetDirectoryName(Path.GetFullPath(reportPath))!;
string GetVersionFilePath(string version, string fileName) => OutputPaths.FilePath(outputDirectory, version, fileName);
var inputCsvPath = builder.Configuration["Review:InputCsvPath"] ?? "/input/ritten.csv";
var reviewPath = builder.Configuration["Review:ReviewFilePath"] ?? "/review/address-review.json";
var photonApiBaseUrl = builder.Configuration["Review:PhotonApiBaseUrl"] ?? "http://photon:2322/api/";
var brokerUrl = builder.Configuration["AddressCheck:BrokerUrl"] ?? "http://address-check-broker:8081/";
var photonStatusUrl = builder.Configuration["AddressCheck:PhotonStatusUrl"] ?? "http://photon:2322/status";
var matrixWorkerUrl = builder.Configuration["Matrix:WorkerUrl"] ?? "http://matrix-worker:8082/";
var routeWorkerUrl = builder.Configuration["Route:WorkerUrl"] ?? "http://vroom-worker:8083/";
var pdfWorkerUrl = builder.Configuration["DriverPdf:WorkerUrl"] ?? "http://driver-pdf:8084/";
builder.Services.AddSingleton(new HttpClient { Timeout = TimeSpan.FromSeconds(15) });

var app = builder.Build();
app.UseCors("routeplanner-ui");
var reviewStores = new ConcurrentDictionary<string, ReviewStore>(StringComparer.Ordinal);
ReviewStore? GetReviewStore(string version)
{
    if (!InputCsvStore.IsVersion(version) || !File.Exists(InputCsvStore.InputPath(inputCsvPath, version))) return null;
    return reviewStores.GetOrAdd(version, key => new ReviewStore(
        GetVersionFilePath(key, "address-check.json"),
        InputCsvStore.InputPath(inputCsvPath, key),
        key == "legacy" ? reviewPath : Path.Combine(Path.GetDirectoryName(Path.GetFullPath(reviewPath))!, $"address-review-{key}.json"),
        app.Services.GetRequiredService<HttpClient>(),
        photonApiBaseUrl));
}

var settingsStores = new ConcurrentDictionary<string, SettingsStore>(StringComparer.Ordinal);
SettingsStore? GetSettingsStore(string version)
{
    if (!InputCsvStore.IsVersion(version) || !File.Exists(InputCsvStore.InputPath(inputCsvPath, version))) return null;
    return settingsStores.GetOrAdd(version, key => new SettingsStore(GetVersionFilePath(key, "settings.json")));
}

bool MatrixMatches(JsonElement metadata, MatrixRequest input)
{
    var locations = metadata.GetProperty("locations").Deserialize<List<MatrixLocation>>(new JsonSerializerOptions(JsonSerializerDefaults.Web));
    return metadata.GetProperty("version").GetString() == input.Version &&
        metadata.GetProperty("reviewFingerprint").GetString() == input.ReviewFingerprint &&
        metadata.GetProperty("reviewUpdatedAtUtc").GetDateTimeOffset() == input.ReviewUpdatedAtUtc &&
        metadata.GetProperty("locationFingerprint").GetString() == MatrixWorker.LocationFingerprint(input.Locations) &&
        locations is not null && locations.SequenceEqual(input.Locations);
}

int GetDriverCount(SettingsDocument settings, int deliveryCount)
{
    if (!settings.Settings.TryGetValue("nmbDrivers", out var value) ||
        !int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var count) || count < 1)
        throw new InvalidDataException("Vul bij de instellingen een geldig positief aantal chauffeurs in.");
    if (count > deliveryCount)
        throw new InvalidDataException("Er zijn meer chauffeurs dan leveringen.");
    return count;
}

int GetServiceSeconds(SettingsDocument settings)
{
    if (!settings.Settings.TryGetValue("serviceSeconds", out var value)) return 60;
    if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var seconds) || seconds < 1)
        throw new InvalidDataException("Vul bij de instellingen een geldig positief geheel aantal seconden levertijd in.");
    return seconds;
}

int GetNonNegativeSetting(SettingsDocument settings, string key, int defaultValue, bool allowZero)
{
    if (!settings.Settings.TryGetValue(key, out var value)) return defaultValue;
    if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var result) ||
        result < (allowZero ? 0 : 1))
        throw new InvalidDataException($"De instelling {key} moet een geldig {(allowZero ? "niet-negatief" : "positief")} geheel getal zijn.");
    return result;
}

async Task<RouteCalculationInput> GetRouteInputAsync(string version, CancellationToken cancellationToken)
{
    var review = GetReviewStore(version) ?? throw new FileNotFoundException();
    var settingsStore = GetSettingsStore(version) ?? throw new FileNotFoundException();
    var settings = await settingsStore.GetAsync(cancellationToken);
    if (settings.StartLocation is null) throw new InvalidDataException("Stel eerst een startlocatie in.");
    var input = MatrixWorker.CreateRequest(version, await review.GetAsync(cancellationToken), settings);
    var count = GetDriverCount(settings, input.Locations.Count - 1);
    var serviceSeconds = GetServiceSeconds(settings);
    var capacity = GetNonNegativeSetting(settings, "Capacity", 60, false);
    var reloadSeconds = GetNonNegativeSetting(settings, "reloadSeconds", 10, true);
    var maxDifferenceMinutes = GetNonNegativeSetting(settings, "maxDifferenceMinutes", 30, true);
    var (inputHash, counts, routeLabels) = await InputCsvStore.ReadPackageCountsAsync(
        InputCsvStore.InputPath(inputCsvPath, version), capacity, cancellationToken);
    if (counts.Count != input.Locations.Count - 1 ||
        input.Locations.Skip(1).Any(location => !counts.ContainsKey(location.CsvRecordNumber!.Value)))
        throw new InvalidDataException("De pakketaantallen komen niet overeen met de bevestigde leveringen.");
    var packageCounts = input.Locations.Skip(1).Select(location => counts[location.CsvRecordNumber!.Value]).ToArray();
    var labels = input.Locations.Skip(1).Select(location => routeLabels[location.CsvRecordNumber!.Value]).ToArray();
    var client = app.Services.GetRequiredService<HttpClient>();
    using var response = await client.GetAsync(new Uri(new Uri(matrixWorkerUrl), $"status/{version}"), cancellationToken);
    response.EnsureSuccessStatusCode();
    var matrixStatus = await response.Content.ReadFromJsonAsync<MatrixStatus>(cancellationToken);
    if (matrixStatus?.State != "completed")
        throw new InvalidDataException("Een actuele, volledig berekende matrix is vereist.");
    var path = MatrixWorker.MatrixPath(outputDirectory, version);
    var bytes = await File.ReadAllBytesAsync(path, cancellationToken);
    using var matrix = JsonDocument.Parse(bytes);
    if (!MatrixMatches(matrix.RootElement.GetProperty("metadata"), input))
        throw new InvalidDataException("De matrix is verouderd; bereken deze opnieuw.");
    return new RouteCalculationInput(version, Convert.ToHexString(SHA256.HashData(bytes)), inputHash,
        count, serviceSeconds, capacity, reloadSeconds, maxDifferenceMinutes, packageCounts, labels);
}

async Task<MatrixStatus> GetRouteStatusAsync(string version, HttpClient client, CancellationToken cancellationToken)
{
    using var response = await client.GetAsync(new Uri(new Uri(routeWorkerUrl), $"status/{version}"), cancellationToken);
    response.EnsureSuccessStatusCode();
    var status = await response.Content.ReadFromJsonAsync<MatrixStatus>(cancellationToken)
        ?? throw new JsonException("De routestatus is leeg.");
    if (status.State != "completed") return status;
    try
    {
        var input = await GetRouteInputAsync(version, cancellationToken);
        var path = GetVersionFilePath(version, "routes.json");
        await using var stream = File.OpenRead(path);
        using var routes = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var metadata = routes.RootElement.GetProperty("metadata");
        if (!metadata.TryGetProperty("serviceTimeModel", out var serviceModel) ||
            serviceModel.GetString() != "per-location-visit-v1" ||
            !metadata.TryGetProperty("serviceSecondsPerVisit", out var serviceSeconds) ||
            serviceSeconds.GetInt32() != input.ServiceSeconds)
            return new MatrixStatus("stale", "De levertijd is gewijzigd; bereken de routes opnieuw.");
        if (!metadata.TryGetProperty("optimization", out var optimization) ||
            optimization.GetString() != "vroom-capacity-multitrip-v1")
            return new MatrixStatus("stale", "De routeoptimalisatie is gewijzigd; bereken de routes opnieuw.");
        if (input.RouteLabels.Any(label => label.Length > 0) &&
            (!routes.RootElement.TryGetProperty("oldRoutePlan", out var oldRoutePlan) ||
             oldRoutePlan.ValueKind != JsonValueKind.Object))
            return new MatrixStatus("stale", "De oude route-indeling ontbreekt; bereken de routes opnieuw.");
        if (metadata.GetProperty("version").GetString() != version ||
            metadata.GetProperty("matrixSha256").GetString() != input.MatrixSha256 ||
            metadata.GetProperty("inputSha256").GetString() != input.InputSha256 ||
            metadata.GetProperty("driverCount").GetInt32() != input.DriverCount ||
            metadata.GetProperty("capacity").GetInt32() != input.Capacity ||
            metadata.GetProperty("reloadSeconds").GetInt32() != input.ReloadSeconds ||
            metadata.GetProperty("maxAllowedDifferenceSeconds").GetInt64() != (long)input.MaxDifferenceMinutes * 60)
            return new MatrixStatus("stale", "De invoer, matrix of instellingen zijn gewijzigd; bereken de routes opnieuw.");
        return status;
    }
    catch (Exception exception) when (exception is FileNotFoundException or InvalidDataException or ArgumentException or JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
    {
        return new MatrixStatus("stale", "De routes zijn niet meer geldig; controleer de matrix en instellingen.");
    }
}

async Task<JsonElement> ReadOsmGeometryAsync(string version, CancellationToken cancellationToken)
{
    var selectedReport = GetVersionFilePath(version, "address-check.json");
    var geometryPath = GetVersionFilePath(version, "osm-geometry.geojson");
    var reportBytes = await File.ReadAllBytesAsync(selectedReport, cancellationToken);
    using var geometry = JsonDocument.Parse(await File.ReadAllBytesAsync(geometryPath, cancellationToken));
    var root = geometry.RootElement;
    if (root.ValueKind != JsonValueKind.Object ||
        !root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String || type.GetString() != "FeatureCollection" ||
        !root.TryGetProperty("features", out var features) || features.ValueKind != JsonValueKind.Array ||
        !root.TryGetProperty("metadata", out var metadata) || metadata.ValueKind != JsonValueKind.Object ||
        !metadata.TryGetProperty("sourceReportSha256", out var sourceHash) || sourceHash.ValueKind != JsonValueKind.String ||
        !string.Equals(sourceHash.GetString(), Convert.ToHexString(SHA256.HashData(reportBytes)), StringComparison.OrdinalIgnoreCase))
        throw new InvalidDataException("De OSM-geometrie past niet bij het huidige geocodingrapport.");
    return root.Clone();
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

app.MapGet("/api/versions/{version}/matrix-calculation", async (string version, HttpClient client, CancellationToken cancellationToken) =>
{
    if (!InputCsvStore.IsVersion(version) || !File.Exists(InputCsvStore.InputPath(inputCsvPath, version)))
        return Results.NotFound();
    try
    {
        using var response = await client.GetAsync(new Uri(new Uri(matrixWorkerUrl), $"status/{version}"), cancellationToken);
        if (!response.IsSuccessStatusCode) return Results.Problem("De matrixstatus is niet beschikbaar.", statusCode: 503);
        var status = await response.Content.ReadFromJsonAsync<MatrixStatus>(cancellationToken);
        if (status?.State == "completed")
        {
            try
            {
                var input = MatrixWorker.CreateRequest(version, await GetReviewStore(version)!.GetAsync(cancellationToken),
                    await GetSettingsStore(version)!.GetAsync(cancellationToken));
                var matrixPath = MatrixWorker.MatrixPath(outputDirectory, version);
                await using var stream = File.OpenRead(matrixPath);
                using var matrix = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
                var metadata = matrix.RootElement.GetProperty("metadata");
                if (!MatrixMatches(metadata, input))
                    status = new MatrixStatus("stale", "De review of startlocatie is gewijzigd; bereken de matrix opnieuw.");
            }
            catch (Exception exception) when (exception is FileNotFoundException or InvalidDataException or ArgumentException or JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
            {
                status = new MatrixStatus("stale", "De matrix is niet meer geldig; controleer de review en bereken opnieuw.");
            }
        }
        return status is null ? Results.Problem("De matrixstatus is ongeldig.", statusCode: 502) : Results.Ok(status);
    }
    catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or JsonException or IOException or UnauthorizedAccessException)
    {
        return Results.Problem("De matrixstatus is niet beschikbaar.", statusCode: 503);
    }
})
.WithName("GetMatrixStatus")
.WithSummary("Bekijk de status van de matrixberekening")
.Produces<MatrixStatus>()
.ProducesProblem(StatusCodes.Status503ServiceUnavailable)
.Produces(StatusCodes.Status404NotFound);

app.MapPost("/api/versions/{version}/matrix-calculation", async (string version, HttpRequest request, HttpClient client, CancellationToken cancellationToken) =>
{
    var review = GetReviewStore(version);
    var settings = GetSettingsStore(version);
    if (review is null || settings is null) return Results.NotFound();
    if (!request.HasJsonContentType() || (request.Headers.Origin.Count > 0 && request.Headers.Origin.ToString() != "http://routing.localtest.me"))
        return Results.Problem("Invalid request origin or content type.", statusCode: 403);
    try
    {
        var input = MatrixWorker.CreateRequest(version, await review.GetAsync(cancellationToken), await settings.GetAsync(cancellationToken));
        using var response = await client.PostAsJsonAsync(new Uri(new Uri(matrixWorkerUrl), "start"), input, cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.Conflict)
            return Results.Conflict(new { detail = "Er loopt al een matrixberekening." });
        if (!response.IsSuccessStatusCode)
            return Results.Problem("De matrixberekening of Valhalla is niet beschikbaar.", statusCode: 503);
        return Results.Accepted($"/api/versions/{version}/matrix-calculation", new MatrixStatus("running"));
    }
    catch (FileNotFoundException)
    {
        return Results.Problem("De adrescontrole of review ontbreekt.", statusCode: 404);
    }
    catch (InvalidDataException exception)
    {
        return Results.Problem(exception.Message, statusCode: 409);
    }
    catch (ArgumentException)
    {
        return Results.Problem("De startlocatie is ongeldig.", statusCode: 409);
    }
    catch (JsonException)
    {
        return Results.Problem("De review of instellingen bevatten ongeldige JSON.", statusCode: 409);
    }
    catch (Exception exception) when (exception is HttpRequestException or IOException or UnauthorizedAccessException or TaskCanceledException)
    {
        return Results.Problem("De matrixberekening of Valhalla is niet beschikbaar.", statusCode: 503);
    }
})
.WithName("CalculateMatrix")
.WithSummary("Start matrixberekening voor een planningsversie")
.WithDescription("Start een asynchrone Valhalla-matrixberekening voor de bevestigde leveringen.")
.Produces<MatrixStatus>(StatusCodes.Status202Accepted)
.ProducesProblem(StatusCodes.Status409Conflict)
.ProducesProblem(StatusCodes.Status503ServiceUnavailable)
.Produces(StatusCodes.Status404NotFound);

app.MapGet("/api/versions/{version}/route-calculation", async (string version, HttpClient client, CancellationToken cancellationToken) =>
{
    if (!InputCsvStore.IsVersion(version) || !File.Exists(InputCsvStore.InputPath(inputCsvPath, version)))
        return Results.NotFound();
    try { return Results.Ok(await GetRouteStatusAsync(version, client, cancellationToken)); }
    catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or JsonException or IOException or UnauthorizedAccessException)
    {
        return Results.Problem("De routestatus is niet beschikbaar.", statusCode: 503);
    }
})
.WithName("GetRouteStatus")
.WithSummary("Bekijk de status van de routeberekening")
.Produces<MatrixStatus>()
.ProducesProblem(StatusCodes.Status503ServiceUnavailable)
.Produces(StatusCodes.Status404NotFound);

app.MapPost("/api/versions/{version}/route-calculation", async (string version, HttpRequest request, HttpClient client, CancellationToken cancellationToken) =>
{
    if (GetReviewStore(version) is null || GetSettingsStore(version) is null) return Results.NotFound();
    if (!request.HasJsonContentType() || (request.Headers.Origin.Count > 0 && request.Headers.Origin.ToString() != "http://routing.localtest.me"))
        return Results.Problem("Invalid request origin or content type.", statusCode: 403);
    try
    {
        var input = await GetRouteInputAsync(version, cancellationToken);
        using var response = await client.PostAsJsonAsync(new Uri(new Uri(routeWorkerUrl), "start"),
            input, cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.Conflict)
            return Results.Conflict(new { detail = "Er loopt al een routeberekening." });
        if (!response.IsSuccessStatusCode)
            return Results.Problem("De routeworker is niet beschikbaar.", statusCode: 503);
        return Results.Accepted($"/api/versions/{version}/route-calculation", new MatrixStatus("running"));
    }
    catch (FileNotFoundException) { return Results.Problem("De matrix of review ontbreekt.", statusCode: 409); }
    catch (InvalidDataException exception) { return Results.Problem(exception.Message, statusCode: 409); }
    catch (Exception exception) when (exception is ArgumentException or JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
    {
        return Results.Problem("De matrix of instellingen zijn ongeldig; controleer de invoer.", statusCode: 409);
    }
    catch (Exception exception) when (exception is HttpRequestException or IOException or UnauthorizedAccessException or TaskCanceledException)
    {
        return Results.Problem("De routeberekening of matrixstatus is niet beschikbaar.", statusCode: 503);
    }
})
.WithName("CalculateRoute")
.WithSummary("Start routeberekening voor een planningsversie")
.WithDescription("Verdeel leveringen met VROOM over de geselecteerde chauffeurs.")
.Produces<MatrixStatus>(StatusCodes.Status202Accepted)
.ProducesProblem(StatusCodes.Status409Conflict)
.ProducesProblem(StatusCodes.Status503ServiceUnavailable)
.Produces(StatusCodes.Status404NotFound);

app.MapGet("/api/versions/{version}/driver-pdf-data", async (string version, HttpClient client, CancellationToken cancellationToken) =>
{
    var store = GetReviewStore(version);
    if (store is null) return Results.NotFound();
    try
    {
        if ((await GetRouteStatusAsync(version, client, cancellationToken)).State != "completed")
            return Results.Problem("Er is geen actuele voltooide routeberekening.", statusCode: 409);
        var input = await GetRouteInputAsync(version, cancellationToken);
        var routePath = GetVersionFilePath(version, "routes.json");
        var routeBytes = await File.ReadAllBytesAsync(routePath, cancellationToken);
        var matrixPath = MatrixWorker.MatrixPath(outputDirectory, version);
        var matrixBytes = await File.ReadAllBytesAsync(matrixPath, cancellationToken);
        var (inputHash, rows, _) = await InputCsvStore.ReadDeliveriesAsync(
            InputCsvStore.InputPath(inputCsvPath, version), input.Capacity, cancellationToken);
        if (inputHash != input.InputSha256 || Convert.ToHexString(SHA256.HashData(matrixBytes)) != input.MatrixSha256)
            return Results.Problem("De invoer of matrix is gewijzigd.", statusCode: 409);
        using var routes = JsonDocument.Parse(routeBytes);
        using var matrix = JsonDocument.Parse(matrixBytes);
        var deliveries = rows.Select(row => new
        {
            row.CsvRecordNumber, row.Name, row.Street, row.HouseNumber, row.Postcode, row.Municipality,
            row.PackageCount, row.Bellen, row.RemarkUpper, row.RemarkLower
        }).ToArray();
        var currentRouteBytes = await File.ReadAllBytesAsync(routePath, cancellationToken);
        if ((await GetRouteStatusAsync(version, client, cancellationToken)).State != "completed" ||
            !routeBytes.AsSpan().SequenceEqual(currentRouteBytes))
            return Results.Problem("De routeberekening is gewijzigd.", statusCode: 409);
        return Results.Ok(new
        {
            Version = version,
            Routes = routes.RootElement.GetProperty("routes").Clone(),
            Locations = matrix.RootElement.GetProperty("metadata").GetProperty("locations").Clone(),
            Deliveries = deliveries
        });
    }
    catch (InvalidDataException exception) { return Results.Problem(exception.Message, statusCode: 409); }
    catch (FileNotFoundException) { return Results.Problem("De routegegevens ontbreken.", statusCode: 409); }
    catch (Exception exception) when (exception is HttpRequestException or IOException or UnauthorizedAccessException or TaskCanceledException or JsonException or InvalidOperationException or KeyNotFoundException or ArgumentException)
    {
        return Results.Problem("De PDF-invoer is niet beschikbaar of ongeldig.", statusCode: 503);
    }
})
.WithName("GetDriverPdfData")
.WithSummary("Haal de actuele gegevens voor chauffeur-PDF's op");

app.MapGet("/api/versions/{version}/driver-pdfs", async (string version, HttpClient client, CancellationToken cancellationToken) =>
{
    if (GetReviewStore(version) is null) return Results.NotFound();
    try
    {
        using var response = await client.GetAsync(new Uri(new Uri(pdfWorkerUrl), $"status/{version}"), cancellationToken);
        if (!response.IsSuccessStatusCode) return Results.Problem("De PDF-status is niet beschikbaar.", statusCode: 503);
        return Results.Content(await response.Content.ReadAsStringAsync(cancellationToken), "application/json");
    }
    catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
    {
        return Results.Problem("De PDF-status is niet beschikbaar.", statusCode: 503);
    }
})
.WithName("GetDriverPdfStatus")
.WithSummary("Bekijk de status van chauffeur-PDF's");

app.MapPost("/api/versions/{version}/driver-pdfs", async (string version, HttpRequest request, HttpClient client, CancellationToken cancellationToken) =>
{
    if (GetReviewStore(version) is null) return Results.NotFound();
    if (!request.HasJsonContentType() || (request.Headers.Origin.Count > 0 && request.Headers.Origin.ToString() != "http://routing.localtest.me"))
        return Results.Problem("Invalid request origin or content type.", statusCode: 403);
    try
    {
        if ((await GetRouteStatusAsync(version, client, cancellationToken)).State != "completed")
            return Results.Problem("Er is geen actuele voltooide routeberekening.", statusCode: 409);
        using var content = new StringContent(JsonSerializer.Serialize(new { version }), System.Text.Encoding.UTF8, "application/json");
        using var response = await client.PostAsync(new Uri(new Uri(pdfWorkerUrl), "start"), content, cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.Conflict)
            return Results.Conflict(new { detail = "Er loopt al een PDF-generatie." });
        if (!response.IsSuccessStatusCode)
        {
            app.Logger.LogWarning("De PDF-worker weigerde de aanvraag met HTTP-status {StatusCode}.", (int)response.StatusCode);
            return Results.Problem("De PDF-generatie is niet beschikbaar. Controleer de API- en PDF-workerlogs.", statusCode: 503);
        }
        return Results.Accepted($"/api/versions/{version}/driver-pdfs", new MatrixStatus("running"));
    }
    catch (Exception exception) when (exception is HttpRequestException or IOException or UnauthorizedAccessException or TaskCanceledException or JsonException)
    {
        app.Logger.LogWarning("De PDF-generatie kon niet worden gestart ({ErrorType}).", exception.GetType().Name);
        return Results.Problem("De PDF-generatie is niet beschikbaar. Controleer de API- en PDF-workerlogs.", statusCode: 503);
    }
})
.WithName("CreateDriverPdfs")
.WithSummary("Start het maken van chauffeur-PDF's");

app.MapGet("/api/versions/{version}/routes", async (string version, HttpClient client, CancellationToken cancellationToken) =>
{
    if (GetReviewStore(version) is null) return Results.NotFound();
    try
    {
        var status = await GetRouteStatusAsync(version, client, cancellationToken);
        if (status.State != "completed") return Results.Problem("Er is geen actuele voltooide routeberekening.", statusCode: 409);
        var path = GetVersionFilePath(version, "routes.json");
        return Results.File(await File.ReadAllBytesAsync(path, cancellationToken), "application/json");
    }
    catch (Exception exception) when (exception is HttpRequestException or IOException or UnauthorizedAccessException or TaskCanceledException or JsonException)
    {
        return Results.Problem("De routes zijn niet beschikbaar.", statusCode: 503);
    }
})
.WithName("GetRoutes")
.WithSummary("Haal de actuele berekende routes op")
.Produces(StatusCodes.Status200OK, contentType: "application/json")
.ProducesProblem(StatusCodes.Status409Conflict)
.Produces(StatusCodes.Status404NotFound);

app.MapGet("/api/versions/{version}/route-geometry", async (string version, HttpClient client, CancellationToken cancellationToken) =>
{
    if (GetReviewStore(version) is null) return Results.NotFound();
    try
    {
        if ((await GetRouteStatusAsync(version, client, cancellationToken)).State != "completed")
            return Results.Problem("Er is geen actuele voltooide routeberekening.", statusCode: 409);
        using var geometryClient = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        using var response = await geometryClient.GetAsync(new Uri(new Uri(routeWorkerUrl), $"geometry/{version}"), cancellationToken);
        if (!response.IsSuccessStatusCode)
            return Results.Problem("De routegeometrie is niet beschikbaar. Controleer Valhalla en probeer opnieuw.", statusCode: 503);
        var geometry = await response.Content.ReadAsByteArrayAsync(cancellationToken);
        if ((await GetRouteStatusAsync(version, client, cancellationToken)).State != "completed")
            return Results.Problem("De routeberekening is gewijzigd tijdens het ophalen van de geometrie.", statusCode: 409);
        return Results.File(geometry, "application/geo+json");
    }
    catch (Exception exception) when (exception is HttpRequestException or IOException or UnauthorizedAccessException or TaskCanceledException or JsonException)
    {
        return Results.Problem("De routegeometrie is niet beschikbaar. Controleer Valhalla en probeer opnieuw.", statusCode: 503);
    }
})
.WithName("GetRouteGeometry")
.WithSummary("Haal de Valhalla-geometrie van actuele routes op")
.Produces(StatusCodes.Status200OK, contentType: "application/geo+json")
.ProducesProblem(StatusCodes.Status409Conflict)
.ProducesProblem(StatusCodes.Status503ServiceUnavailable)
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
    try
    {
        await store.GetAsync(cancellationToken);
        return Results.Content((await ReadOsmGeometryAsync(version, cancellationToken)).GetRawText(), "application/geo+json");
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
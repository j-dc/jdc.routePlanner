using System.Security.Cryptography;
using System.Text.Json;

namespace RoutePlanner.Api;

/// <summary>Matrix index linked to a delivery record, or to the start location.</summary>
public sealed record MatrixLocation(int? CsvRecordNumber, double Latitude, double Longitude);

/// <summary>Validated snapshot used to calculate a matrix.</summary>
public sealed record MatrixRequest(
    string Version,
    string ReviewFingerprint,
    DateTimeOffset ReviewUpdatedAtUtc,
    List<MatrixLocation> Locations);

/// <summary>Current state and any failure or staleness explanation.</summary>
public sealed record MatrixStatus(string State, string? Message = null);

public static class MatrixWorker
{
    private const int BatchSize = 20;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static string? _runningVersion;

    public static async Task RunAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://0.0.0.0:8082");
        var app = builder.Build();
        var outputDirectory = builder.Configuration["Matrix:OutputDirectory"] ?? "/output";
        var valhallaUrl = builder.Configuration["Matrix:ValhallaUrl"] ?? "http://valhalla:8002/";
        var apiUrl = builder.Configuration["Matrix:ApiUrl"] ?? "http://routeplanner-api:8080/";
        using var client = new HttpClient { BaseAddress = new Uri(valhallaUrl), Timeout = TimeSpan.FromMinutes(2) };
        using var api = new HttpClient { BaseAddress = new Uri(apiUrl), Timeout = TimeSpan.FromSeconds(15) };
        var logger = app.Logger;

        app.MapGet("/health", () => Results.Ok());
        app.MapGet("/status/{version}", async (string version, CancellationToken cancellationToken) =>
        {
            if (!InputCsvStore.IsVersion(version)) return Results.NotFound();
            await Gate.WaitAsync(cancellationToken);
            try
            {
                if (_runningVersion is not null)
                    return Results.Ok(new MatrixStatus(_runningVersion == version ? "running" : "busy"));
                var status = await ReadStatusAsync(outputDirectory, version, cancellationToken);
                return Results.Ok(status.State == "running"
                    ? new MatrixStatus("failed", "De matrixberekening is onderbroken.")
                    : status);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
            {
                logger.LogError(exception, "Matrixstatus kon niet worden gelezen.");
                return Results.Problem("De matrixstatus is niet beschikbaar.", statusCode: 503);
            }
            finally { Gate.Release(); }
        });

        app.MapPost("/start", async (MatrixRequest request, CancellationToken cancellationToken) =>
        {
            if (!IsValid(request)) return Results.Problem("De matrixinvoer is ongeldig.", statusCode: 400);
            await Gate.WaitAsync(cancellationToken);
            try
            {
                if (_runningVersion is not null)
                    return Results.Conflict(new { detail = "Er loopt al een matrixberekening." });
                using var health = await client.GetAsync("status", cancellationToken);
                if (!health.IsSuccessStatusCode)
                    return Results.Problem("Valhalla is niet beschikbaar.", statusCode: 503);
                await WriteStatusAsync(outputDirectory, request.Version, new MatrixStatus("running"), cancellationToken);
                _runningVersion = request.Version;
                _ = Task.Run(() => CalculateAsync(request, outputDirectory, client, api, logger, app.Lifetime.ApplicationStopping));
                return Results.Accepted(value: new MatrixStatus("running"));
            }
            catch (Exception exception) when (exception is HttpRequestException or IOException or UnauthorizedAccessException or OperationCanceledException)
            {
                logger.LogError(exception, "Matrixberekening kon niet worden gestart.");
                return Results.Problem("De matrixberekening of Valhalla is niet beschikbaar.", statusCode: 503);
            }
            finally { Gate.Release(); }
        });

        await app.RunAsync();
    }

    private static bool IsValid(MatrixRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Version) || !InputCsvStore.IsVersion(request.Version) || string.IsNullOrWhiteSpace(request.ReviewFingerprint) ||
            request.Locations is null || request.Locations.Count < 2 ||
            request.Locations[0] is null || request.Locations[0].CsvRecordNumber is not null) return false;
        var records = new HashSet<int>();
        var startCount = 0;
        foreach (var location in request.Locations)
        {
            if (location is null || !double.IsFinite(location.Latitude) || !double.IsFinite(location.Longitude) ||
                location.Latitude is < -90 or > 90 || location.Longitude is < -180 or > 180) return false;
            if (location.CsvRecordNumber is null) { if (++startCount > 1) return false; }
            else if (location.CsvRecordNumber < 2 || !records.Add(location.CsvRecordNumber.Value)) return false;
        }
        return startCount == 1 && records.Count > 0;
    }

    public static MatrixRequest CreateRequest(string version, ReviewDocument review, SettingsDocument settings)
    {
        if (!review.ReadyForNextStep || review.Records.Count != review.TotalRecords)
            throw new InvalidDataException("Alle leveringen moeten bevestigd zijn voordat de matrix kan worden berekend.");
        var start = settings.StartLocation ??
            throw new InvalidDataException("Stel eerst een startlocatie in voordat de matrix kan worden berekend.");
        SettingsStore.ValidateStartLocation(start);
        var locations = new List<MatrixLocation> { new(null, start.Latitude, start.Longitude) };
        foreach (var record in review.Records.OrderBy(record => record.CsvRecordNumber))
        {
            if (record.Decision is not (ReviewDecision.Accepted or ReviewDecision.AutoAccepted) ||
                record.Latitude is null || record.Longitude is null)
                throw new InvalidDataException("Een bevestigde levering heeft geen geldige coördinaten.");
            locations.Add(new MatrixLocation(record.CsvRecordNumber, record.Latitude.Value, record.Longitude.Value));
        }
        var input = new MatrixRequest(version, review.SourceFingerprint, review.UpdatedAtUtc, locations);
        if (!IsValid(input)) throw new InvalidDataException("De bevestigde leverlocaties zijn ongeldig.");
        return input;
    }

    private static async Task CalculateAsync(
        MatrixRequest request, string outputDirectory, HttpClient client, HttpClient api, ILogger logger, CancellationToken cancellationToken)
    {
        MatrixStatus status;
        try
        {
            var count = request.Locations.Count;
            var distances = Enumerable.Range(0, count).Select(_ => new uint[count]).ToArray();
            var durations = Enumerable.Range(0, count).Select(_ => new uint[count]).ToArray();
            for (var sourceOffset = 0; sourceOffset < count; sourceOffset += BatchSize)
            {
                var sources = request.Locations.Skip(sourceOffset).Take(BatchSize).ToArray();
                for (var targetOffset = 0; targetOffset < count; targetOffset += BatchSize)
                {
                    var targets = request.Locations.Skip(targetOffset).Take(BatchSize).ToArray();
                    var payload = new
                    {
                        sources = sources.Select(location => new { lat = location.Latitude, lon = location.Longitude }),
                        targets = targets.Select(location => new { lat = location.Latitude, lon = location.Longitude }),
                        costing = "auto",
                        costing_options = new { auto = new { shortest = true } },
                        units = "kilometers",
                        verbose = true
                    };
                    using var response = await client.PostAsJsonAsync("sources_to_targets", payload, cancellationToken);
                    response.EnsureSuccessStatusCode();
                    using var data = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
                    var rows = data.RootElement.GetProperty("sources_to_targets");
                    if (rows.ValueKind != JsonValueKind.Array || rows.GetArrayLength() != sources.Length)
                        throw new InvalidDataException("Valhalla gaf een ongeldige matrix terug.");
                    for (var i = 0; i < sources.Length; i++)
                    {
                        var row = rows[i];
                        if (row.ValueKind != JsonValueKind.Array || row.GetArrayLength() != targets.Length)
                            throw new InvalidDataException("Valhalla gaf een ongeldige matrixrij terug.");
                        for (var j = 0; j < targets.Length; j++)
                        {
                            var cell = row[j];
                            if (cell.GetProperty("from_index").GetInt32() != i || cell.GetProperty("to_index").GetInt32() != j)
                                throw new InvalidDataException("Valhalla gaf ongeldige matrixindexen terug.");
                            durations[sourceOffset + i][targetOffset + j] = GetValue(cell, "time", 1);
                            distances[sourceOffset + i][targetOffset + j] = GetValue(cell, "distance", 1000);
                        }
                    }
                }
            }
            var currentReview = await api.GetFromJsonAsync<ReviewDocument>($"api/versions/{request.Version}/review", cancellationToken)
                ?? throw new InvalidDataException("De review is niet beschikbaar.");
            var currentSettings = await api.GetFromJsonAsync<SettingsDocument>($"api/versions/{request.Version}/settings", cancellationToken)
                ?? throw new InvalidDataException("De instellingen zijn niet beschikbaar.");
            var current = CreateRequest(request.Version, currentReview, currentSettings);
            if (current.ReviewFingerprint != request.ReviewFingerprint || current.ReviewUpdatedAtUtc != request.ReviewUpdatedAtUtc ||
                !current.Locations.SequenceEqual(request.Locations))
                throw new InvalidDataException("De review of startlocatie is gewijzigd tijdens de matrixberekening.");
            var fingerprint = LocationFingerprint(request.Locations);
            var output = new
            {
                matrices = new { car = new { durations, distances, costs = distances } },
                metadata = new
                {
                    request.Version,
                    request.ReviewFingerprint,
                    request.ReviewUpdatedAtUtc,
                    locationFingerprint = fingerprint,
                    locations = request.Locations,
                    valhallaCosting = "auto",
                    shortest = true,
                    distanceUnit = "meters",
                    durationUnit = "seconds"
                }
            };
            await WriteAtomicallyAsync(MatrixPath(outputDirectory, request.Version), output, cancellationToken);
            status = new MatrixStatus("completed");
        }
        catch (InvalidDataException exception)
        {
            logger.LogError(exception, "Matrixberekening mislukt voor versie {Version}.", request.Version);
            status = new MatrixStatus("failed", exception.Message);
        }
        catch (Exception exception) when (exception is HttpRequestException or IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or ArgumentException or KeyNotFoundException or OverflowException or OperationCanceledException)
        {
            logger.LogError(exception, "Matrixberekening mislukt voor versie {Version}.", request.Version);
            status = new MatrixStatus("failed", "Matrixberekening mislukt. Controleer Valhalla, bereikbaarheid en de containerlogs.");
        }
        await Gate.WaitAsync(CancellationToken.None);
        try
        {
            try { await WriteStatusAsync(outputDirectory, request.Version, status, CancellationToken.None); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                logger.LogError(exception, "Matrixstatus kon niet worden opgeslagen.");
            }
            _runningVersion = null;
        }
        finally { Gate.Release(); }
    }

    private static uint GetValue(JsonElement cell, string name, int multiplier)
    {
        if (!cell.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number ||
            !value.TryGetDouble(out var number) || !double.IsFinite(number) || number < 0 ||
            number * multiplier > uint.MaxValue)
            throw new InvalidDataException("Valhalla gaf een onbereikbare of ongeldige verbinding terug.");
        return checked((uint)Math.Round(number * multiplier, MidpointRounding.AwayFromZero));
    }

    public static string LocationFingerprint(List<MatrixLocation> locations) =>
        Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(locations, JsonOptions)));

    public static string MatrixPath(string directory, string version) =>
        Path.Combine(directory, version == "legacy" ? "matrix.json" : $"matrix-{version}.json");

    private static string StatusPath(string directory, string version) =>
        Path.Combine(directory, version == "legacy" ? "matrix-status.json" : $"matrix-status-{version}.json");

    private static async Task<MatrixStatus> ReadStatusAsync(string directory, string version, CancellationToken cancellationToken)
    {
        var path = StatusPath(directory, version);
        if (!File.Exists(path)) return new MatrixStatus("idle");
        await using var stream = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<MatrixStatus>(stream, JsonOptions, cancellationToken)
            ?? throw new JsonException("Matrixstatus is leeg.");
    }

    private static Task WriteStatusAsync(string directory, string version, MatrixStatus status, CancellationToken cancellationToken) =>
        WriteAtomicallyAsync(StatusPath(directory, version), status, cancellationToken);

    private static async Task WriteAtomicallyAsync<T>(string path, T value, CancellationToken cancellationToken)
    {
        var temporaryPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            await using (var stream = File.Create(temporaryPath))
                await JsonSerializer.SerializeAsync(stream, value, JsonOptions, cancellationToken);
            File.Move(temporaryPath, path, true);
        }
        finally { if (File.Exists(temporaryPath)) File.Delete(temporaryPath); }
    }
}

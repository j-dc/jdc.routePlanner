using System.Text.Json;
using System.Text.RegularExpressions;

namespace RoutePlanner.Api;

public sealed record SettingValueRequest(string? Value);

public sealed record StartLocation
{
    public string Label { get; init; } = string.Empty;
    public string Street { get; init; } = string.Empty;
    public string HouseNumber { get; init; } = string.Empty;
    public string Postcode { get; init; } = string.Empty;
    public string Municipality { get; init; } = string.Empty;
    public double Latitude { get; init; }
    public double Longitude { get; init; }
    public string? OsmType { get; init; }
    public long? OsmId { get; init; }
}

public sealed record SettingsDocument
{
    public StartLocation? StartLocation { get; init; }
    public Dictionary<string, string> Settings { get; init; } = new(StringComparer.Ordinal);
}

public sealed partial class SettingsStore(string path)
{
    public const int MaxValueLength = 1000;
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private readonly SemaphoreSlim _gate = new(1, 1);

    [GeneratedRegex("^[A-Za-z0-9_.-]{1,64}$")]
    private static partial Regex KeyPattern();

    public static bool IsKey(string key) => KeyPattern().IsMatch(key);

    public static void ValidateStartLocation(StartLocation location)
    {
        if (location.Latitude is < -90 or > 90 || location.Longitude is < -180 or > 180 ||
            double.IsNaN(location.Latitude) || double.IsNaN(location.Longitude))
            throw new ArgumentException("De coördinaten van de startlocatie zijn ongeldig.");
        if (string.IsNullOrWhiteSpace(location.Label) || location.Label.Length > 300)
            throw new ArgumentException("De startlocatie heeft geen geldig label.");
    }

    public async Task<SettingsDocument> GetAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try { return await ReadAsync(cancellationToken); }
        finally { _gate.Release(); }
    }

    public async Task SetStartLocationAsync(StartLocation location, CancellationToken cancellationToken)
    {
        ValidateStartLocation(location);
        await _gate.WaitAsync(cancellationToken);
        try { await WriteAsync((await ReadAsync(cancellationToken)) with { StartLocation = location }, cancellationToken); }
        finally { _gate.Release(); }
    }

    public async Task<bool> RemoveStartLocationAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var document = await ReadAsync(cancellationToken);
            if (document.StartLocation is null) return false;
            await WriteAsync(document with { StartLocation = null }, cancellationToken);
            return true;
        }
        finally { _gate.Release(); }
    }

    public async Task SetAsync(string key, string value, CancellationToken cancellationToken)
    {
        if (!IsKey(key)) throw new ArgumentException("De sleutel mag enkel letters, cijfers, '_', '.' en '-' bevatten (max. 64 tekens).");
        if (value.Length > MaxValueLength) throw new ArgumentException($"De waarde mag maximaal {MaxValueLength} tekens bevatten.");
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var document = await ReadAsync(cancellationToken);
            document.Settings[key] = value;
            await WriteAsync(document, cancellationToken);
        }
        finally { _gate.Release(); }
    }

    public async Task<bool> RemoveAsync(string key, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var document = await ReadAsync(cancellationToken);
            if (!document.Settings.Remove(key)) return false;
            await WriteAsync(document, cancellationToken);
            return true;
        }
        finally { _gate.Release(); }
    }

    public static async Task<IReadOnlyList<StartLocation>> SearchAsync(HttpClient client, Uri photonApiBaseUri, string query, CancellationToken cancellationToken)
    {
        var trimmed = query?.Trim() ?? string.Empty;
        if (trimmed.Length < 3 || trimmed.Length > 200) throw new ArgumentException("Zoektekst moet tussen 3 en 200 tekens bevatten.");
        var uri = new UriBuilder(photonApiBaseUri) { Query = $"q={Uri.EscapeDataString(trimmed)}&limit=10&countrycode=BE&dedupe=0" }.Uri;
        using var response = await client.GetAsync(uri, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        if (!document.RootElement.TryGetProperty("features", out var features) || features.ValueKind != JsonValueKind.Array)
            throw new JsonException("Photon response did not contain a features array.");

        var results = new List<StartLocation>();
        foreach (var feature in features.EnumerateArray())
        {
            if (!feature.TryGetProperty("geometry", out var geometry) ||
                !geometry.TryGetProperty("coordinates", out var coordinates) || coordinates.ValueKind != JsonValueKind.Array ||
                coordinates.GetArrayLength() < 2 ||
                coordinates[0].ValueKind != JsonValueKind.Number || coordinates[1].ValueKind != JsonValueKind.Number ||
                !feature.TryGetProperty("properties", out var properties) || properties.ValueKind != JsonValueKind.Object) continue;
            string Text(string name) => properties.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
            var street = Text("street");
            var houseNumber = Text("housenumber");
            var postcode = Text("postcode");
            var municipality = Text("city");
            var name = Text("name");
            var line = string.Join(' ', new[] { street, houseNumber }.Where(part => part.Length > 0));
            var place = string.Join(' ', new[] { postcode, municipality }.Where(part => part.Length > 0));
            var label = string.Join(", ", new[] { name, line, place }.Where(part => part.Length > 0).Distinct());
            var location = new StartLocation
            {
                Label = label,
                Street = street,
                HouseNumber = houseNumber,
                Postcode = postcode,
                Municipality = municipality,
                Longitude = coordinates[0].GetDouble(),
                Latitude = coordinates[1].GetDouble(),
                OsmType = Text("osm_type") is { Length: > 0 } osmType ? osmType : null,
                OsmId = properties.TryGetProperty("osm_id", out var osmId) && osmId.ValueKind == JsonValueKind.Number ? osmId.GetInt64() : null
            };
            try { ValidateStartLocation(location); } catch (ArgumentException) { continue; }
            results.Add(location);
        }
        return results;
    }

    private async Task<SettingsDocument> ReadAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(path)) return new SettingsDocument();
        await using var stream = File.OpenRead(path);
        using var json = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = json.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new JsonException("Settings file is not an object.");
        var isDocument = (root.TryGetProperty("Settings", out var settings) && settings.ValueKind == JsonValueKind.Object) ||
            (root.TryGetProperty("StartLocation", out var start) && start.ValueKind is JsonValueKind.Object or JsonValueKind.Null);
        if (isDocument) return root.Deserialize<SettingsDocument>() ?? new SettingsDocument();
        // Oudere bestanden bevatten enkel de platte key-values.
        return new SettingsDocument { Settings = root.Deserialize<Dictionary<string, string>>() ?? new(StringComparer.Ordinal) };
    }

    private async Task WriteAsync(SettingsDocument document, CancellationToken cancellationToken)
    {
        var temporaryPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            await File.WriteAllTextAsync(temporaryPath, JsonSerializer.Serialize(document, JsonOptions), cancellationToken);
            File.Move(temporaryPath, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }
}

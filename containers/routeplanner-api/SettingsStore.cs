using System.Text.Json;
using System.Text.RegularExpressions;

namespace RoutePlanner.Api;

public sealed record SettingValueRequest(string? Value);

public sealed partial class SettingsStore(string path)
{
    public const int MaxValueLength = 1000;
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private readonly SemaphoreSlim _gate = new(1, 1);

    [GeneratedRegex("^[A-Za-z0-9_.-]{1,64}$")]
    private static partial Regex KeyPattern();

    public static bool IsKey(string key) => KeyPattern().IsMatch(key);

    public async Task<IReadOnlyDictionary<string, string>> GetAllAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try { return await ReadAsync(cancellationToken); }
        finally { _gate.Release(); }
    }

    public async Task<string?> GetAsync(string key, CancellationToken cancellationToken) =>
        (await GetAllAsync(cancellationToken)).TryGetValue(key, out var value) ? value : null;

    public async Task SetAsync(string key, string value, CancellationToken cancellationToken)
    {
        if (!IsKey(key)) throw new ArgumentException("De sleutel mag enkel letters, cijfers, '_', '.' en '-' bevatten (max. 64 tekens).");
        if (value.Length > MaxValueLength) throw new ArgumentException($"De waarde mag maximaal {MaxValueLength} tekens bevatten.");
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var settings = new Dictionary<string, string>(await ReadAsync(cancellationToken), StringComparer.Ordinal) { [key] = value };
            await WriteAsync(settings, cancellationToken);
        }
        finally { _gate.Release(); }
    }

    public async Task<bool> RemoveAsync(string key, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var settings = new Dictionary<string, string>(await ReadAsync(cancellationToken), StringComparer.Ordinal);
            if (!settings.Remove(key)) return false;
            await WriteAsync(settings, cancellationToken);
            return true;
        }
        finally { _gate.Release(); }
    }

    private async Task<IReadOnlyDictionary<string, string>> ReadAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(path)) return new Dictionary<string, string>();
        await using var stream = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<Dictionary<string, string>>(stream, cancellationToken: cancellationToken)
            ?? new Dictionary<string, string>();
    }

    private async Task WriteAsync(Dictionary<string, string> settings, CancellationToken cancellationToken)
    {
        var temporaryPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            await File.WriteAllTextAsync(temporaryPath, JsonSerializer.Serialize(settings, JsonOptions), cancellationToken);
            File.Move(temporaryPath, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }
}

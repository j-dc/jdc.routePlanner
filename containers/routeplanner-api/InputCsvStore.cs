using System.Text;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using Microsoft.VisualBasic.FileIO;

namespace RoutePlanner.Api;

public static class InputCsvStore
{
    private const string VersionFormat = "yyyyMMdd'T'HHmmssfffffff'Z'";
    private static readonly string[] ExpectedHeaders =
    [
        "rit", "naam", "straat", "nr.", "postcode", "gemeente",
        "aantal", "bellen", "Opmerking", "opmerking", "klas"
    ];

    public static bool IsVersion(string version) =>
        version == "legacy" ||
        (Regex.IsMatch(version, @"^\d{8}T\d{13}Z$") &&
         DateTimeOffset.TryParseExact(version, VersionFormat, CultureInfo.InvariantCulture,
             DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out _));

    public static string InputPath(string inputPath, string version) => version == "legacy"
        ? inputPath
        : Path.Combine(Path.GetDirectoryName(Path.GetFullPath(inputPath))!, $"ritten-{version}.csv");

    public static string[] ListVersions(string inputPath)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(inputPath))!;
        if (!Directory.Exists(directory)) return [];
        var versions = Directory.EnumerateFiles(directory, "ritten-*.csv")
            .Select(path => Path.GetFileName(path)[7..^4])
            .Where(version => version != "legacy" && IsVersion(version))
            .OrderDescending(StringComparer.Ordinal)
            .ToList();
        if (File.Exists(inputPath)) versions.Add("legacy");
        return versions.ToArray();
    }

    public static async Task<(string Hash, Dictionary<int, int> Counts)> ReadPackageCountsAsync(
        string path, int capacity, CancellationToken cancellationToken)
    {
        var bytes = await File.ReadAllBytesAsync(path, cancellationToken);
        string csv;
        try { csv = new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF'); }
        catch (DecoderFallbackException) { throw new InvalidDataException("De invoer-CSV moet UTF-8 gebruiken."); }
        using var parser = new TextFieldParser(new StringReader(csv))
        {
            TextFieldType = FieldType.Delimited,
            HasFieldsEnclosedInQuotes = true,
            TrimWhiteSpace = false
        };
        parser.SetDelimiters(";");
        try
        {
            if (parser.EndOfData || !ExpectedHeaders.SequenceEqual(parser.ReadFields() ?? []))
                throw new InvalidDataException("De invoer-CSV heeft een ongeldige kolomindeling.");
            var counts = new Dictionary<int, int>();
            var recordNumber = 1;
            while (!parser.EndOfData)
            {
                var fields = parser.ReadFields();
                recordNumber++;
                if (fields is null || fields.Length != ExpectedHeaders.Length ||
                    !int.TryParse(fields[6].Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var count) || count < 1)
                    throw new InvalidDataException($"CSV-record {recordNumber} heeft geen geldig positief aantal pakketten.");
                if (count > capacity)
                    throw new InvalidDataException($"CSV-record {recordNumber} bevat meer pakketten dan de capaciteit.");
                counts.Add(recordNumber, count);
            }
            if (counts.Count == 0) throw new InvalidDataException("De invoer-CSV bevat geen leveringen.");
            return (Convert.ToHexString(SHA256.HashData(bytes)), counts);
        }
        catch (MalformedLineException)
        {
            throw new InvalidDataException("De invoer-CSV bevat een ongeldig record.");
        }
    }

    public static async Task<string> SaveAsync(Stream input, string inputPath, CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        int read;
        while ((read = await input.ReadAsync(chunk, cancellationToken)) > 0)
        {
            if (buffer.Length + read > 10 * 1024 * 1024)
            {
                throw new InvalidDataException("The input CSV exceeds 10 MB.");
            }
            buffer.Write(chunk, 0, read);
        }

        string csv;
        try
        {
            csv = new UTF8Encoding(false, true).GetString(buffer.ToArray()).TrimStart('\uFEFF');
        }
        catch (DecoderFallbackException)
        {
            throw new InvalidDataException("The input CSV must use UTF-8 encoding.");
        }

        using var parser = new TextFieldParser(new StringReader(csv))
        {
            TextFieldType = FieldType.Delimited,
            HasFieldsEnclosedInQuotes = true,
            TrimWhiteSpace = false
        };
        parser.SetDelimiters(";");
        try
        {
            if (parser.EndOfData || !ExpectedHeaders.SequenceEqual(parser.ReadFields() ?? []))
            {
                throw new InvalidDataException("The input CSV header does not match the required schema.");
            }
            var recordNumber = 1;
            while (!parser.EndOfData)
            {
                recordNumber++;
                var fields = parser.ReadFields();
                if (fields is null || fields.Length != ExpectedHeaders.Length)
                {
                    throw new InvalidDataException($"CSV record {recordNumber} has an incorrect number of fields.");
                }
                if (fields.Skip(2).Take(4).Any(string.IsNullOrWhiteSpace))
                {
                    throw new InvalidDataException($"CSV record {recordNumber} is missing a required address field.");
                }
            }
            if (recordNumber == 1)
            {
                throw new InvalidDataException("The input CSV must contain at least one delivery.");
            }
        }
        catch (MalformedLineException)
        {
            throw new InvalidDataException("The input CSV contains a malformed record.");
        }

        var directory = Path.GetDirectoryName(Path.GetFullPath(inputPath))!;
        var temporaryPath = Path.Combine(directory, $".input-{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllTextAsync(temporaryPath, csv, new UTF8Encoding(false), cancellationToken);
            for (var attempt = 0; attempt < 10; attempt++)
            {
                var version = DateTimeOffset.UtcNow.ToString(VersionFormat, CultureInfo.InvariantCulture);
                try
                {
                    File.Move(temporaryPath, InputPath(inputPath, version));
                    return version;
                }
                catch (IOException) when (File.Exists(InputPath(inputPath, version))) { }
            }
            throw new IOException("Could not allocate a unique timestamp for the input CSV.");
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }
}
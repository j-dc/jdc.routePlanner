using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.VisualBasic.FileIO;

namespace RoutePlanner.Review.Api;

public sealed class ReviewStore
{
    private static readonly string[] ExpectedHeaders =
    [
        "rit", "naam", "straat", "nr.", "postcode", "gemeente",
        "aantal", "bellen", "Opmerking", "opmerking", "klas"
    ];

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    private readonly string _reportPath;
    private readonly string _inputCsvPath;
    private readonly string _reviewPath;
    private readonly string _archiveDirectory;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public ReviewStore(string reportPath, string inputCsvPath, string reviewPath)
    {
        _reportPath = Path.GetFullPath(reportPath);
        _inputCsvPath = Path.GetFullPath(inputCsvPath);
        _reviewPath = Path.GetFullPath(reviewPath);
        _archiveDirectory = Path.Combine(Path.GetDirectoryName(_reviewPath)!, "archive");
    }

    public async Task<ReviewDocument> GetAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return await GetOrCreateUnderLockAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<ReviewDocument> UpdateAsync(
        int csvRecordNumber,
        ReviewDecisionRequest request,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var document = await GetOrCreateUnderLockAsync(cancellationToken);
            var recordIndex = document.Records.FindIndex(record => record.CsvRecordNumber == csvRecordNumber);
            if (recordIndex < 0)
            {
                throw new KeyNotFoundException("The CSV record number does not exist in the current geocoding report.");
            }

            var record = document.Records[recordIndex];
            ReviewRecord updatedRecord;
            if (request.Decision == ReviewDecision.Accepted)
            {
                if (string.IsNullOrWhiteSpace(request.CandidateId))
                {
                    throw new ArgumentException("Select a geocoding candidate before accepting the address.");
                }

                var candidate = record.Candidates.FirstOrDefault(item => item.CandidateId == request.CandidateId);
                if (candidate is null || !candidate.GeometryIsValid || candidate.Latitude is null || candidate.Longitude is null)
                {
                    throw new ArgumentException("The selected candidate is not present in the report or has invalid coordinates.");
                }

                updatedRecord = record with
                {
                    Decision = ReviewDecision.Accepted,
                    SelectedCandidateId = candidate.CandidateId,
                    Latitude = candidate.Latitude,
                    Longitude = candidate.Longitude,
                    Notes = request.Notes?.Trim() ?? string.Empty,
                    ReviewedAtUtc = DateTimeOffset.UtcNow
                };
            }
            else if (request.Decision == ReviewDecision.Unresolved)
            {
                if (string.IsNullOrWhiteSpace(request.Notes))
                {
                    throw new ArgumentException("Add a note explaining why the address remains unresolved.");
                }

                updatedRecord = record with
                {
                    Decision = ReviewDecision.Unresolved,
                    SelectedCandidateId = null,
                    Latitude = null,
                    Longitude = null,
                    Notes = request.Notes.Trim(),
                    ReviewedAtUtc = DateTimeOffset.UtcNow
                };
            }
            else
            {
                throw new ArgumentException("Decision must be 'accepted' or 'unresolved'.");
            }

            var records = document.Records.ToList();
            records[recordIndex] = updatedRecord;
            var updatedDocument = document with
            {
                UpdatedAtUtc = DateTimeOffset.UtcNow,
                Records = records
            };
            await WriteAtomicallyAsync(updatedDocument, cancellationToken);
            return updatedDocument;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<ReviewDocument> GetOrCreateUnderLockAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(_reportPath))
        {
            throw new FileNotFoundException("Run the address checker before starting geocoding review.");
        }
        if (!File.Exists(_inputCsvPath))
        {
            throw new FileNotFoundException("The configured delivery CSV is unavailable to the review API.");
        }

        var reportBytes = await File.ReadAllBytesAsync(_reportPath, cancellationToken);
        var inputBytes = await File.ReadAllBytesAsync(_inputCsvPath, cancellationToken);
        var fingerprintInput = new byte[reportBytes.Length + inputBytes.Length];
        Buffer.BlockCopy(reportBytes, 0, fingerprintInput, 0, reportBytes.Length);
        Buffer.BlockCopy(inputBytes, 0, fingerprintInput, reportBytes.Length, inputBytes.Length);
        var fingerprint = Convert.ToHexString(SHA256.HashData(fingerprintInput));

        var report = JsonSerializer.Deserialize<AddressCheckReport>(reportBytes, JsonOptions)
            ?? throw new InvalidDataException("The geocoding report is empty or invalid.");
        var csvAddresses = ReadCsvAddresses(_inputCsvPath);
        ValidateReport(report, csvAddresses);

        if (File.Exists(_reviewPath))
        {
            var existingBytes = await File.ReadAllBytesAsync(_reviewPath, cancellationToken);
            var existing = JsonSerializer.Deserialize<ReviewDocument>(existingBytes, JsonOptions);
            if (existing?.SourceFingerprint == fingerprint)
            {
                return existing;
            }

            Directory.CreateDirectory(_archiveDirectory);
            var archiveName = $"address-review-{DateTimeOffset.UtcNow:yyyyMMddTHHmmssfffZ}-{Guid.NewGuid():N}.json";
            File.Move(_reviewPath, Path.Combine(_archiveDirectory, archiveName));
        }

        var now = DateTimeOffset.UtcNow;
        var records = report.Results.Select(result => CreateReviewRecord(result, csvAddresses[result.CsvRecordNumber])).ToList();
        var document = new ReviewDocument
        {
            SourceFingerprint = fingerprint,
            SourceReportCreatedAtUtc = report.CreatedAtUtc,
            CreatedAtUtc = now,
            UpdatedAtUtc = now,
            TotalRecords = report.TotalRecords,
            Records = records
        };

        await WriteAtomicallyAsync(document, cancellationToken);
        return document;
    }

    private static ReviewRecord CreateReviewRecord(AddressCheckResult result, CsvAddress csvAddress)
    {
        var address = result.Address ?? csvAddress.Address;
        var decision = ReviewDecision.Pending;
        var selectedCandidateId = (string?)null;
        double? latitude = null;
        double? longitude = null;

        if (result.Status == "valid" && result.Latitude is not null && result.Longitude is not null)
        {
            var candidate = result.Candidates.FirstOrDefault(item =>
                item.GeometryIsValid &&
                item.Latitude == result.Latitude &&
                item.Longitude == result.Longitude);
            if (candidate is not null)
            {
                decision = ReviewDecision.AutoAccepted;
                selectedCandidateId = candidate.CandidateId;
                latitude = candidate.Latitude;
                longitude = candidate.Longitude;
            }
        }

        return new ReviewRecord
        {
            CsvRecordNumber = result.CsvRecordNumber,
            Rit = string.IsNullOrWhiteSpace(result.Rit) ? csvAddress.Rit : result.Rit,
            Address = address,
            GeocodingStatus = result.Status,
            GeocodingReason = result.Reason,
            Candidates = result.Candidates,
            Decision = decision,
            SelectedCandidateId = selectedCandidateId,
            Latitude = latitude,
            Longitude = longitude
        };
    }

    private static Dictionary<int, CsvAddress> ReadCsvAddresses(string path)
    {
        using var parser = new TextFieldParser(path)
        {
            TextFieldType = FieldType.Delimited,
            HasFieldsEnclosedInQuotes = true,
            TrimWhiteSpace = false
        };
        parser.SetDelimiters(";");

        if (parser.EndOfData)
        {
            throw new InvalidDataException("The configured delivery CSV is empty.");
        }

        var headers = parser.ReadFields();
        if (headers is null || !headers.SequenceEqual(ExpectedHeaders, StringComparer.Ordinal))
        {
            throw new InvalidDataException("The configured delivery CSV does not match the required schema.");
        }

        var rows = new Dictionary<int, CsvAddress>();
        var recordNumber = 1;
        while (!parser.EndOfData)
        {
            var fields = parser.ReadFields();
            recordNumber++;
            fields ??= [];

            rows[recordNumber] = new CsvAddress(
                fields.Length > 0 ? fields[0].Trim() : string.Empty,
                new ReviewAddress
                {
                    Street = fields.Length > 2 ? fields[2].Trim() : string.Empty,
                    HouseNumber = fields.Length > 3 ? fields[3].Trim() : string.Empty,
                    Postcode = fields.Length > 4 ? fields[4].Trim() : string.Empty,
                    Municipality = fields.Length > 5 ? fields[5].Trim() : string.Empty
                });
        }

        return rows;
    }

    private static void ValidateReport(AddressCheckReport report, Dictionary<int, CsvAddress> csvAddresses)
    {
        if (report.Results.Count != report.TotalRecords)
        {
            throw new InvalidDataException("The geocoding report record count is inconsistent.");
        }

        var recordNumbers = new HashSet<int>();
        foreach (var result in report.Results)
        {
            if (result.CsvRecordNumber < 2 || !recordNumbers.Add(result.CsvRecordNumber) || !csvAddresses.ContainsKey(result.CsvRecordNumber))
            {
                throw new InvalidDataException("The geocoding report contains a missing or duplicate CSV record reference.");
            }
        }
    }

    private async Task WriteAtomicallyAsync(ReviewDocument document, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_reviewPath)!);
        var temporaryPath = $"{_reviewPath}.{Guid.NewGuid():N}.tmp";
        try
        {
            await File.WriteAllTextAsync(temporaryPath, JsonSerializer.Serialize(document, JsonOptions), cancellationToken);
            File.Move(temporaryPath, _reviewPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    private sealed record CsvAddress(string Rit, ReviewAddress Address);
}
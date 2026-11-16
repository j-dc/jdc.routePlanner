namespace RoutePlanner.Review.Api;

public sealed record AddressCheckReport
{
    public DateTimeOffset CreatedAtUtc { get; init; }
    public int TotalRecords { get; init; }
    public List<AddressCheckResult> Results { get; init; } = [];
}

public sealed record AddressCheckResult
{
    public int CsvRecordNumber { get; init; }
    public string Rit { get; init; } = string.Empty;
    public ReviewAddress? Address { get; init; }
    public string Status { get; init; } = string.Empty;
    public string Reason { get; init; } = string.Empty;
    public int CandidateCount { get; init; }
    public List<GeocodingCandidate> Candidates { get; init; } = [];
    public double? Latitude { get; init; }
    public double? Longitude { get; init; }
}

public sealed record ReviewAddress
{
    public string Street { get; init; } = string.Empty;
    public string HouseNumber { get; init; } = string.Empty;
    public string Postcode { get; init; } = string.Empty;
    public string Municipality { get; init; } = string.Empty;
}

public sealed record GeocodingCandidate
{
    public string CandidateId { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public string Street { get; init; } = string.Empty;
    public string HouseNumber { get; init; } = string.Empty;
    public string Postcode { get; init; } = string.Empty;
    public string Municipality { get; init; } = string.Empty;
    public string CountryCode { get; init; } = string.Empty;
    public string[] MatchedFields { get; init; } = [];
    public int MatchedFieldCount { get; init; }
    public bool IsExactAddressMatch { get; init; }
    public bool IsStrongAddressMatch { get; init; }
    public string MunicipalityMatchState { get; init; } = string.Empty;
    public bool GeometryIsValid { get; init; }
    public double? Longitude { get; init; }
    public double? Latitude { get; init; }
}

public sealed record ReviewDocument
{
    public int SchemaVersion { get; init; } = 1;
    public string SourceFingerprint { get; init; } = string.Empty;
    public DateTimeOffset SourceReportCreatedAtUtc { get; init; }
    public DateTimeOffset CreatedAtUtc { get; init; }
    public DateTimeOffset UpdatedAtUtc { get; init; }
    public int TotalRecords { get; init; }
    public List<ReviewRecord> Records { get; init; } = [];
    public int PendingCount => Records.Count(record => record.Decision == ReviewDecision.Pending);
    public int AcceptedCount => Records.Count(record => record.Decision is ReviewDecision.AutoAccepted or ReviewDecision.Accepted);
    public int UnresolvedCount => Records.Count(record => record.Decision == ReviewDecision.Unresolved);
    public bool ReadyForNextStep => TotalRecords > 0 && AcceptedCount == TotalRecords;
}

public sealed record ReviewRecord
{
    public int CsvRecordNumber { get; init; }
    public string Rit { get; init; } = string.Empty;
    public ReviewAddress Address { get; init; } = new();
    public string GeocodingStatus { get; init; } = string.Empty;
    public string GeocodingReason { get; init; } = string.Empty;
    public List<GeocodingCandidate> Candidates { get; init; } = [];
    public string Decision { get; init; } = ReviewDecision.Pending;
    public string? SelectedCandidateId { get; init; }
    public double? Latitude { get; init; }
    public double? Longitude { get; init; }
    public string Notes { get; init; } = string.Empty;
    public DateTimeOffset? ReviewedAtUtc { get; init; }
}

public sealed record ReviewDecisionRequest
{
    public string Decision { get; init; } = string.Empty;
    public string? CandidateId { get; init; }
    public string? Notes { get; init; }
}

public static class ReviewDecision
{
    public const string Pending = "pending";
    public const string AutoAccepted = "auto_accepted";
    public const string Accepted = "accepted";
    public const string Unresolved = "unresolved";
}
using System.Text.Json;
using RoutePlanner.Api;

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
builder.Services.AddSingleton(new HttpClient { Timeout = TimeSpan.FromSeconds(15) });
builder.Services.AddSingleton(serviceProvider => new ReviewStore(
    reportPath,
    inputCsvPath,
    reviewPath,
    serviceProvider.GetRequiredService<HttpClient>(),
    photonApiBaseUrl));

var app = builder.Build();
app.UseCors("routeplanner-ui");

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

app.MapGet("/api/review", async (ReviewStore store, CancellationToken cancellationToken) =>
{
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

app.MapPost("/api/review/{csvRecordNumber:int}/search", async (
    int csvRecordNumber,
    PhotonSearchRequest request,
    ReviewStore store,
    CancellationToken cancellationToken) =>
{
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

app.MapPut("/api/review/{csvRecordNumber:int}", async (
    int csvRecordNumber,
    ReviewDecisionRequest request,
    ReviewStore store,
    CancellationToken cancellationToken) =>
{
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
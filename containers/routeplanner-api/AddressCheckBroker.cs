using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace RoutePlanner.Api;

public static class AddressCheckBroker
{
    private const string ContainerName = "jdc-route-planner-check-addresses-1";
    private const string GeometryContainerName = "jdc-route-planner-extract-osm-geometry-1";
    private const string JobFile = "/jobs/version";
    private const string GeometryJobFile = "/jobs/geometry.json";
    private const string GeometryRequestFile = "/jobs/geometry-request.json";
    private static readonly SemaphoreSlim Gate = new(1, 1);

    public static async Task RunAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://0.0.0.0:8081");
        var app = builder.Build();
        using var docker = CreateDockerClient();

        app.MapGet("/health", () => Results.Ok());
        app.MapGet("/status/{version}", async (string version, CancellationToken cancellationToken) =>
        {
            if (!InputCsvStore.IsVersion(version)) return Results.NotFound();
            await Gate.WaitAsync(cancellationToken);
            try
            {
                var container = await InspectAsync(docker, ContainerName, "check-addresses", cancellationToken);
                var geometry = await InspectAsync(docker, GeometryContainerName, "extract-osm-geometry", cancellationToken);
                var selectedVersion = File.Exists(JobFile) ? await File.ReadAllTextAsync(JobFile, cancellationToken) : "";
                var state = await GetStateAsync(container, geometry, selectedVersion, cancellationToken);
                if (selectedVersion != version) return Results.Ok(new { state = state == "running" ? "busy" : "idle" });
                return Results.Ok(new { state });
            }
            catch (Exception exception) when (exception is HttpRequestException or IOException or JsonException or InvalidDataException or SocketException or UnauthorizedAccessException or TaskCanceledException)
            {
                return Results.Problem("The address-check container or Docker daemon is unavailable.", statusCode: 503);
            }
            finally
            {
                Gate.Release();
            }
        });

        app.MapPost("/start/{version}", async (string version, CancellationToken cancellationToken) =>
        {
            if (!InputCsvStore.IsVersion(version)) return Results.NotFound();
            await Gate.WaitAsync(cancellationToken);
            try
            {
                var container = await InspectAsync(docker, ContainerName, "check-addresses", cancellationToken);
                var geometry = await InspectAsync(docker, GeometryContainerName, "extract-osm-geometry", cancellationToken);
                var selectedVersion = File.Exists(JobFile) ? await File.ReadAllTextAsync(JobFile, cancellationToken) : "";
                if (await GetStateAsync(container, geometry, selectedVersion, cancellationToken) == "running")
                    return Results.Conflict(new { detail = "An address check is already running." });
                var temporaryPath = $"{JobFile}.{Guid.NewGuid():N}.tmp";
                try
                {
                    await File.WriteAllTextAsync(temporaryPath, version, cancellationToken);
                    File.Move(temporaryPath, JobFile, true);
                }
                finally
                {
                    if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
                }
                await WriteAtomicallyAsync(GeometryRequestFile, new GeometryRequest(version, container.StartedAt), cancellationToken);
                using var response = await docker.PostAsync($"/containers/{container.Id}/start", null, cancellationToken);
                response.EnsureSuccessStatusCode();
                return Results.Accepted(value: new { state = "running" });
            }
            catch (Exception exception) when (exception is HttpRequestException or IOException or JsonException or InvalidDataException or SocketException or UnauthorizedAccessException or TaskCanceledException)
            {
                return Results.Problem("The address-check container could not be started.", statusCode: 503);
            }
            finally
            {
                Gate.Release();
            }
        });
        var monitor = MonitorAsync(docker, app.Lifetime.ApplicationStopping);
        await app.RunAsync();
        await monitor;
    }

    private static HttpClient CreateDockerClient()
    {
        var handler = new SocketsHttpHandler
        {
            ConnectCallback = async (_, cancellationToken) =>
            {
                var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                try
                {
                    await socket.ConnectAsync(new UnixDomainSocketEndPoint("/var/run/docker.sock"), cancellationToken);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch
                {
                    socket.Dispose();
                    throw;
                }
            }
        };
        return new HttpClient(handler) { BaseAddress = new Uri("http://docker"), Timeout = TimeSpan.FromSeconds(10) };
    }

    private static async Task MonitorAsync(HttpClient docker, CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        try
        {
            while (await timer.WaitForNextTickAsync(cancellationToken))
            {
                await Gate.WaitAsync(cancellationToken);
                try
                {
                    var check = await InspectAsync(docker, ContainerName, "check-addresses", cancellationToken);
                    if (!check.Started || check.ExitCode is not (0 or 2) || !File.Exists(JobFile)) continue;
                    var version = await File.ReadAllTextAsync(JobFile, cancellationToken);
                    if (!InputCsvStore.IsVersion(version)) continue;
                    var request = await ReadGeometryRequestAsync(cancellationToken);
                    if (request?.Version != version || request.PreviousCheckStartedAt == check.StartedAt) continue;
                    var geometry = await InspectAsync(docker, GeometryContainerName, "extract-osm-geometry", cancellationToken);
                    var job = await ReadGeometryJobAsync(cancellationToken);
                    if (geometry.Running || (job?.Version == version && job.CheckStartedAt == check.StartedAt)) continue;
                    await WriteAtomicallyAsync(GeometryJobFile, new GeometryJob(version, check.StartedAt, geometry.StartedAt), cancellationToken);
                    using var response = await docker.PostAsync($"/containers/{geometry.Id}/start", null, cancellationToken);
                    response.EnsureSuccessStatusCode();
                }
                catch (Exception exception) when (exception is HttpRequestException or IOException or JsonException or InvalidDataException or SocketException or UnauthorizedAccessException or TaskCanceledException)
                {
                }
                finally
                {
                    Gate.Release();
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private static async Task<string> GetStateAsync(ContainerState check, ContainerState geometry, string version, CancellationToken cancellationToken)
    {
        if (check.Running || geometry.Running) return "running";
        if (!check.Started) return "idle";
        if (check.ExitCode is not (0 or 2)) return "failed";
        var request = await ReadGeometryRequestAsync(cancellationToken);
        if (request?.Version != version) return "completed";
        if (request.PreviousCheckStartedAt == check.StartedAt) return "failed";
        var job = await ReadGeometryJobAsync(cancellationToken);
        if (job?.Version != version || job.CheckStartedAt != check.StartedAt) return "running";
        if (geometry.StartedAt == job.PreviousGeometryStartedAt) return "failed";
        return geometry.Started && geometry.ExitCode == 0 ? "completed" : "failed";
    }

    private static async Task<GeometryJob?> ReadGeometryJobAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(GeometryJobFile)) return null;
        return JsonSerializer.Deserialize<GeometryJob>(await File.ReadAllTextAsync(GeometryJobFile, cancellationToken));
    }

    private static async Task<GeometryRequest?> ReadGeometryRequestAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(GeometryRequestFile)) return null;
        return JsonSerializer.Deserialize<GeometryRequest>(await File.ReadAllTextAsync(GeometryRequestFile, cancellationToken));
    }

    private static async Task WriteAtomicallyAsync<T>(string path, T value, CancellationToken cancellationToken)
    {
        var temporaryPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            await File.WriteAllTextAsync(temporaryPath, JsonSerializer.Serialize(value), cancellationToken);
            File.Move(temporaryPath, path, true);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }

    private static async Task<ContainerState> InspectAsync(HttpClient docker, string name, string service, CancellationToken cancellationToken)
    {
        using var ping = await docker.GetAsync("/_ping", cancellationToken);
        ping.EnsureSuccessStatusCode();
        using var response = await docker.GetAsync($"/containers/{name}/json", cancellationToken);
        response.EnsureSuccessStatusCode();
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        var root = document.RootElement;
        var labels = root.GetProperty("Config").GetProperty("Labels");
        if (labels.GetProperty("com.docker.compose.project").GetString() != "jdc-route-planner" ||
            labels.GetProperty("com.docker.compose.service").GetString() != service)
        {
            throw new InvalidDataException("The configured container is not the expected Compose service.");
        }
        var state = root.GetProperty("State");
        return new ContainerState(root.GetProperty("Id").GetString()!, state.GetProperty("Running").GetBoolean(),
            state.GetProperty("Status").GetString() == "exited", state.GetProperty("ExitCode").GetInt32(),
            state.GetProperty("StartedAt").GetString() ?? "");
    }

    private sealed record ContainerState(string Id, bool Running, bool Started, int ExitCode, string StartedAt);
    private sealed record GeometryJob(string Version, string CheckStartedAt, string PreviousGeometryStartedAt);
    private sealed record GeometryRequest(string Version, string PreviousCheckStartedAt);
}
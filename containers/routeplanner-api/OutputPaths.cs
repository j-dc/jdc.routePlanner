namespace RoutePlanner.Api;

public static class OutputPaths
{
    public static string VersionDirectory(string outputDirectory, string version) =>
        Path.Combine(outputDirectory, version);

    public static string FilePath(string outputDirectory, string version, string fileName) =>
        Path.Combine(VersionDirectory(outputDirectory, version), fileName);
}

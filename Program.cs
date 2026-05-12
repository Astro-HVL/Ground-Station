using System;
using System.Globalization;
using System.IO;
using System.IO.Ports;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.Hosting;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSignalR();

var app = builder.Build();
app.MapHub<TelemetryHub>("/telemetry");

var contentTypeProvider = new FileExtensionContentTypeProvider();
contentTypeProvider.Mappings[".glb"] = "model/gltf-binary";
contentTypeProvider.Mappings[".gltf"] = "model/gltf+json";

app.MapWhen(ctx => !ctx.Request.Path.StartsWithSegments("/telemetry"), branch =>
{
    branch.UseDefaultFiles();
    branch.UseStaticFiles(new StaticFileOptions
    {
        ContentTypeProvider = contentTypeProvider,
        OnPrepareResponse = ctx =>
        {
            ctx.Context.Response.Headers["Cache-Control"] = "no-cache, no-store";
            ctx.Context.Response.Headers["Pragma"] = "no-cache";
        }
    });
});

var cts = new CancellationTokenSource();
var configuredPort = Environment.GetEnvironmentVariable("TELEM_PORT");
var isPortPinned = !string.IsNullOrWhiteSpace(configuredPort);
var portName = configuredPort;

if (isPortPinned && !IsTelemetryPortName(portName!))
{
    Console.WriteLine($"Ignoring unsupported TELEM_PORT '{portName}'. Falling back to auto-detect.");
    isPortPinned = false;
    portName = null;
}

if (!isPortPinned)
{
    portName = ResolveDefaultPort();
    if (string.IsNullOrWhiteSpace(portName))
    {
        Console.WriteLine("TELEM_PORT not set. No telemetry serial port detected yet; waiting for device.");
        LogAvailablePorts();
    }
    else
    {
        Console.WriteLine($"TELEM_PORT not set. Using serial port: {portName}");
    }
}
else
{
    Console.WriteLine($"Using TELEM_PORT from environment: {portName}");
}

var baud = int.TryParse(Environment.GetEnvironmentVariable("TELEM_BAUD"), out var b) ? b : 115200;

var hub = app.Services.GetRequiredService<IHubContext<TelemetryHub>>();
var compactTelemetryParser = new CompactTelemetryParser();
_ = Task.Run(() => SerialLoop(portName, baud, hub, cts.Token, isPortPinned));

app.Lifetime.ApplicationStopping.Register(() => cts.Cancel());
app.Run();

static string? ResolveDefaultPort()
{
    if (OperatingSystem.IsWindows())
    {
        return FindPreferredPort(SerialPort.GetPortNames(), "COM");
    }

    if (OperatingSystem.IsMacOS())
    {
        return FindPreferredPort(
            SerialPort.GetPortNames(),
            "/dev/cu.usbmodem",
            "/dev/cu.usbserial",
            "/dev/tty.usbmodem",
            "/dev/tty.usbserial");
    }

    return FindPreferredPort(SerialPort.GetPortNames(), "/dev/ttyACM", "/dev/ttyUSB");
}

static string? FindPreferredPort(IEnumerable<string> portNames, params string[] preferredPrefixes)
{
    static bool MatchesPrefix(string portName, string prefix)
    {
        if (portName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var fileName = Path.GetFileName(portName);
        var normalizedPrefix = prefix.StartsWith("/dev/", StringComparison.OrdinalIgnoreCase)
            ? prefix["/dev/".Length..]
            : prefix;
        return fileName.StartsWith(normalizedPrefix, StringComparison.OrdinalIgnoreCase);
    }

    var candidates = portNames
        .Where(p => !string.IsNullOrWhiteSpace(p))
        .Select(p => p.Trim())
        .Where(IsTelemetryPortName)
        .Distinct(StringComparer.Ordinal)
        .OrderBy(p => p, StringComparer.Ordinal)
        .ToArray();

    foreach (var prefix in preferredPrefixes)
    {
        var match = candidates.FirstOrDefault(p => MatchesPrefix(p, prefix));
        if (!string.IsNullOrWhiteSpace(match))
        {
            return match;
        }
    }

    return null;
}

static bool IsTelemetryPortName(string portName)
{
    if (string.IsNullOrWhiteSpace(portName))
    {
        return false;
    }

    var p = portName.Trim().ToLowerInvariant();
    if (OperatingSystem.IsWindows())
    {
        return p.StartsWith("com", StringComparison.Ordinal);
    }

    // Reject generic placeholders that are not real device nodes.
    if (p == "/dev/cu.usbmodem" ||
        p == "/dev/tty.usbmodem" ||
        p == "/dev/cu.usbserial" ||
        p == "/dev/tty.usbserial" ||
        p == "/dev/ttyacm" ||
        p == "/dev/ttyusb")
    {
        return false;
    }

    return p.Contains("usbmodem", StringComparison.Ordinal) ||
           p.Contains("usbserial", StringComparison.Ordinal) ||
           p.Contains("ttyacm", StringComparison.Ordinal) ||
           p.Contains("ttyusb", StringComparison.Ordinal);
}

static void LogAvailablePorts()
{
    try
    {
        var ports = SerialPort.GetPortNames();
        Array.Sort(ports, StringComparer.Ordinal);
        if (ports.Length == 0)
        {
            Console.WriteLine("Available serial ports: (none)");
            return;
        }

        var telemetryPorts = ports.Where(IsTelemetryPortName).ToArray();
        if (telemetryPorts.Length > 0)
        {
            Console.WriteLine($"Available telemetry ports: {string.Join(", ", telemetryPorts)}");
        }
        else
        {
            Console.WriteLine("Available telemetry ports: (none)");
        }

        Console.WriteLine($"All serial ports: {string.Join(", ", ports)}");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Could not list serial ports: {ex.Message}");
    }
}

async Task SerialLoop(string? port, int baudrate, IHubContext<TelemetryHub> hubContext, CancellationToken token, bool isPortPinned)
{
    var currentPort = port;

    while (!token.IsCancellationRequested)
    {
        if (!isPortPinned)
        {
            var discoveredPort = ResolveDefaultPort();
            if (!string.Equals(discoveredPort, currentPort, StringComparison.Ordinal))
            {
                currentPort = discoveredPort;
                Console.WriteLine($"Auto-selected serial port: {currentPort}");
            }
        }

        if (string.IsNullOrWhiteSpace(currentPort))
        {
            Console.WriteLine("Waiting for telemetry serial port...");
            LogAvailablePorts();
            await DelayWithCancellation(TimeSpan.FromSeconds(2), token);
            continue;
        }

        if (!IsTelemetryPortName(currentPort))
        {
            Console.WriteLine($"Skipping unsupported serial port: {currentPort}");
            LogAvailablePorts();
            await DelayWithCancellation(TimeSpan.FromSeconds(2), token);
            continue;
        }

        try
        {
            using var serial = new SerialPort(currentPort, baudrate, Parity.None, 8, StopBits.One)
            {
                ReadTimeout = 1000,
                NewLine = "\n",
                Encoding = Encoding.ASCII
            };

            serial.Open();
            Console.WriteLine($"Opened serial {currentPort} @ {baudrate}");

            await ReadSerialAsync(serial, hubContext, token);
        }
        catch (OperationCanceledException)
        {
            break;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Serial error on {currentPort}: {ex.Message}");
            if (!isPortPinned)
            {
                LogAvailablePorts();
                currentPort = null;
            }
            await DelayWithCancellation(TimeSpan.FromSeconds(2), token);
        }
    }
}

async Task ReadSerialAsync(SerialPort serial, IHubContext<TelemetryHub> hubContext, CancellationToken token)
{
    using var reader = new StreamReader(serial.BaseStream, Encoding.ASCII, leaveOpen: true);

    while (!token.IsCancellationRequested)
    {
        string? line;
        try
        {
            line = await reader.ReadLineAsync().WaitAsync(token);
        }
        catch (OperationCanceledException)
        {
            break;
        }
        catch (TimeoutException)
        {
            continue;
        }

        if (line is null)
        {
            break;
        }

        line = line.Trim();
        if (line.Length == 0)
        {
            continue;
        }

        try
        {
            var payload = ParsePayload(line);
            await hubContext.Clients.All.SendAsync("telemetry", payload, token);
            Console.WriteLine($"RX: {line}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Data parse error: {ex.Message}");
        }
    }
}

static async Task DelayWithCancellation(TimeSpan delay, CancellationToken token)
{
    try
    {
        await Task.Delay(delay, token);
    }
    catch (OperationCanceledException)
    {
        // suppressed
    }
}

object ParsePayload(string line)
{
    if (line.StartsWith("{", StringComparison.Ordinal) && line.EndsWith("}", StringComparison.Ordinal))
    {
        try
        {
            var json = JsonSerializer.Deserialize<JsonElement>(line);
            return new { type = "json", data = json };
        }
        catch
        {
            return new { type = "raw", raw = line };
        }
    }

    if (TryParseFullTelemetry(line, out var fullTelemetry))
    {
        return fullTelemetry;
    }

    if (compactTelemetryParser.TryParse(line) is { } compactTelemetry)
    {
        return compactTelemetry;
    }

    return new { type = "raw", raw = line };
}

static bool TryParseFullTelemetry(string line, out object payload)
{
    var parts = line.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    if (parts.Length < 15)
    {
        payload = null!;
        return false;
    }

    bool TryParseDouble(string value, out double result) =>
        double.TryParse(value, NumberStyles.Any, CultureInfo.InvariantCulture, out result);

    bool TryParseInt(string value, out int result) =>
        int.TryParse(value, NumberStyles.Any, CultureInfo.InvariantCulture, out result);

    double NormalizeTime(double raw) => raw switch
    {
        > 1_000_000_000 => raw / 1_000_000_000d,
        > 1_000_000 => raw / 1_000_000d,
        > 1_000 => raw / 1_000d,
        < -1_000_000_000 => raw / 1_000_000_000d,
        < -1_000_000 => raw / 1_000_000d,
        < -1_000 => raw / 1_000d,
        _ => raw
    };

    if (!TryParseDouble(parts[0], out var tRaw) ||
        !TryParseDouble(parts[2], out var ax) ||
        !TryParseDouble(parts[3], out var ay) ||
        !TryParseDouble(parts[4], out var az) ||
        !TryParseDouble(parts[5], out var pitch) ||
        !TryParseDouble(parts[6], out var roll) ||
        !TryParseDouble(parts[7], out var yaw) ||
        !TryParseDouble(parts[8], out var temp) ||
        !TryParseDouble(parts[9], out var vel) ||
        !TryParseDouble(parts[10], out var press) ||
        !TryParseDouble(parts[11], out var lat) ||
        !TryParseDouble(parts[12], out var lon) ||
        !TryParseDouble(parts[13], out var alt) ||
        !TryParseInt(parts[14], out var state))
    {
        payload = null!;
        return false;
    }
    var tSeconds = NormalizeTime(tRaw);

    int? seq = TryParseInt(parts[1], out var seqParsed) ? seqParsed : null;
    double? east = parts.Length > 15 && TryParseDouble(parts[15], out var eastParsed) ? eastParsed : null;
    double? north = parts.Length > 16 && TryParseDouble(parts[16], out var northParsed) ? northParsed : null;
    double? up = parts.Length > 17 && TryParseDouble(parts[17], out var upParsed) ? upParsed : null;

    payload = new
    {
        type = "telemetry",
        t = tSeconds,
        seq,
        seqRaw = parts[1],
        ax,
        ay,
        az,
        pitch,
        roll,
        yaw,
        temp,
        vel,
        press,
        lat,
        lon,
        alt,
        state,
        east,
        north,
        up
    };

    return true;
}

public class TelemetryHub : Hub { }

sealed class CompactTelemetryParser
{
    private const double MaxQuaternionComponent = 1.05d;

    private DateTimeOffset? _lastObservedAtUtc;
    private double? _lastExplicitTimeSeconds;
    private double? _lastTelemetryTimeSeconds;
    private double _elapsedSeconds;
    private double? _lastAltitude;
    private double? _lastVelocity;
    private int _syntheticSequence;
    private int? _lastRssi;
    private Dictionary<string, string>? _verboseFields;

    public object? TryParse(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return null;
        }

        if (TryParseRssi(line, out var rssi))
        {
            _lastRssi = rssi;
            return null;
        }

        var cleaned = StripPrefixes(line);
        if (string.IsNullOrWhiteSpace(cleaned))
        {
            return null;
        }

        if (TryParseVerboseTelemetryLine(cleaned) is { } verboseTelemetry)
        {
            return verboseTelemetry;
        }

        if (TryParseLabeledPayload(cleaned) is { } labeledTelemetry)
        {
            return labeledTelemetry;
        }

        cleaned = ExtractInlineRssi(cleaned);
        var parts = cleaned.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length >= 16)
        {
            return TryParseExtendedRx(parts);
        }

        if (parts.Length >= 9)
        {
            return TryParseNineFieldPayload(parts, seqHint: null);
        }

        return null;
    }

    private string ExtractInlineRssi(string line)
    {
        var pipeIndex = line.IndexOf('|', StringComparison.Ordinal);
        if (pipeIndex < 0)
        {
            return line;
        }

        var payload = line[..pipeIndex].Trim();
        foreach (var segment in line[(pipeIndex + 1)..].Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (TryParseRssi(segment, out var rssi))
            {
                _lastRssi = rssi;
            }
        }

        return payload;
    }

    private Dictionary<string, object?>? TryParseVerboseTelemetryLine(string line)
    {
        if (line.StartsWith("------ TELEMETRY", StringComparison.OrdinalIgnoreCase))
        {
            _verboseFields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            return null;
        }

        var separatorIndex = line.IndexOf(':', StringComparison.Ordinal);
        if (separatorIndex <= 0 || separatorIndex >= line.Length - 1)
        {
            return null;
        }

        var key = line[..separatorIndex].Trim();
        var value = line[(separatorIndex + 1)..].Trim();
        if (!IsVerboseTelemetryKey(key))
        {
            return null;
        }

        _verboseFields ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        _verboseFields[key] = value;

        if (!key.Equals("RSSI", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var payload = TryBuildVerboseTelemetry(_verboseFields);
        _verboseFields = null;
        return payload;
    }

    private Dictionary<string, object?>? TryBuildVerboseTelemetry(IReadOnlyDictionary<string, string> fields)
    {
        if (!fields.TryGetValue("Packet", out var packetValue) ||
            !fields.TryGetValue("Time", out var timeValue) ||
            !fields.TryGetValue("ACC X/Y/Z", out var accelValue) ||
            !fields.TryGetValue("Altitude", out var altitudeValue) ||
            !TryParseInt(packetValue, out var seq) ||
            !TryParseLeadingDouble(timeValue, out var explicitTime) ||
            !TryParsePipeVector3(accelValue, out var axMetersPerSecondSquared, out var ayMetersPerSecondSquared, out var azMetersPerSecondSquared) ||
            !TryParseLeadingDouble(altitudeValue, out var alt))
        {
            return null;
        }

        var t = ResolveSampleTime(explicitTime);
        var vel = ResolveVelocity(t, alt);

        const double metersPerSecondSquaredPerG = 9.81d;
        var ax = axMetersPerSecondSquared / metersPerSecondSquaredPerG;
        var ay = ayMetersPerSecondSquared / metersPerSecondSquaredPerG;
        var az = azMetersPerSecondSquared / metersPerSecondSquaredPerG;

        double gx = 0d;
        double gy = 0d;
        double gz = 0d;
        double mx = 0d;
        double my = 0d;
        double mz = 0d;
        var hasGyro = fields.TryGetValue("GYRO X/Y/Z", out var gyroValue) &&
                      TryParsePipeVector3(gyroValue, out gx, out gy, out gz);
        var hasMag = fields.TryGetValue("MAG X/Y/Z", out var magValue) &&
                     TryParsePipeVector3(magValue, out mx, out my, out mz);

        var (pitch, roll) = AccelerationToPitchRollDegrees(ax, ay, az);
        var yaw = hasMag ? MagnetometerToYawDegrees(mx, my) : (hasGyro ? gz : 0d);

        if (fields.TryGetValue("RSSI", out var rssiValue) && TryParseLeadingDouble(rssiValue, out var rssiRaw))
        {
            _lastRssi = (int)Math.Round(rssiRaw, MidpointRounding.AwayFromZero);
        }

        var sensorStatus = fields.TryGetValue("ICM", out var statusValue)
            ? statusValue
            : null;

        return BuildTelemetryPayload(
            t,
            seq,
            ax,
            ay,
            az,
            pitch,
            roll,
            yaw,
            state: 0,
            alt,
            vel,
            extras: new Dictionary<string, object?>
            {
                ["temp"] = fields.TryGetValue("Temp", out var tempValue) && TryParseLeadingDouble(tempValue, out var temp) ? temp : null,
                ["press"] = fields.TryGetValue("Pressure", out var pressValue) && TryParseLeadingDouble(pressValue, out var press) ? press : null,
                ["gx"] = hasGyro ? gx : null,
                ["gy"] = hasGyro ? gy : null,
                ["gz"] = hasGyro ? gz : null,
                ["mx"] = hasMag ? mx : null,
                ["my"] = hasMag ? my : null,
                ["mz"] = hasMag ? mz : null,
                ["accUnit"] = "g",
                ["sensorStatus"] = sensorStatus
            });
    }

    private Dictionary<string, object?>? TryParseLabeledPayload(string line)
    {
        if (!line.Contains('|', StringComparison.Ordinal) ||
            !line.Contains(':', StringComparison.Ordinal))
        {
            return null;
        }

        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var segment in line.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var separatorIndex = segment.IndexOf(':', StringComparison.Ordinal);
            if (separatorIndex <= 0 || separatorIndex >= segment.Length - 1)
            {
                continue;
            }

            var key = segment[..separatorIndex].Trim();
            var value = segment[(separatorIndex + 1)..].Trim();
            if (key.Length > 0 && value.Length > 0)
            {
                fields[key] = value;
            }
        }

        if (!fields.TryGetValue("PKT", out var packetValue) ||
            !fields.TryGetValue("A", out var accelValue) ||
            !fields.TryGetValue("ALT", out var altitudeValue) ||
            !TryParseInt(packetValue, out var seq) ||
            !TryParseVector3(accelValue, out var ax, out var ay, out var az) ||
            !TryParseDouble(altitudeValue, out var alt))
        {
            return null;
        }

        var t = fields.TryGetValue("t", out var timeValue) && TryParseDouble(timeValue, out var explicitTime)
            ? ResolveSampleTime(explicitTime)
            : ResolveSampleTime(explicitTimeSeconds: null);
        var vel = ResolveVelocity(t, alt);

        double gx = 0d;
        double gy = 0d;
        double gz = 0d;
        double mx = 0d;
        double my = 0d;
        double mz = 0d;
        var hasGyro = fields.TryGetValue("G", out var gyroValue) &&
                      TryParseVector3(gyroValue, out gx, out gy, out gz);
        var hasMag = fields.TryGetValue("M", out var magValue) &&
                     TryParseVector3(magValue, out mx, out my, out mz);

        var (pitch, roll) = AccelerationToPitchRollDegrees(ax, ay, az);
        var yaw = hasMag ? MagnetometerToYawDegrees(mx, my) : (hasGyro ? gz : 0d);

        if (fields.TryGetValue("RSSI", out var rssiValue) && TryParseDouble(rssiValue, out var rssiRaw))
        {
            _lastRssi = (int)Math.Round(rssiRaw, MidpointRounding.AwayFromZero);
        }

        var payload = BuildTelemetryPayload(
            t,
            seq,
            ax,
            ay,
            az,
            pitch,
            roll,
            yaw,
            state: 0,
            alt,
            vel,
            extras: new Dictionary<string, object?>
            {
                ["temp"] = fields.TryGetValue("T", out var tempValue) && TryParseDouble(tempValue, out var temp) ? temp : null,
                ["press"] = fields.TryGetValue("P", out var pressValue) && TryParseDouble(pressValue, out var press) ? press : null,
                ["gx"] = hasGyro ? gx : null,
                ["gy"] = hasGyro ? gy : null,
                ["gz"] = hasGyro ? gz : null,
                ["mx"] = hasMag ? mx : null,
                ["my"] = hasMag ? my : null,
                ["mz"] = hasMag ? mz : null,
                ["ok"] = fields.TryGetValue("OK", out var okValue) && TryParseInt(okValue, out var ok) ? ok : null
            });

        return payload;
    }

    private object? TryParseExtendedRx(string[] parts)
    {
        if (!TryParseDouble(parts[0], out var rssiRaw) ||
            !TryParseInt(parts[1], out var seq))
        {
            return null;
        }

        _lastRssi = (int)Math.Round(rssiRaw, MidpointRounding.AwayFromZero);
        var payload = parts.Skip(7).Take(9).ToArray();
        return payload.Length == 9 ? TryParseNineFieldPayload(payload, seq) : null;
    }

    private object? TryParseNineFieldPayload(string[] parts, int? seqHint)
    {
        if (parts.Length < 9)
        {
            return null;
        }

        var values = new double[9];
        for (var i = 0; i < values.Length; i++)
        {
            if (!TryParseDouble(parts[i], out values[i]))
            {
                return null;
            }
        }

        return LooksLikeQuaternion(values[5], values[6], values[7])
            ? BuildQuaternionTelemetry(values, seqHint)
            : BuildEulerTelemetry(values, seqHint);
    }

    private Dictionary<string, object?> BuildQuaternionTelemetry(double[] values, int? seqHint)
    {
        var press = values[0];
        var temp = values[1];
        var ax = values[2];
        var ay = values[3];
        var az = values[4];
        var qx = values[5];
        var qy = values[6];
        var qz = values[7];
        var state = (int)Math.Round(values[8], MidpointRounding.AwayFromZero);

        var t = ResolveSampleTime(explicitTimeSeconds: null);
        var alt = press;
        var vel = ResolveVelocity(t, alt);
        var (pitch, roll, yaw) = QuaternionToEulerDegrees(qx, qy, qz);

        return BuildTelemetryPayload(
            t,
            seqHint,
            ax,
            ay,
            az,
            pitch,
            roll,
            yaw,
            state,
            alt,
            vel,
            extras: new Dictionary<string, object?>
            {
                ["press"] = press,
                ["temp"] = temp,
                ["qx"] = qx,
                ["qy"] = qy,
                ["qz"] = qz
            });
    }

    private Dictionary<string, object?> BuildEulerTelemetry(double[] values, int? seqHint)
    {
        var t = ResolveSampleTime(explicitTimeSeconds: values[0]);
        var state = (int)Math.Round(values[1], MidpointRounding.AwayFromZero);
        var ax = values[2];
        var ay = values[3];
        var az = values[4];
        var pitch = values[5];
        var roll = values[6];
        var yaw = values[7];
        var alt = values[8];
        var vel = ResolveVelocity(t, alt);

        return BuildTelemetryPayload(t, seqHint, ax, ay, az, pitch, roll, yaw, state, alt, vel);
    }

    private Dictionary<string, object?> BuildTelemetryPayload(
        double t,
        int? seqHint,
        double ax,
        double ay,
        double az,
        double pitch,
        double roll,
        double yaw,
        int state,
        double alt,
        double? vel,
        Dictionary<string, object?>? extras = null)
    {
        var seq = seqHint ?? _syntheticSequence++;
        var payload = new Dictionary<string, object?>
        {
            ["type"] = "telemetry",
            ["t"] = t,
            ["seq"] = seq,
            ["seqRaw"] = seq.ToString(CultureInfo.InvariantCulture),
            ["ax"] = ax,
            ["ay"] = ay,
            ["az"] = az,
            ["pitch"] = pitch,
            ["roll"] = roll,
            ["yaw"] = yaw,
            ["alt"] = alt,
            ["state"] = state
        };

        if (vel.HasValue)
        {
            payload["vel"] = vel.Value;
        }

        if (_lastRssi.HasValue)
        {
            payload["rssi"] = _lastRssi.Value;
        }

        if (extras is not null)
        {
            foreach (var (key, value) in extras)
            {
                payload[key] = value;
            }
        }

        return payload;
    }

    private double ResolveSampleTime(double? explicitTimeSeconds)
    {
        var now = DateTimeOffset.UtcNow;
        var normalizedExplicit = explicitTimeSeconds.HasValue
            ? NormalizeCompactTimeValue(explicitTimeSeconds.Value)
            : (double?)null;

        if (normalizedExplicit.HasValue &&
            (!_lastExplicitTimeSeconds.HasValue || normalizedExplicit.Value > _lastExplicitTimeSeconds.Value + 1e-6))
        {
            _lastExplicitTimeSeconds = normalizedExplicit.Value;
            _elapsedSeconds = normalizedExplicit.Value;
            _lastObservedAtUtc = now;
            return _elapsedSeconds;
        }

        if (_lastObservedAtUtc.HasValue)
        {
            var deltaSeconds = (now - _lastObservedAtUtc.Value).TotalSeconds;
            if (double.IsFinite(deltaSeconds) && deltaSeconds > 0 && deltaSeconds < 5)
            {
                _elapsedSeconds += deltaSeconds;
            }
        }
        else if (normalizedExplicit.HasValue)
        {
            _elapsedSeconds = normalizedExplicit.Value;
        }

        _lastObservedAtUtc = now;
        return _elapsedSeconds;
    }

    private double? ResolveVelocity(double tSeconds, double altitude)
    {
        if (!_lastAltitude.HasValue || !_lastTelemetryTimeSeconds.HasValue)
        {
            _lastAltitude = altitude;
            _lastVelocity = 0d;
            _lastTelemetryTimeSeconds = tSeconds;
            return _lastVelocity;
        }

        var deltaT = tSeconds - _lastTelemetryTimeSeconds.Value;
        var velocity = _lastVelocity ?? 0d;
        if (double.IsFinite(deltaT) && deltaT > 1e-6)
        {
            velocity = (altitude - _lastAltitude.Value) / deltaT;
        }

        _lastAltitude = altitude;
        _lastVelocity = velocity;
        _lastTelemetryTimeSeconds = tSeconds;
        return velocity;
    }

    private static bool LooksLikeQuaternion(double qx, double qy, double qz)
    {
        if (Math.Abs(qx) > MaxQuaternionComponent ||
            Math.Abs(qy) > MaxQuaternionComponent ||
            Math.Abs(qz) > MaxQuaternionComponent)
        {
            return false;
        }

        var magSquared = qx * qx + qy * qy + qz * qz;
        return magSquared <= 1.0001d;
    }

    private static (double pitch, double roll, double yaw) QuaternionToEulerDegrees(double qx, double qy, double qz)
    {
        var qwSquared = 1d - (qx * qx + qy * qy + qz * qz);
        var qw = Math.Sqrt(Math.Max(0d, qwSquared));

        var sinrCosp = 2d * (qw * qx + qy * qz);
        var cosrCosp = 1d - 2d * (qx * qx + qy * qy);
        var roll = Math.Atan2(sinrCosp, cosrCosp);

        var sinp = 2d * (qw * qy - qz * qx);
        var pitch = Math.Abs(sinp) >= 1d
            ? Math.CopySign(Math.PI / 2d, sinp)
            : Math.Asin(sinp);

        var sinyCosp = 2d * (qw * qz + qx * qy);
        var cosyCosp = 1d - 2d * (qy * qy + qz * qz);
        var yaw = Math.Atan2(sinyCosp, cosyCosp);

        const double radToDeg = 180d / Math.PI;
        return (pitch * radToDeg, roll * radToDeg, yaw * radToDeg);
    }

    private static string StripPrefixes(string line)
    {
        var cleaned = line.Trim();
        while (true)
        {
            if (cleaned.StartsWith("Received:", StringComparison.OrdinalIgnoreCase))
            {
                cleaned = cleaned["Received:".Length..].Trim();
                continue;
            }

            if (cleaned.StartsWith("RX:", StringComparison.OrdinalIgnoreCase))
            {
                cleaned = cleaned["RX:".Length..].Trim();
                continue;
            }

            if (cleaned.StartsWith("TX:", StringComparison.OrdinalIgnoreCase))
            {
                cleaned = cleaned["TX:".Length..].Trim();
                continue;
            }

            if (cleaned.StartsWith("X:", StringComparison.OrdinalIgnoreCase))
            {
                cleaned = cleaned["X:".Length..].Trim();
                continue;
            }

            return cleaned;
        }
    }

    private static bool TryParseVector3(string value, out double x, out double y, out double z)
    {
        x = 0d;
        y = 0d;
        z = 0d;

        var parts = value.Split(',', StringSplitOptions.TrimEntries);
        return parts.Length == 3 &&
               TryParseDouble(parts[0], out x) &&
               TryParseDouble(parts[1], out y) &&
               TryParseDouble(parts[2], out z);
    }

    private static bool TryParsePipeVector3(string value, out double x, out double y, out double z)
    {
        x = 0d;
        y = 0d;
        z = 0d;

        var parts = value.Split('|', StringSplitOptions.TrimEntries);
        return parts.Length == 3 &&
               TryParseLeadingDouble(parts[0], out x) &&
               TryParseLeadingDouble(parts[1], out y) &&
               TryParseLeadingDouble(parts[2], out z);
    }

    private static bool IsVerboseTelemetryKey(string key) =>
        key.Equals("Packet", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("Time", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("ICM", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("ACC X/Y/Z", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("GYRO X/Y/Z", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("MAG X/Y/Z", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("Temp", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("Pressure", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("Altitude", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("RSSI", StringComparison.OrdinalIgnoreCase);

    private static (double pitch, double roll) AccelerationToPitchRollDegrees(double ax, double ay, double az)
    {
        const double radToDeg = 180d / Math.PI;
        var pitch = Math.Atan2(-ax, Math.Sqrt(ay * ay + az * az)) * radToDeg;
        var roll = Math.Atan2(ay, az) * radToDeg;
        return (pitch, roll);
    }

    private static double MagnetometerToYawDegrees(double mx, double my)
    {
        const double radToDeg = 180d / Math.PI;
        var yaw = Math.Atan2(my, mx) * radToDeg;
        return yaw < 0 ? yaw + 360d : yaw;
    }

    private static bool TryParseRssi(string line, out int rssi)
    {
        rssi = 0;
        var cleaned = line.Trim();
        if (!cleaned.StartsWith("RSSI:", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var value = cleaned["RSSI:".Length..].Trim();
        if (!TryParseDouble(value, out var parsed))
        {
            return false;
        }

        rssi = (int)Math.Round(parsed, MidpointRounding.AwayFromZero);
        return true;
    }

    private static bool TryParseDouble(string value, out double result) =>
        double.TryParse(value, NumberStyles.Any, CultureInfo.InvariantCulture, out result);

    private static bool TryParseInt(string value, out int result) =>
        int.TryParse(value, NumberStyles.Any, CultureInfo.InvariantCulture, out result);

    private static bool TryParseLeadingDouble(string value, out double result)
    {
        result = 0d;
        value = value.Trim();
        var length = 0;
        var hasDigit = false;

        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            var isNumericChar =
                char.IsDigit(c) ||
                c is '+' or '-' or '.' or ',' ||
                c is 'e' or 'E';

            if (!isNumericChar)
            {
                break;
            }

            if (char.IsDigit(c))
            {
                hasDigit = true;
            }

            length = i + 1;
        }

        return hasDigit &&
               double.TryParse(value[..length].Replace(',', '.'), NumberStyles.Any, CultureInfo.InvariantCulture, out result);
    }

    private static double NormalizeCompactTimeValue(double raw) => raw switch
    {
        > 1_000_000_000 => raw / 1_000_000_000d,
        > 1_000_000 => raw / 1_000_000d,
        > 1_000 => raw / 1_000d,
        < -1_000_000_000 => raw / 1_000_000_000d,
        < -1_000_000 => raw / 1_000_000d,
        < -1_000 => raw / 1_000d,
        _ => raw
    };
}

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
        ContentTypeProvider = contentTypeProvider
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

static object ParsePayload(string line)
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

    var parts = line.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    if (parts.Length < 15)
    {
        return new { type = "raw", raw = line };
    }

    bool TryParseDouble(string value, out double result) =>
        double.TryParse(value, NumberStyles.Any, CultureInfo.InvariantCulture, out result);

    bool TryParseInt(string value, out int result) =>
        int.TryParse(value, NumberStyles.Any, CultureInfo.InvariantCulture, out result);

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
        return new { type = "raw", raw = line };
    }

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

    var tSeconds = NormalizeTime(tRaw);

    int? seq = TryParseInt(parts[1], out var seqParsed) ? seqParsed : null;
    double? east = parts.Length > 15 && TryParseDouble(parts[15], out var eastParsed) ? eastParsed : null;
    double? north = parts.Length > 16 && TryParseDouble(parts[16], out var northParsed) ? northParsed : null;
    double? up = parts.Length > 17 && TryParseDouble(parts[17], out var upParsed) ? upParsed : null;

    return new
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
}

public class TelemetryHub : Hub { }

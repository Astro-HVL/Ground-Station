using System;
using System.Globalization;
using System.IO;
using System.IO.Ports;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Hosting;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSignalR();

var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapHub<TelemetryHub>("/telemetry");

var cts = new CancellationTokenSource();
var portName = Environment.GetEnvironmentVariable("TELEM_PORT") ?? (OperatingSystem.IsWindows() ? "COM4" : "/dev/ttyUSB0");
var baud = int.TryParse(Environment.GetEnvironmentVariable("TELEM_BAUD"), out var b) ? b : 115200;

var hub = app.Services.GetRequiredService<IHubContext<TelemetryHub>>();
_ = Task.Run(() => SerialLoop(portName, baud, hub, cts.Token));

app.Lifetime.ApplicationStopping.Register(() => cts.Cancel());
app.Run();

async Task SerialLoop(string port, int baudrate, IHubContext<TelemetryHub> hubContext, CancellationToken token)
{
    while (!token.IsCancellationRequested)
    {
        try
        {
            using var serial = new SerialPort(port, baudrate, Parity.None, 8, StopBits.One)
            {
                ReadTimeout = 1000,
                NewLine = "\n",
                Encoding = Encoding.ASCII
            };

            serial.Open();
            Console.WriteLine($"Opened serial {port} @ {baudrate}");

            await ReadSerialAsync(serial, hubContext, token);
        }
        catch (OperationCanceledException)
        {
            break;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Serial error: {ex.Message}");
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
        state
    };
}

public class TelemetryHub : Hub { }

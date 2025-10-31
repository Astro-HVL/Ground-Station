using System;
using System.IO.Ports;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Hosting;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSignalR();

var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapHub<TelemetryHub>("/telemetry");

var cts = new CancellationTokenSource();
var portName = Environment.GetEnvironmentVariable("TELEM_PORT") ?? (OperatingSystem.IsWindows() ? "COM5" : "/dev/ttyUSB0");
var baud = int.TryParse(Environment.GetEnvironmentVariable("TELEM_BAUD"), out var b) ? b : 115200;

var hub = app.Services.GetRequiredService<IHubContext<TelemetryHub>>();
_ = Task.Run(() => SerialLoop(portName, baud, hub, cts.Token));

app.Lifetime.ApplicationStopping.Register(() => cts.Cancel());
app.Run();

async Task SerialLoop(string port, int baudrate, IHubContext<TelemetryHub> hub, CancellationToken token)
{
    using var sp = new SerialPort(port, baudrate, Parity.None, 8, StopBits.One)
    {
        ReadTimeout = 1000,
        NewLine = "\n",
        Encoding = Encoding.ASCII
    };

    try
    {
        sp.Open();
        Console.WriteLine($"✅ Opened serial {port} @ {baudrate}");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"❌ Failed to open serial {port}: {ex.Message}");
        return;
    }

    while (!token.IsCancellationRequested)
    {
        try
        {
            string line = sp.ReadLine();
            if (string.IsNullOrWhiteSpace(line)) continue;

            line = line.Trim();
            Console.WriteLine($"RX RAW: {line}");

            object payload;

            // ---------- JSON statusmeldinger ----------
            if (line.StartsWith("{") && line.EndsWith("}"))
            {
                try
                {
                    var json = JsonSerializer.Deserialize<JsonElement>(line);
                    payload = new { type = "json", data = json };
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"JSON parse error: {ex.Message}");
                    payload = new { type = "raw", raw = line };
                }
            }

            // ---------- CSV TELEMETRI ----------
            else
            {
                var parts = line.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

                // Ignorer linjer uten state (14 felt) for å unngå å overskrive visuell status
                if (parts.Length == 14)
                    continue;

                // CSV MED state (15–16 felt)
                if (parts.Length >= 15 && parts.Length <= 16
                    && double.TryParse(parts[2], System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var ax)
                    && double.TryParse(parts[3], System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var ay)
                    && double.TryParse(parts[4], System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var az)
                    && double.TryParse(parts[5], System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var pitch)
                    && double.TryParse(parts[6], System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var roll)
                    && double.TryParse(parts[7], System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var yaw)
                    && double.TryParse(parts[8], System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var temp)
                    && double.TryParse(parts[9], System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var vel)
                    && double.TryParse(parts[10], System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var press)
                    && double.TryParse(parts[11], System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var lat)
                    && double.TryParse(parts[12], System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var lon)
                    && double.TryParse(parts[13], System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var alt)
                    && int.TryParse(parts[14], out var state))
                {
                    payload = new
                    {
                        type = "telemetry",
                        t = parts[0],
                        seq = parts[1],
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
                else
                {
                    payload = new { type = "raw", raw = line };
                }
            }

            // Send data til alle SignalR-klienter (nettlesere)
            await hub.Clients.All.SendAsync("telemetry", payload);
        }
        catch (TimeoutException)
        {
            // Normal – ingen data akkurat nå
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Serial read error: {ex.Message}");
            await Task.Delay(200, token);
        }
    }

    sp.Close();
}

public class TelemetryHub : Hub { }

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
var portName = Environment.GetEnvironmentVariable("TELEM_PORT") ?? (OperatingSystem.IsWindows() ? "COM4" : "/dev/ttyUSB0");
var baud = int.TryParse(Environment.GetEnvironmentVariable("TELEM_BAUD"), out var b) ? b : 115200;

var hub = app.Services.GetRequiredService<IHubContext<TelemetryHub>>();
_ = Task.Run(() => SerialLoop(portName, baud, hub, cts.Token));

app.Lifetime.ApplicationStopping.Register(() => cts.Cancel());
app.Run();

async Task SerialLoop(string port, int baudrate, IHubContext<TelemetryHub> hub, CancellationToken token)
{
    SerialPort? sp = null;

    while (!token.IsCancellationRequested)
    {
        try
        {
            if (sp == null || !sp.IsOpen)
            {
                sp = new SerialPort(port, baudrate, Parity.None, 8, StopBits.One)
                {
                    ReadTimeout = 1000,
                    NewLine = "\n",
                    Encoding = Encoding.ASCII
                };

                sp.Open();
                Console.WriteLine($"✅ Opened serial {port} @ {baudrate}");

                // Event-handler for data
                sp.DataReceived += async (s, e) =>
                {
                    try
                    {
                        string line = sp.ReadLine()?.Trim() ?? "";
                        if (string.IsNullOrWhiteSpace(line)) return;

                        object payload;

                        // JSON-status
                        if (line.StartsWith("{") && line.EndsWith("}"))
                        {
                            try
                            {
                                var json = JsonSerializer.Deserialize<JsonElement>(line);
                                payload = new { type = "json", data = json };
                            }
                            catch
                            {
                                payload = new { type = "raw", raw = line };
                            }
                        }
                        // CSV-telemetri
                        else
                        {
                            var p = line.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                            if (p.Length >= 15 &&
                                double.TryParse(p[2], System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var ax))
                            {
                                payload = new
                                {
                                    type = "telemetry",
                                    t = p[0], seq = p[1],
                                    ax,
                                    ay = double.Parse(p[3], System.Globalization.CultureInfo.InvariantCulture),
                                    az = double.Parse(p[4], System.Globalization.CultureInfo.InvariantCulture),
                                    pitch = double.Parse(p[5], System.Globalization.CultureInfo.InvariantCulture),
                                    roll = double.Parse(p[6], System.Globalization.CultureInfo.InvariantCulture),
                                    yaw = double.Parse(p[7], System.Globalization.CultureInfo.InvariantCulture),
                                    temp = double.Parse(p[8], System.Globalization.CultureInfo.InvariantCulture),
                                    vel = double.Parse(p[9], System.Globalization.CultureInfo.InvariantCulture),
                                    press = double.Parse(p[10], System.Globalization.CultureInfo.InvariantCulture),
                                    lat = double.Parse(p[11], System.Globalization.CultureInfo.InvariantCulture),
                                    lon = double.Parse(p[12], System.Globalization.CultureInfo.InvariantCulture),
                                    alt = double.Parse(p[13], System.Globalization.CultureInfo.InvariantCulture),
                                    state = int.Parse(p[14])
                                };
                            }
                            else payload = new { type = "raw", raw = line };
                        }

                        await hub.Clients.All.SendAsync("telemetry", payload);
                        Console.WriteLine($"RX: {line}");
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"⚠️ Data parse error: {ex.Message}");
                    }
                };
            }

            await Task.Delay(1000, token); // unngå tight loop
        }
        catch (Exception ex)
        {
            Console.WriteLine($"❌ Serial error: {ex.Message}");
            try { sp?.Close(); } catch { }
            sp = null;

            Console.WriteLine("🔁 Waiting for serial device...");
            await Task.Delay(2000, token);
        }
    }
}


public class TelemetryHub : Hub { }

using Microsoft.AspNetCore.SignalR;
using System.IO.Ports;

public class SerialTelemetryService : BackgroundService
{
    private readonly IHubContext<TelemetryHub> _hub;
    private readonly TelemetryRepository _repo;
    private readonly ILogger<SerialTelemetryService> _logger;

    // Hardcode for now, later you can make this configurable
    private const string PortName = "COM3";   // or "/dev/ttyUSB0" on Linux
    private const int BaudRate = 115200;
    private const int FlightId = 1;           // set to your active flight

    public SerialTelemetryService(
        IHubContext<TelemetryHub> hub,
        TelemetryRepository repo,
        ILogger<SerialTelemetryService> logger)
    {
        _hub    = hub;
        _repo   = repo;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var port = new SerialPort(PortName, BaudRate)
        {
            ReadTimeout  = 2000,
            WriteTimeout = 2000
        };

        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (!port.IsOpen) port.Open();

                var line = await Task.Run(() => port.ReadLine(), ct);

                if (!SerialTelemetryParser.TryParse(line, FlightId, out var packet) || packet is null)
                {
                    _logger.LogWarning("Failed to parse line: {Line}", line);
                    continue;
                }

                // Save to DB and broadcast to frontend at the same time
                await Task.WhenAll(
                    _repo.SaveAsync(packet),
                    _hub.Clients.All.SendAsync("telemetry", packet, ct)
                );
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Serial read error, retrying in 2s...");
                if (port.IsOpen) port.Close();
                await Task.Delay(2000, ct);
            }
        }

        if (port.IsOpen) port.Close();
    }
}
using System.Globalization;
using System.Text.Json;
using System.Threading.Channels;
using Npgsql;
using NpgsqlTypes;

namespace TelemetryWebApp.Db;

public sealed class TelemetryDbLogger : IAsyncDisposable
{
    private static readonly (int Id, string Name)[] FlightStates =
    {
        (1, "SYSTEM_CHECK"),
        (2, "OPERATION_READY"),
        (3, "LIFT_OFF"),
        (4, "APOGEE"),
        (5, "DROGUE_DEPLOY"),
        (6, "DROGUE_DESCENT"),
        (7, "MAIN_DEPLOY"),
        (8, "MAIN_DESCENT"),
    };

    private readonly string _connectionString;
    private readonly string _rocketName;
    private readonly string? _launchSite;
    private readonly Channel<TelemetryRow> _channel;
    private NpgsqlDataSource? _dataSource;
    private int _flightId;
    private Task? _drainTask;
    private CancellationTokenSource? _drainCts;

    public bool IsEnabled => _dataSource is not null;
    public int FlightId => _flightId;

    public TelemetryDbLogger(string connectionString, string rocketName, string? launchSite)
    {
        _connectionString = connectionString;
        _rocketName = string.IsNullOrWhiteSpace(rocketName) ? "Astro" : rocketName;
        _launchSite = string.IsNullOrWhiteSpace(launchSite) ? null : launchSite;
        _channel = Channel.CreateBounded<TelemetryRow>(new BoundedChannelOptions(10_000)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });
    }

    public async Task<bool> InitializeAsync(CancellationToken token)
    {
        try
        {
            _dataSource = NpgsqlDataSource.Create(_connectionString);

            await using (var conn = await _dataSource.OpenConnectionAsync(token))
            {
                await SeedFlightStatesAsync(conn, token);
                var rocketId = await GetOrCreateRocketAsync(conn, _rocketName, token);
                _flightId = await CreateFlightAsync(conn, rocketId, _launchSite, token);
            }

            _drainCts = new CancellationTokenSource();
            _drainTask = Task.Run(() => DrainLoopAsync(_drainCts.Token));

            Console.WriteLine($"[db] logging telemetry to flight_id={_flightId} (rocket='{_rocketName}')");
            return true;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[db] init failed, telemetry logging disabled: {ex.Message}");
            if (_dataSource is not null)
            {
                await _dataSource.DisposeAsync();
                _dataSource = null;
            }
            return false;
        }
    }

    public void Enqueue(object payload)
    {
        if (_dataSource is null) return;

        TelemetryRow? row;
        try
        {
            row = MapPayload(payload);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[db] map error: {ex.Message}");
            return;
        }

        if (row is null) return;

        _channel.Writer.TryWrite(row);
    }

    private async Task DrainLoopAsync(CancellationToken token)
    {
        var buffer = new List<TelemetryRow>(256);
        var reader = _channel.Reader;

        while (!token.IsCancellationRequested)
        {
            try
            {
                if (!await reader.WaitToReadAsync(token))
                    break;

                buffer.Clear();
                while (buffer.Count < 200 && reader.TryRead(out var row))
                    buffer.Add(row);

                if (buffer.Count == 0) continue;

                await FlushAsync(buffer, CancellationToken.None);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[db] drain error: {ex.Message}");
                await Task.Delay(500, CancellationToken.None);
            }
        }

        if (reader.TryPeek(out _))
        {
            buffer.Clear();
            while (reader.TryRead(out var row)) buffer.Add(row);
            if (buffer.Count > 0)
            {
                try { await FlushAsync(buffer, CancellationToken.None); }
                catch (Exception ex) { Console.WriteLine($"[db] final flush error: {ex.Message}"); }
            }
        }
    }

    private async Task FlushAsync(List<TelemetryRow> rows, CancellationToken token)
    {
        if (_dataSource is null || rows.Count == 0) return;

        await using var conn = await _dataSource.OpenConnectionAsync(token);
        await using var batch = new NpgsqlBatch(conn);

        foreach (var r in rows)
        {
            var cmd = new NpgsqlBatchCommand(
                "INSERT INTO telemetry (flight_id, t_ms, ax, ay, az, pitch_deg, roll_deg, yaw_deg, " +
                "temperature_c, velocity, pressure_pa, latitude_deg, longitude_deg, altitude_m, state_id) " +
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)");

            cmd.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Integer, Value = _flightId });
            cmd.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bigint, Value = r.TMs });
            cmd.Parameters.Add(Real(r.Ax));
            cmd.Parameters.Add(Real(r.Ay));
            cmd.Parameters.Add(Real(r.Az));
            cmd.Parameters.Add(Real(r.PitchDeg));
            cmd.Parameters.Add(Real(r.RollDeg));
            cmd.Parameters.Add(Real(r.YawDeg));
            cmd.Parameters.Add(Real(r.TemperatureC));
            cmd.Parameters.Add(Real(r.Velocity));
            cmd.Parameters.Add(Real(r.PressurePa));
            cmd.Parameters.Add(Double(r.LatitudeDeg));
            cmd.Parameters.Add(Double(r.LongitudeDeg));
            cmd.Parameters.Add(Real(r.AltitudeM));
            cmd.Parameters.Add(Int(r.StateId));

            batch.BatchCommands.Add(cmd);
        }

        await batch.ExecuteNonQueryAsync(token);
    }

    private static NpgsqlParameter Real(float? v) =>
        new() { NpgsqlDbType = NpgsqlDbType.Real, Value = (object?)v ?? DBNull.Value };
    private static NpgsqlParameter Double(double? v) =>
        new() { NpgsqlDbType = NpgsqlDbType.Double, Value = (object?)v ?? DBNull.Value };
    private static NpgsqlParameter Int(int? v) =>
        new() { NpgsqlDbType = NpgsqlDbType.Integer, Value = (object?)v ?? DBNull.Value };

    private static TelemetryRow? MapPayload(object payload)
    {
        var el = JsonSerializer.SerializeToElement(payload);
        if (el.ValueKind != JsonValueKind.Object) return null;

        if (!el.TryGetProperty("type", out var typeEl) ||
            typeEl.ValueKind != JsonValueKind.String ||
            typeEl.GetString() != "telemetry")
        {
            return null;
        }

        var t = TryGetDouble(el, "t");
        if (!t.HasValue) return null;
        var tMs = (long)Math.Round(t.Value * 1000.0);

        var velocity = TryGetFloat(el, "vel");
        if (velocity is < 0) velocity = null;

        var pressure = TryGetFloat(el, "press");
        if (pressure is < 0) pressure = null;

        var altitude = TryGetFloat(el, "alt");
        if (altitude is <= -500f) altitude = null;

        var temperature = TryGetFloat(el, "temp");
        if (temperature is <= -100f or >= 200f) temperature = null;

        var stateRaw = TryGetInt(el, "state");
        int? stateId = stateRaw is >= 1 and <= 8 ? stateRaw : null;

        return new TelemetryRow(
            TMs: tMs,
            Ax: TryGetFloat(el, "ax"),
            Ay: TryGetFloat(el, "ay"),
            Az: TryGetFloat(el, "az"),
            PitchDeg: TryGetFloat(el, "pitch"),
            RollDeg: TryGetFloat(el, "roll"),
            YawDeg: TryGetFloat(el, "yaw"),
            TemperatureC: temperature,
            Velocity: velocity,
            PressurePa: pressure,
            LatitudeDeg: TryGetDouble(el, "lat"),
            LongitudeDeg: TryGetDouble(el, "lon"),
            AltitudeM: altitude,
            StateId: stateId);
    }

    private static double? TryGetDouble(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var v)) return null;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) && double.IsFinite(d)) return d;
        if (v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out var ds) && double.IsFinite(ds)) return ds;
        return null;
    }

    private static float? TryGetFloat(JsonElement el, string name)
    {
        var d = TryGetDouble(el, name);
        if (!d.HasValue) return null;
        var f = (float)d.Value;
        return float.IsFinite(f) ? f : null;
    }

    private static int? TryGetInt(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var v)) return null;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i)) return i;
        if (v.ValueKind == JsonValueKind.String && int.TryParse(v.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out var s)) return s;
        return null;
    }

    private static async Task SeedFlightStatesAsync(NpgsqlConnection conn, CancellationToken token)
    {
        foreach (var (id, name) in FlightStates)
        {
            await using var cmd = new NpgsqlCommand(
                "INSERT INTO flight_state (state_id, name) VALUES ($1, $2) " +
                "ON CONFLICT (state_id) DO NOTHING",
                conn);
            cmd.Parameters.AddWithValue(id);
            cmd.Parameters.AddWithValue(name);
            await cmd.ExecuteNonQueryAsync(token);
        }
    }

    private static async Task<int> GetOrCreateRocketAsync(NpgsqlConnection conn, string name, CancellationToken token)
    {
        await using (var select = new NpgsqlCommand("SELECT rocket_id FROM rocket WHERE name = $1 LIMIT 1", conn))
        {
            select.Parameters.AddWithValue(name);
            var result = await select.ExecuteScalarAsync(token);
            if (result is int existing) return existing;
        }

        await using var insert = new NpgsqlCommand(
            "INSERT INTO rocket (name) VALUES ($1) RETURNING rocket_id", conn);
        insert.Parameters.AddWithValue(name);
        var inserted = await insert.ExecuteScalarAsync(token);
        return (int)inserted!;
    }

    private async Task<int> CreateFlightAsync(NpgsqlConnection conn, int rocketId, string? launchSite, CancellationToken token)
    {
        var missionName = $"Session {DateTime.UtcNow:yyyy-MM-dd HH:mm:ss}Z";
        await using var cmd = new NpgsqlCommand(
            "INSERT INTO flight (rocket_id, mission_name, launch_site, launch_at) " +
            "VALUES ($1, $2, $3, now()) RETURNING flight_id",
            conn);
        cmd.Parameters.AddWithValue(rocketId);
        cmd.Parameters.AddWithValue(missionName);
        cmd.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = (object?)launchSite ?? DBNull.Value });
        var result = await cmd.ExecuteScalarAsync(token);
        return (int)result!;
    }

    public async ValueTask DisposeAsync()
    {
        if (_dataSource is null) return;

        _channel.Writer.TryComplete();

        try
        {
            if (_drainTask is not null)
                await _drainTask.WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[db] drain shutdown: {ex.Message}");
        }

        try
        {
            await using var conn = await _dataSource.OpenConnectionAsync();
            await using var cmd = new NpgsqlCommand(
                "UPDATE flight SET recover_at = now() WHERE flight_id = $1", conn);
            cmd.Parameters.AddWithValue(_flightId);
            await cmd.ExecuteNonQueryAsync();
            Console.WriteLine($"[db] flight {_flightId} closed");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[db] recover_at update failed: {ex.Message}");
        }

        _drainCts?.Dispose();
        await _dataSource.DisposeAsync();
        _dataSource = null;
    }
}

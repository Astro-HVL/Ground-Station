using Npgsql;

public class TelemetryRepository
{
    private readonly DbConnection _db;

    public TelemetryRepository(DbConnection db) => _db = db;

    public async Task SaveAsync(TelemetryInsert t)
    {
        const string sql = @"
            INSERT INTO telemetry (
                flight_id, t_ms, received_at,
                ax, ay, az, pitch_deg, roll_deg, yaw_deg,
                temperature_c, velocity, pressure_pa,
                latitude_deg, longitude_deg, altitude_m, state_id
            ) VALUES (
                @flight_id, @t_ms, now(),
                @ax, @ay, @az, @pitch, @roll, @yaw,
                @temp, @vel, @press,
                @lat, @lon, @alt, @state
            );";

        await using var conn = _db.GetConnection();
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);

        cmd.Parameters.AddWithValue("flight_id", t.FlightId);
        cmd.Parameters.AddWithValue("t_ms",      t.TMs);
        cmd.Parameters.AddWithValue("ax",        (object?)t.Ax           ?? DBNull.Value);
        cmd.Parameters.AddWithValue("ay",        (object?)t.Ay           ?? DBNull.Value);
        cmd.Parameters.AddWithValue("az",        (object?)t.Az           ?? DBNull.Value);
        cmd.Parameters.AddWithValue("pitch",     (object?)t.PitchDeg     ?? DBNull.Value);
        cmd.Parameters.AddWithValue("roll",      (object?)t.RollDeg      ?? DBNull.Value);
        cmd.Parameters.AddWithValue("yaw",       (object?)t.YawDeg       ?? DBNull.Value);
        cmd.Parameters.AddWithValue("temp",      (object?)t.TemperatureC ?? DBNull.Value);
        cmd.Parameters.AddWithValue("vel",       (object?)t.Velocity     ?? DBNull.Value);
        cmd.Parameters.AddWithValue("press",     (object?)t.PressurePa   ?? DBNull.Value);
        cmd.Parameters.AddWithValue("lat",       (object?)t.LatitudeDeg  ?? DBNull.Value);
        cmd.Parameters.AddWithValue("lon",       (object?)t.LongitudeDeg ?? DBNull.Value);
        cmd.Parameters.AddWithValue("alt",       (object?)t.AltitudeM    ?? DBNull.Value);
        cmd.Parameters.AddWithValue("state",     (object?)t.StateId      ?? DBNull.Value);

        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<List<Telemetry>> GetByFlightIdAsync(int flightId)
    {
        const string sql = @"
            SELECT telemetry_id, flight_id, t_ms, received_at,
                   ax, ay, az, pitch_deg, roll_deg, yaw_deg,
                   temperature_c, velocity, pressure_pa,
                   latitude_deg, longitude_deg, altitude_m, state_id
            FROM telemetry
            WHERE flight_id = @flight_id
            ORDER BY t_ms;";

        await using var conn = _db.GetConnection();
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("flight_id", flightId);

        await using var reader = await cmd.ExecuteReaderAsync();
        var results = new List<Telemetry>();
        while (await reader.ReadAsync())
            results.Add(MapTelemetry(reader));

        return results;
    }

    private static Telemetry MapTelemetry(NpgsqlDataReader r) => new Telemetry
    {
        TelemetryId  = r.GetInt64(0),
        FlightId     = r.GetInt32(1),
        TMs          = r.GetInt64(2),
        ReceivedAt   = r.GetFieldValue<DateTimeOffset>(3),
        Ax           = r.IsDBNull(4)  ? null : r.GetFloat(4),
        Ay           = r.IsDBNull(5)  ? null : r.GetFloat(5),
        Az           = r.IsDBNull(6)  ? null : r.GetFloat(6),
        PitchDeg     = r.IsDBNull(7)  ? null : r.GetFloat(7),
        RollDeg      = r.IsDBNull(8)  ? null : r.GetFloat(8),
        YawDeg       = r.IsDBNull(9)  ? null : r.GetFloat(9),
        TemperatureC = r.IsDBNull(10) ? null : r.GetFloat(10),
        Velocity     = r.IsDBNull(11) ? null : r.GetFloat(11),
        PressurePa   = r.IsDBNull(12) ? null : r.GetFloat(12),
        LatitudeDeg  = r.IsDBNull(13) ? null : r.GetDouble(13),
        LongitudeDeg = r.IsDBNull(14) ? null : r.GetDouble(14),
        AltitudeM    = r.IsDBNull(15) ? null : r.GetFloat(15),
        StateId      = r.IsDBNull(16) ? null : r.GetInt32(16)
    };
}
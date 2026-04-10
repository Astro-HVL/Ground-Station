using Npgsql;

public class FlightRepository
{
    private readonly DbConnection _db;

    public FlightRepository(DbConnection db) => _db = db;

    public async Task<int> InsertAsync(Flight flight)
    {
        const string sql = @"
            INSERT INTO flight (rocket_id, mission_name, launch_site, planned_launch_at, launch_at, recover_at)
            VALUES (@rocket_id, @mission_name, @launch_site, @planned_launch_at, @launch_at, @recover_at)
            RETURNING flight_id;";

        await using var conn = _db.GetConnection();
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);

        cmd.Parameters.AddWithValue("rocket_id",         flight.RocketId);
        cmd.Parameters.AddWithValue("mission_name",      (object?)flight.MissionName      ?? DBNull.Value);
        cmd.Parameters.AddWithValue("launch_site",       (object?)flight.LaunchSite       ?? DBNull.Value);
        cmd.Parameters.AddWithValue("planned_launch_at", (object?)flight.PlannedLaunchAt  ?? DBNull.Value);
        cmd.Parameters.AddWithValue("launch_at",         (object?)flight.LaunchAt         ?? DBNull.Value);
        cmd.Parameters.AddWithValue("recover_at",        (object?)flight.RecoverAt        ?? DBNull.Value);

        return Convert.ToInt32(await cmd.ExecuteScalarAsync());
    }

    public async Task<Flight?> GetByIdAsync(int flightId)
    {
        const string sql = @"
            SELECT flight_id, rocket_id, mission_name, launch_site,
                   planned_launch_at, launch_at, recover_at
            FROM flight
            WHERE flight_id = @id;";

        await using var conn = _db.GetConnection();
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("id", flightId);

        await using var reader = await cmd.ExecuteReaderAsync();
        if (!await reader.ReadAsync()) return null;

        return MapFlight(reader);
    }

    public async Task<List<Flight>> GetByRocketIdAsync(int rocketId)
    {
        const string sql = @"
            SELECT flight_id, rocket_id, mission_name, launch_site,
                   planned_launch_at, launch_at, recover_at
            FROM flight
            WHERE rocket_id = @rocket_id
            ORDER BY flight_id;";

        await using var conn = _db.GetConnection();
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("rocket_id", rocketId);

        await using var reader = await cmd.ExecuteReaderAsync();
        var results = new List<Flight>();
        while (await reader.ReadAsync())
            results.Add(MapFlight(reader));

        return results;
    }

    public async Task UpdateTimestampsAsync(int flightId, DateTimeOffset? launchAt, DateTimeOffset? recoverAt)
    {
        const string sql = @"
            UPDATE flight
            SET launch_at  = @launch_at,
                recover_at = @recover_at
            WHERE flight_id = @id;";

        await using var conn = _db.GetConnection();
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);

        cmd.Parameters.AddWithValue("id",         flightId);
        cmd.Parameters.AddWithValue("launch_at",  (object?)launchAt  ?? DBNull.Value);
        cmd.Parameters.AddWithValue("recover_at", (object?)recoverAt ?? DBNull.Value);

        await cmd.ExecuteNonQueryAsync();
    }

    private static Flight MapFlight(NpgsqlDataReader r) => new Flight
    {
        FlightId        = r.GetInt32(0),
        RocketId        = r.GetInt32(1),
        MissionName     = r.IsDBNull(2) ? null : r.GetString(2),
        LaunchSite      = r.IsDBNull(3) ? null : r.GetString(3),
        PlannedLaunchAt = r.IsDBNull(4) ? null : r.GetFieldValue<DateTimeOffset>(4),
        LaunchAt        = r.IsDBNull(5) ? null : r.GetFieldValue<DateTimeOffset>(5),
        RecoverAt       = r.IsDBNull(6) ? null : r.GetFieldValue<DateTimeOffset>(6)
    };
}
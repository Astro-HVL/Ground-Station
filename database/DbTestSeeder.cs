using System.Globalization;
using Npgsql;

// This class is used to populate the database with both test
// It is called from program.cs during development/testing
public class DbTestSeeder
{
    private readonly DbConnection _db;

    
    public DbTestSeeder(DbConnection db)
    {
        _db = db;
    }

    public async Task<(int rocketId, int flightId)> SeedTestAsync(
    string rocketName = "testRocket",
    string missionName = "testFlight",
    int telemetryRows = 1000,
    int samplePeriodMs = 50)
    {
        await using var conn = _db.GetConnection();
        await conn.OpenAsync();

        // Ensure that required rocket and flight exist.
        var rocketId = await EnsureRocketAsync(conn, rocketName);
        var flightId = await EnsureFlightAsync(conn, rocketId, missionName);

        // Generate and insert test telemetry data.
        await InsertTestTelemetryAsync(conn, flightId, telemetryRows, samplePeriodMs);

        Console.WriteLine($"✅ Seeding complete for rocket '{rocketName}' (ID: {rocketId}) and flight '{missionName}' (ID: {flightId})");
        return (rocketId, flightId);
    }

    private static async Task<int> EnsureRocketAsync(NpgsqlConnection conn, string name)
    {
        const string select = "SELECT rocket_id FROM rocket WHERE name = @name LIMIT 1;";
        await using var cmdSelect = new NpgsqlCommand(select, conn);
        cmdSelect.Parameters.AddWithValue("name", name);

        var existing = await cmdSelect.ExecuteScalarAsync();
        if (existing is not null)
            return Convert.ToInt32(existing);

        const string insert = @"INSERT INTO rocket (name)
                            VALUES (@name)
                            RETURNING rocket_id;";
        await using var cmdInsert = new NpgsqlCommand(insert, conn);
        cmdInsert.Parameters.AddWithValue("name", name);

        return Convert.ToInt32(await cmdInsert.ExecuteScalarAsync());
    }

    private static async Task<int> EnsureFlightAsync(NpgsqlConnection conn, int rocketId, string missionName)
    {
        const string select = "SELECT flight_id FROM flight WHERE rocket_id=@rid AND mission_name=@mission LIMIT 1;";
        await using var cmdSelect = new NpgsqlCommand(select, conn);
        cmdSelect.Parameters.AddWithValue("rid", rocketId);
        cmdSelect.Parameters.AddWithValue("mission", missionName);

        var existing = await cmdSelect.ExecuteScalarAsync();
        if (existing is not null)
            return Convert.ToInt32(existing);

        const string insert = @"INSERT INTO flight (rocket_id, mission_name, launch_site, planned_launch_at, launch_at)
                            VALUES (@rid, @mission, 'Test Range', now(), now())
                            RETURNING flight_id;";
        await using var cmdInsert = new NpgsqlCommand(insert, conn);
        cmdInsert.Parameters.AddWithValue("rid", rocketId);
        cmdInsert.Parameters.AddWithValue("mission", missionName);

        return Convert.ToInt32(await cmdInsert.ExecuteScalarAsync());
    }

    private static async Task InsertTestTelemetryAsync(NpgsqlConnection conn, int flightId, int rows, int dtMs)
    {
        // SQL insert for telemetry data (parameters reused in the loop)
        const string insert = @"
        INSERT INTO telemetry (
            flight_id, t_ms, received_at,
            ax, ay, az, pitch_deg, roll_deg, yaw_deg,
            temperature_c, velocity, pressure_pa,
            latitude_deg, longitude_deg, altitude_m, state_id
        )
        VALUES (
            @flight_id, @t_ms, now(),
            @ax, @ay, @az, @pitch, @roll, @yaw,
            @temp, @vel, @press,
            @lat, @lon, @alt, @state
        );";

        // Use a transaction for faster inserts (commits everything at once)
        await using var tx = await conn.BeginTransactionAsync();
        await using var cmd = new NpgsqlCommand(insert, conn, tx);

        // Define all parameters once, and then just update values in the loop
        cmd.Parameters.Add("flight_id", NpgsqlTypes.NpgsqlDbType.Integer);
        cmd.Parameters.Add("t_ms", NpgsqlTypes.NpgsqlDbType.Bigint);
        cmd.Parameters.Add("ax", NpgsqlTypes.NpgsqlDbType.Real);
        cmd.Parameters.Add("ay", NpgsqlTypes.NpgsqlDbType.Real);
        cmd.Parameters.Add("az", NpgsqlTypes.NpgsqlDbType.Real);
        cmd.Parameters.Add("pitch", NpgsqlTypes.NpgsqlDbType.Real);
        cmd.Parameters.Add("roll", NpgsqlTypes.NpgsqlDbType.Real);
        cmd.Parameters.Add("yaw", NpgsqlTypes.NpgsqlDbType.Real);
        cmd.Parameters.Add("temp", NpgsqlTypes.NpgsqlDbType.Real);
        cmd.Parameters.Add("vel", NpgsqlTypes.NpgsqlDbType.Real);
        cmd.Parameters.Add("press", NpgsqlTypes.NpgsqlDbType.Real);
        cmd.Parameters.Add("lat", NpgsqlTypes.NpgsqlDbType.Double);
        cmd.Parameters.Add("lon", NpgsqlTypes.NpgsqlDbType.Double);
        cmd.Parameters.Add("alt", NpgsqlTypes.NpgsqlDbType.Real);
        cmd.Parameters.Add("state", NpgsqlTypes.NpgsqlDbType.Integer);

        var inv = CultureInfo.InvariantCulture;

        // Simple altitude profile: rise → apogee → descent
        float maxAlt = 1200f;
        int tRise = rows / 3;
        int tFlat = rows / 6;
        int tFall = rows - tRise - tFlat;
        double lat0 = 60.389, lon0 = 5.332;

        long tMs = 0;
        for (int i = 0; i < rows; i++, tMs += dtMs)
        {
            // Compute altitude, velocity, and flight state
            float alt, velVert;
            int state; // Uses your flight_state table IDs

            if (i < tRise) // ASCENT
            {
                alt = (float)i / tRise * maxAlt;
                velVert = 50f;
                state = 1;
            }
            else if (i < tRise + tFlat) // APOGEE
            {
                alt = maxAlt;
                velVert = 0f;
                state = 2;
            }
            else // DESCENT_MAIN
            {
                float frac = (float)(i - tRise - tFlat) / tFall;
                alt = Math.Max(0f, maxAlt * (1 - frac));
                velVert = -40f;
                state = 4;
            }

            // Simulate some sensor data
            float ax = (i < tRise) ? 12f : 0.5f;
            float ay = 0.1f, az = 9.81f, pitch = 2f, roll = 1f, yaw = 0.5f;
            float temp = 18f - 0.003f * alt;
            float vel = Math.Abs(velVert);
            float press = 101325f * (float)Math.Exp(-alt / 8434.5f);
            double lat = lat0 + i * 0.00001, lon = lon0 + i * 0.00002;

            // Bind parameter values
            cmd.Parameters["flight_id"].Value = flightId;
            cmd.Parameters["t_ms"].Value = tMs;
            cmd.Parameters["ax"].Value = ax;
            cmd.Parameters["ay"].Value = ay;
            cmd.Parameters["az"].Value = az;
            cmd.Parameters["pitch"].Value = pitch;
            cmd.Parameters["roll"].Value = roll;
            cmd.Parameters["yaw"].Value = yaw;
            cmd.Parameters["temp"].Value = temp;
            cmd.Parameters["vel"].Value = vel;
            cmd.Parameters["press"].Value = press;
            cmd.Parameters["lat"].Value = lat;
            cmd.Parameters["lon"].Value = lon;
            cmd.Parameters["alt"].Value = alt;
            cmd.Parameters["state"].Value = state;

            await cmd.ExecuteNonQueryAsync();
        }

        // Commit all telemetry inserts in one go
        await tx.CommitAsync();

        Console.WriteLine($"✅ Inserted {rows} telemetry rows for flight {flightId}");
    }
}
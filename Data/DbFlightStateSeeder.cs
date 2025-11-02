using Npgsql;

namespace TelemetryWebApp.Data
{
    // Class to seed initial flight state data into the database
    // It is called from program.cs during development/testing
    public class DbFlightStateSeeder
    {
        private readonly DbConnection _db;

        public DbFlightStateSeeder(DbConnection db)
        {
            _db = db;
        }

        public async Task SeedFlightStatesAsync()
        {
            // UPSERT statement ensures that each state_id stays consistent,
            // and descriptions can be updated safely later if needed.
            const string sql = @"
            INSERT INTO flight_state (state_id, name, description) VALUES
                (0,'IDLE','Pre-launch / system armed and waiting'),
                (1,'ASCENT','Rocket ascending under power or coast phase'),
                (2,'APOGEE','Apogee detected - highest point reached'),
                (3,'DESCENT_DROGUE','Descending under drogue parachute'),
                (4,'DESCENT_MAIN','Descending under main parachute'),
                (5,'LANDED','Rocket landed and stationary')
            ON CONFLICT (state_id)
            DO UPDATE SET
                name = EXCLUDED.name,
                description = EXCLUDED.description;";

            await using var conn = _db.GetConnection();
            await conn.OpenAsync();

            await using var cmd = new NpgsqlCommand(sql, conn);
            var rows = await cmd.ExecuteNonQueryAsync();

            Console.WriteLine($"✅ Flight states seeded/updated ({rows} rows affected).");
        }
    }
}

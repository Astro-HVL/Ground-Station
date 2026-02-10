using Npgsql;

namespace TelemetryWebApp.Data
{
    public class DbConnection
    {
        private string _connectionString;

        public DbConnection()
        {
            // Connection string to PostgreSQL database - Astro user 
            // OBS: Insert password
            //_connectionString = "Host=ider-database.westeurope.cloudapp.azure.com;Port=5433;Username=astro;Password=;Database=astro";

            // Connection string to PostgreSQL database - local host
            // OBS: Use username, password and database as per your local setup
            _connectionString = "Host=localhost;Port=5432;Username=postgres;Password=;Database=postgres";
        }

        public NpgsqlConnection GetConnection()
        {
            return new NpgsqlConnection(_connectionString);
        }
    }
}

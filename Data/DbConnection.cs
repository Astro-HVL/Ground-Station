using Npgsql;

namespace TelemetryWebApp.Data
{
    public class DbConnection
    {
        private string _connectionString;

        public DbConnection()
        {
            _connectionString = "Host=ider-database.westeurope.cloudapp.azure.com;Port=5433;Username=astro;Password=;Database=astro";
        }

        public NpgsqlConnection GetConnection()
        {
            return new NpgsqlConnection(_connectionString);
        }
    }
}

using Npgsql;
public class RocketRepository
{
    private readonly DbConnection _db;

    public RocketRepository(DbConnection db) => _db = db;

    public async Task<int> InsertAsync(Rocket rocket)
    {
        const string sql = @"
            INSERT INTO rocket (name)
            VALUES (@name)
            RETURNING rocket_id;";

        await using var conn = _db.GetConnection();
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("name", rocket.Name);

        return Convert.ToInt32(await cmd.ExecuteScalarAsync());
    }

    public async Task<Rocket?> GetByIdAsync(int rocketId)
    {
        const string sql = "SELECT rocket_id, name FROM rocket WHERE rocket_id = @id;";

        await using var conn = _db.GetConnection();
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("id", rocketId);

        await using var reader = await cmd.ExecuteReaderAsync();
        if (!await reader.ReadAsync()) return null;

        return new Rocket
        {
            RocketId = reader.GetInt32(0),
            Name     = reader.GetString(1)
        };
    }

    public async Task<List<Rocket>> GetAllAsync()
    {
        const string sql = "SELECT rocket_id, name FROM rocket ORDER BY rocket_id;";

        await using var conn = _db.GetConnection();
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync();

        var results = new List<Rocket>();
        while (await reader.ReadAsync())
        {
            results.Add(new Rocket
            {
                RocketId = reader.GetInt32(0),
                Name     = reader.GetString(1)
            });
        }
        return results;
    }
}
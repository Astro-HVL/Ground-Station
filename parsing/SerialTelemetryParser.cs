using System.Globalization;

public class SerialTelemetryParser
{
    public static bool TryParse(string line, int flightId, out TelemetryInsert? result)
    {
        result = null;
        var parts = line.Trim().Split(',');

        if (parts.Length < 15) return false;

        try
        {
            result = new TelemetryInsert
            {
                FlightId     = flightId,
                TMs          = (long)(float.Parse(parts[0], CultureInfo.InvariantCulture) * 1000), // t in seconds → ms
                // parts[1] is seq, we don't store that
                Ax           = float.Parse(parts[2],  CultureInfo.InvariantCulture),
                Ay           = float.Parse(parts[3],  CultureInfo.InvariantCulture),
                Az           = float.Parse(parts[4],  CultureInfo.InvariantCulture),
                PitchDeg     = float.Parse(parts[5],  CultureInfo.InvariantCulture),
                RollDeg      = float.Parse(parts[6],  CultureInfo.InvariantCulture),
                YawDeg       = float.Parse(parts[7],  CultureInfo.InvariantCulture),
                TemperatureC = float.Parse(parts[8],  CultureInfo.InvariantCulture),
                Velocity     = float.Parse(parts[9],  CultureInfo.InvariantCulture),
                PressurePa   = float.Parse(parts[10], CultureInfo.InvariantCulture),
                LatitudeDeg  = double.Parse(parts[11], CultureInfo.InvariantCulture),
                LongitudeDeg = double.Parse(parts[12], CultureInfo.InvariantCulture),
                AltitudeM    = float.Parse(parts[13], CultureInfo.InvariantCulture),
                StateId      = int.Parse(parts[14])
            };
            return true;
        }
        catch
        {
            return false;
        }
    }
}
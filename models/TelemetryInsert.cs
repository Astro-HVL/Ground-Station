public class TelemetryInsert
{
    public int     FlightId     { get; set; }
    public long    TMs          { get; set; }
    public float?  Ax           { get; set; }
    public float?  Ay           { get; set; }
    public float?  Az           { get; set; }
    public float?  PitchDeg     { get; set; }
    public float?  RollDeg      { get; set; }
    public float?  YawDeg       { get; set; }
    public float?  TemperatureC { get; set; }
    public float?  Velocity     { get; set; }
    public float?  PressurePa   { get; set; }
    public double? LatitudeDeg  { get; set; }
    public double? LongitudeDeg { get; set; }
    public float?  AltitudeM    { get; set; }
    public int?    StateId      { get; set; }
}
namespace TelemetryWebApp.Db;

internal sealed record TelemetryRow(
    long TMs,
    float? Ax,
    float? Ay,
    float? Az,
    float? PitchDeg,
    float? RollDeg,
    float? YawDeg,
    float? TemperatureC,
    float? Velocity,
    float? PressurePa,
    double? LatitudeDeg,
    double? LongitudeDeg,
    float? AltitudeM,
    int? StateId);

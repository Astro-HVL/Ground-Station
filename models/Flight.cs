public class Flight
{
    public int               FlightId        { get; set; }
    public int               RocketId        { get; set; }
    public string?           MissionName     { get; set; }
    public string?           LaunchSite      { get; set; }
    public DateTimeOffset?   PlannedLaunchAt { get; set; }
    public DateTimeOffset?   LaunchAt        { get; set; }
    public DateTimeOffset?   RecoverAt       { get; set; }
}
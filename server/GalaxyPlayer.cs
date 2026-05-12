namespace DriftsInSpaceServer;

public class GalaxyPlayer
{
    public uint   MPId;
    public string UserId      = "";
    public string DisplayName = "";
    public string SkinId      = "";
    public ShipUpdatePacket State;

    public GalaxyPlayer(uint mpId, PlayerJoinPacket join)
    {
        MPId        = mpId;
        UserId      = join.UserId;
        DisplayName = join.DisplayName;
        SkinId      = join.SkinId;
        State       = new ShipUpdatePacket { MPId = mpId };
    }

    public PlayerInitialState ToInitialState() => new()
    {
        MPId        = MPId,
        UserId      = UserId,
        DisplayName = DisplayName,
        SkinId      = SkinId,
        State       = State,
    };
}

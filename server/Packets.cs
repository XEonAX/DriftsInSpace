namespace DriftsInSpaceServer;

// ─── Packet type IDs ──────────────────────────────────────────────────────────
// First byte of every WebSocket message identifies the packet type.
public static class PacketType
{
    public const byte PlayerJoin    = 0x01; // client → server: announce self
    public const byte Galaxy        = 0x02; // server → client: full initial state on join
    public const byte ShipUpdate    = 0x03; // client → server: 50 Hz physics state
    public const byte PlayerStates  = 0x04; // server → all:   ~22 Hz broadcast
    public const byte PlayerJoinBroadcast = 0x05; // server → others: a new player joined
    public const byte PlayerLeft    = 0x06; // server → all:   player disconnected
}

// ─── Binary helpers ───────────────────────────────────────────────────────────
// All values are little-endian.  Strings are uint16-length-prefixed UTF-8.
public static class PacketWriter
{
    public static void WriteUInt16(byte[] buf, ref int off, ushort v)
    {
        buf[off++] = (byte)(v);
        buf[off++] = (byte)(v >> 8);
    }
    public static void WriteUInt32(byte[] buf, ref int off, uint v)
    {
        buf[off++] = (byte)(v);
        buf[off++] = (byte)(v >> 8);
        buf[off++] = (byte)(v >> 16);
        buf[off++] = (byte)(v >> 24);
    }
    public static void WriteInt32(byte[] buf, ref int off, int v) =>
        WriteUInt32(buf, ref off, (uint)v);

    public static void WriteString(byte[] buf, ref int off, string s)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(s);
        WriteUInt16(buf, ref off, (ushort)bytes.Length);
        bytes.CopyTo(buf, off);
        off += bytes.Length;
    }
    public static void WriteInt8(byte[] buf, ref int off, sbyte v) => buf[off++] = (byte)v;
}

public static class PacketReader
{
    public static ushort ReadUInt16(byte[] buf, ref int off)
    {
        ushort v = (ushort)(buf[off] | (buf[off + 1] << 8));
        off += 2;
        return v;
    }
    public static uint ReadUInt32(byte[] buf, ref int off)
    {
        uint v = (uint)(buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24));
        off += 4;
        return v;
    }
    public static int ReadInt32(byte[] buf, ref int off) => (int)ReadUInt32(buf, ref off);
    public static sbyte ReadInt8(byte[] buf, ref int off) => (sbyte)buf[off++];
    public static string ReadString(byte[] buf, ref int off)
    {
        var len = ReadUInt16(buf, ref off);
        var s = System.Text.Encoding.UTF8.GetString(buf, off, len);
        off += len;
        return s;
    }
}

// ─── Packet structs ───────────────────────────────────────────────────────────

/// <summary>
/// Physics snapshot, 32 bytes payload.
/// pos.x/y, angle, vel.x/vel.y, angVel all × 1000 → int32.
/// </summary>
public struct ShipUpdatePacket
{
    public uint MPId;
    public uint Tick;
    public int  PosX;   // pos.x * 1000
    public int  PosY;   // pos.y * 1000
    public int  Angle;  // radians * 1000
    public int  VelX;   // vel.x * 1000
    public int  VelY;   // vel.y * 1000
    public int   AngVel; // angVel * 1000
    public sbyte Surge;  // input.surge  * 100, clamped [-100, 100]
    public sbyte Strafe; // input.strafe * 100, clamped [-100, 100]
    public sbyte Turn;   // input.torque * 100, clamped [-100, 100]

    public const int Size = 35; // 8 × int32 + 3 × sbyte

    public static ShipUpdatePacket Read(byte[] buf, ref int off)
    {
        return new ShipUpdatePacket
        {
            MPId   = PacketReader.ReadUInt32(buf, ref off),
            Tick   = PacketReader.ReadUInt32(buf, ref off),
            PosX   = PacketReader.ReadInt32(buf, ref off),
            PosY   = PacketReader.ReadInt32(buf, ref off),
            Angle  = PacketReader.ReadInt32(buf, ref off),
            VelX   = PacketReader.ReadInt32(buf, ref off),
            VelY   = PacketReader.ReadInt32(buf, ref off),
            AngVel = PacketReader.ReadInt32(buf, ref off),
            Surge  = PacketReader.ReadInt8(buf, ref off),
            Strafe = PacketReader.ReadInt8(buf, ref off),
            Turn   = PacketReader.ReadInt8(buf, ref off),
        };
    }

    public void Write(byte[] buf, ref int off)
    {
        PacketWriter.WriteUInt32(buf, ref off, MPId);
        PacketWriter.WriteUInt32(buf, ref off, Tick);
        PacketWriter.WriteInt32(buf, ref off, PosX);
        PacketWriter.WriteInt32(buf, ref off, PosY);
        PacketWriter.WriteInt32(buf, ref off, Angle);
        PacketWriter.WriteInt32(buf, ref off, VelX);
        PacketWriter.WriteInt32(buf, ref off, VelY);
        PacketWriter.WriteInt32(buf, ref off, AngVel);
        PacketWriter.WriteInt8(buf, ref off, Surge);
        PacketWriter.WriteInt8(buf, ref off, Strafe);
        PacketWriter.WriteInt8(buf, ref off, Turn);
    }
}

/// <summary>

/// <summary>
/// Client → server: identify yourself on connect.
/// </summary>
public struct PlayerJoinPacket
{
    public string UserId;
    public string DisplayName;
    public string SkinId;

    public static PlayerJoinPacket Read(byte[] buf, ref int off)
    {
        return new PlayerJoinPacket
        {
            UserId      = PacketReader.ReadString(buf, ref off),
            DisplayName = PacketReader.ReadString(buf, ref off),
            SkinId      = PacketReader.ReadString(buf, ref off),
        };
    }
}

/// <summary>
/// Server → client: sent to the newly-connected client only.
/// Contains the assigned MPId and all current players' full state.
/// </summary>
public class GalaxyPacket
{
    public uint MPId;
    public PlayerInitialState[] Players = [];

    /// <summary>Serialise into a new byte[]. First byte = PacketType.Galaxy.</summary>
    public byte[] Serialize()
    {
        // Calculate size: 1 (type) + 4 (MPId) + 4 (count) + N * PlayerInitialState
        int size = 1 + 4 + 4;
        foreach (var p in Players) size += p.SerializedSize();
        var buf = new byte[size];
        int off = 0;
        buf[off++] = PacketType.Galaxy;
        PacketWriter.WriteUInt32(buf, ref off, MPId);
        PacketWriter.WriteUInt32(buf, ref off, (uint)Players.Length);
        foreach (var p in Players) p.Write(buf, ref off);
        return buf;
    }
}

/// <summary>
/// Server → all: one new player joined (broadcast to existing clients only).
/// </summary>
public class PlayerJoinBroadcastPacket
{
    public required PlayerInitialState Player;

    public byte[] Serialize()
    {
        int size = 1 + Player.SerializedSize();
        var buf = new byte[size];
        int off = 0;
        buf[off++] = PacketType.PlayerJoinBroadcast;
        Player.Write(buf, ref off);
        return buf;
    }
}

/// <summary>
/// Full player identity + current physics state.
/// Used inside GalaxyPacket and PlayerJoinBroadcast.
/// </summary>
public class PlayerInitialState
{
    public uint   MPId;
    public string UserId      = "";
    public string DisplayName = "";
    public string SkinId      = "";
    public ShipUpdatePacket State;

    public int SerializedSize()
    {
        // 4 (MPId) + 2+UserId + 2+DisplayName + 2+SkinId + ShipUpdatePacket.Size
        return 4
            + 2 + System.Text.Encoding.UTF8.GetByteCount(UserId)
            + 2 + System.Text.Encoding.UTF8.GetByteCount(DisplayName)
            + 2 + System.Text.Encoding.UTF8.GetByteCount(SkinId)
            + ShipUpdatePacket.Size;
    }

    public void Write(byte[] buf, ref int off)
    {
        PacketWriter.WriteUInt32(buf, ref off, MPId);
        PacketWriter.WriteString(buf, ref off, UserId);
        PacketWriter.WriteString(buf, ref off, DisplayName);
        PacketWriter.WriteString(buf, ref off, SkinId);
        State.Write(buf, ref off);
    }
}

/// <summary>
/// Server → all: periodic broadcast of all player physics states (~22 Hz).
/// </summary>
public class PlayerStatesPacket
{
    public uint ServerTimeMs;
    public ShipUpdatePacket[] States = [];

    public byte[] Serialize()
    {
        int size = 1 + 4 + 4 + States.Length * ShipUpdatePacket.Size;
        var buf = new byte[size];
        int off = 0;
        buf[off++] = PacketType.PlayerStates;
        PacketWriter.WriteUInt32(buf, ref off, ServerTimeMs);
        PacketWriter.WriteUInt32(buf, ref off, (uint)States.Length);
        foreach (var s in States) s.Write(buf, ref off);
        return buf;
    }
}

/// <summary>
/// Server → all: a player disconnected.
/// </summary>
public class PlayerLeftPacket
{
    public uint MPId;

    public byte[] Serialize()
    {
        var buf = new byte[1 + 4];
        int off = 0;
        buf[off++] = PacketType.PlayerLeft;
        PacketWriter.WriteUInt32(buf, ref off, MPId);
        return buf;
    }
}

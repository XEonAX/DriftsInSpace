using System.Buffers;
using System.Collections.Concurrent;
using System.Net.WebSockets;

namespace DriftsInSpaceServer;

/// <summary>
/// Manages all WebSocket connections.
/// Thread-safe: connections are added/removed from any thread;
/// broadcast is called from the GalaxyService timer thread.
/// </summary>
public class WsHub
{
    private readonly ILogger<WsHub> _log;

    // All active connections, keyed by MPId
    private readonly ConcurrentDictionary<uint, ConnectedClient> _clients = new();
    // All current players (physics state etc.)
    private readonly ConcurrentDictionary<uint, GalaxyPlayer> _players = new();

    private volatile uint _nextMPId = 1;
    private uint _elapsedMs;

    // Queue of received raw messages to process on the receive timer.
    // Buffers are rented from ArrayPool and returned after processing.
    private readonly ConcurrentQueue<IncomingMessage> _incoming = new();

    public WsHub(ILogger<WsHub> logger) => _log = logger;

    // ─── Accept a new WebSocket connection ────────────────────────────────────
    public async Task AcceptAsync(WebSocket ws, CancellationToken ct)
    {
        // We don't know the MPId until we receive PPlayerJoin
        uint mpId = 0;
        var recvBuf = new byte[4096];

        try
        {
            // First message must be PPlayerJoin
            var result = await ws.ReceiveAsync(recvBuf, ct);
            if (result.MessageType == WebSocketMessageType.Close) return;

            if (recvBuf[0] != PacketType.PlayerJoin)
            {
                _log.LogWarning("First packet was not PlayerJoin (type={T})", recvBuf[0]);
                await ws.CloseAsync(WebSocketCloseStatus.PolicyViolation, "Expected PlayerJoin", ct);
                return;
            }

            int off = 1;
            var join = PlayerJoinPacket.Read(recvBuf, ref off);

            mpId = _nextMPId++;
            var player = new GalaxyPlayer(mpId, join);
            var client = new ConnectedClient(mpId, ws);

            _players[mpId] = player;
            _clients[mpId] = client;
            _log.LogInformation("Player joined: {Name} ({Id}) → MPId={MPId}", join.DisplayName, join.UserId, mpId);

            // Send PGalaxy to the new client (all current players)
            var galaxy = new GalaxyPacket
            {
                MPId    = mpId,
                Players = _players.Values
                    .Where(p => p.MPId != mpId)
                    .Select(p => p.ToInitialState())
                    .ToArray(),
            };
            await client.SendAsync(galaxy.Serialize(), ct);

            // Broadcast PPlayerJoinBroadcast to all other clients
            var joinBroadcast = new PlayerJoinBroadcastPacket { Player = player.ToInitialState() };
            var joinBuf = joinBroadcast.Serialize();
            await BroadcastExceptAsync(mpId, joinBuf, ct);

            // Receive loop for this connection
            while (!ct.IsCancellationRequested)
            {
                result = await ws.ReceiveAsync(recvBuf, ct);
                if (result.MessageType == WebSocketMessageType.Close) break;
                if (result.Count == 0) continue;

                // Copy into a pooled buffer so queue items are independent
                // without allocating a new byte[] each packet.
                var msg = ArrayPool<byte>.Shared.Rent(result.Count);
                Buffer.BlockCopy(recvBuf, 0, msg, 0, result.Count);
                _incoming.Enqueue(new IncomingMessage(mpId, msg, result.Count));
            }
        }
        catch (WebSocketException ex) when (ex.WebSocketErrorCode == WebSocketError.ConnectionClosedPrematurely)
        {
            // Normal browser tab close — not an error
        }
        catch (OperationCanceledException) { /* shutting down */ }
        catch (Exception ex)
        {
            _log.LogError(ex, "WsHub receive loop error (MPId={MPId})", mpId);
        }
        finally
        {
            if (mpId != 0)
            {
                _clients.TryRemove(mpId, out _);
                _players.TryRemove(mpId, out _);
                _log.LogInformation("Player left: MPId={MPId}", mpId);

                var leftBuf = new PlayerLeftPacket { MPId = mpId }.Serialize();
                _ = BroadcastExceptAsync(mpId, leftBuf, CancellationToken.None);
            }
        }
    }

    // ─── Called by GalaxyService receive timer (~15 ms) ───────────────────────
    public void ProcessIncoming()
    {
        while (_incoming.TryDequeue(out var item))
        {
            if (item.Length == 0)
            {
                ArrayPool<byte>.Shared.Return(item.Buffer);
                continue;
            }

            try
            {
                switch (item.Buffer[0])
                {
                    case PacketType.ShipUpdate:
                        if (!_players.TryGetValue(item.MPId, out var player)) break;
                        int off = 1;
                        var update = ShipUpdatePacket.Read(item.Buffer, ref off);
                        update.MPId = item.MPId; // always trust server-side MPId
                        player.State = update;
                        break;
                    default:
                        _log.LogDebug("Unknown packet type {T} from MPId={MPId}", item.Buffer[0], item.MPId);
                        break;
                }
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(item.Buffer);
            }
        }
    }

    // ─── Called by GalaxyService send timer (~45 ms) ──────────────────────────
    public void BroadcastStates(uint deltaMs)
    {
        _elapsedMs += deltaMs;

        if (_clients.IsEmpty) return;

        // Build PlayerStates directly into a pooled buffer to avoid per-tick allocations.
        var maxCount = _players.Count;
        var pooled = PooledSendBuffer.Rent(1 + 4 + 4 + maxCount * ShipUpdatePacket.Size);
        var buf = pooled.Buffer;
        int off = 0;
        buf[off++] = PacketType.PlayerStates;
        PacketWriter.WriteUInt32(buf, ref off, _elapsedMs);

        // Reserve count field; we fill with the actual serialized count below.
        int countOffset = off;
        off += 4;

        int count = 0;
        foreach (var p in _players.Values)
        {
            // ConcurrentDictionary can change during enumeration; bound to reserved capacity.
            if (count == maxCount) break;
            p.State.Write(buf, ref off);
            count++;
        }

        int writeOff = countOffset;
        PacketWriter.WriteUInt32(buf, ref writeOff, (uint)count);
        pooled.SetLength(off);

        // Fire-and-forget latest-state fanout; stale sends are dropped per client.
        BroadcastAllStates(pooled);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────
    private async Task BroadcastAllAsync(byte[] buf, CancellationToken ct)
    {
        foreach (var (_, client) in _clients)
            await client.SendAsync(buf, ct);
    }

    private async Task BroadcastExceptAsync(uint excludeMPId, byte[] buf, CancellationToken ct)
    {
        foreach (var (id, client) in _clients)
            if (id != excludeMPId)
                await client.SendAsync(buf, ct);
    }

    private void BroadcastAllStates(PooledSendBuffer buf)
    {
        try
        {
            foreach (var (_, client) in _clients)
            {
                // If a client is still sending a previous state frame, drop this one.
                // State packets are transient, so latest-wins keeps latency stable.
                client.TrySendLatest(buf);
            }
        }
        finally
        {
            // Release hub ownership. Client sends hold their own refs.
            buf.Release();
        }
    }
}

internal readonly record struct IncomingMessage(uint MPId, byte[] Buffer, int Length);

internal sealed class PooledSendBuffer
{
    public byte[] Buffer { get; }
    public int Length { get; private set; }

    private int _refCount;

    private PooledSendBuffer(byte[] buffer, int length)
    {
        Buffer = buffer;
        Length = length;
        _refCount = 1;
    }

    public static PooledSendBuffer Rent(int length)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(length);
        return new PooledSendBuffer(buffer, length);
    }

    public void SetLength(int length) => Length = length;

    public bool TryAddRef()
    {
        while (true)
        {
            int current = Volatile.Read(ref _refCount);
            if (current <= 0) return false;
            if (Interlocked.CompareExchange(ref _refCount, current + 1, current) == current)
                return true;
        }
    }

    public void Release()
    {
        if (Interlocked.Decrement(ref _refCount) == 0)
            ArrayPool<byte>.Shared.Return(Buffer);
    }
}

/// <summary>
/// Wraps a WebSocket with a send lock (WebSocket.SendAsync is not thread-safe).
/// </summary>
internal sealed class ConnectedClient(uint mpId, WebSocket ws)
{
    public uint MPId { get; } = mpId;
    private readonly WebSocket _ws = ws;
    private readonly SemaphoreSlim _lock = new(1, 1);

    public async Task SendAsync(byte[] buf, CancellationToken ct)
    {
        if (_ws.State != WebSocketState.Open) return;
        await _lock.WaitAsync(ct);
        try
        {
            await _ws.SendAsync(buf, WebSocketMessageType.Binary, true, ct);
        }
        catch (Exception) { /* connection already closed */ }
        finally
        {
            _lock.Release();
        }
    }

    public bool TrySendLatest(PooledSendBuffer buf)
    {
        if (_ws.State != WebSocketState.Open) return false;
        if (!_lock.Wait(0)) return false;

        if (!buf.TryAddRef())
        {
            _lock.Release();
            return false;
        }

        _ = SendLatestWithHeldLockAsync(buf);
        return true;
    }

    private async Task SendLatestWithHeldLockAsync(PooledSendBuffer buf)
    {
        try
        {
            if (_ws.State != WebSocketState.Open) return;
            await _ws.SendAsync(buf.Buffer.AsMemory(0, buf.Length), WebSocketMessageType.Binary, true, CancellationToken.None);
        }
        catch (Exception)
        {
        }
        finally
        {
            buf.Release();
            _lock.Release();
        }
    }
}

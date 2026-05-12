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

    // Queue of received raw messages to process on the receive timer
    private readonly ConcurrentQueue<(uint mpId, byte[] data)> _incoming = new();

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

                // Copy into fresh array so the queue holds independent data
                var msg = new byte[result.Count];
                Buffer.BlockCopy(recvBuf, 0, msg, 0, result.Count);
                _incoming.Enqueue((mpId, msg));
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
            var (mpId, data) = item;
            if (data.Length == 0) continue;

            switch (data[0])
            {
                case PacketType.ShipUpdate:
                    if (!_players.TryGetValue(mpId, out var player)) break;
                    int off = 1;
                    var update = ShipUpdatePacket.Read(data, ref off);
                    update.MPId = mpId; // always trust server-side MPId
                    player.State = update;
                    break;
                default:
                    _log.LogDebug("Unknown packet type {T} from MPId={MPId}", data[0], mpId);
                    break;
            }
        }
    }

    // ─── Called by GalaxyService send timer (~45 ms) ──────────────────────────
    public void BroadcastStates(uint deltaMs)
    {
        _elapsedMs += deltaMs;

        if (_clients.IsEmpty) return;

        var packet = new PlayerStatesPacket
        {
            ServerTimeMs = _elapsedMs,
            States       = _players.Values.Select(p => p.State).ToArray(),
        };
        var buf = packet.Serialize();

        // Fire-and-forget: errors are caught per-client below
        _ = BroadcastAllAsync(buf, CancellationToken.None);
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
}

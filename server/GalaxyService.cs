using System.Diagnostics;
using Microsoft.Extensions.Options;

namespace DriftsInSpaceServer;

public class ServerConfig
{
    public int SendIntervalMs    { get; set; } = 45;
    public int ReceiveIntervalMs { get; set; } = 15;
}

public class GalaxyService : IHostedService, IDisposable
{
    private readonly ILogger<GalaxyService> _log;
    private readonly WsHub _hub;
    private readonly ServerConfig _cfg;
    private Timer? _recvTimer;
    private Timer? _sendTimer;
    private long _lastSendStamp;

    public GalaxyService(ILogger<GalaxyService> logger, WsHub hub, IOptions<ServerConfig> cfg)
    {
        _log = logger;
        _hub = hub;
        _cfg = cfg.Value;
    }

    public Task StartAsync(CancellationToken ct)
    {
        _log.LogInformation("GalaxyService starting (recv={R}ms send={S}ms)",
            _cfg.ReceiveIntervalMs, _cfg.SendIntervalMs);

        _lastSendStamp = Stopwatch.GetTimestamp();

        _recvTimer = new Timer(_ => _hub.ProcessIncoming(), null,
            TimeSpan.Zero, TimeSpan.FromMilliseconds(_cfg.ReceiveIntervalMs));

        _sendTimer = new Timer(_ =>
        {
            var now       = Stopwatch.GetTimestamp();
            var deltaMs   = (uint)((now - _lastSendStamp) / TimeSpan.TicksPerMillisecond);
            _lastSendStamp = now;
            _hub.BroadcastStates(deltaMs);
        }, null, TimeSpan.Zero, TimeSpan.FromMilliseconds(_cfg.SendIntervalMs));

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken ct)
    {
        _recvTimer?.Change(Timeout.Infinite, 0);
        _sendTimer?.Change(Timeout.Infinite, 0);
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _recvTimer?.Dispose();
        _sendTimer?.Dispose();
    }
}

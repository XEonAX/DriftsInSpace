using DriftsInSpaceServer;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<ServerConfig>(
    builder.Configuration.GetSection("ServerConfig"));

builder.Services.AddSingleton<WsHub>();
builder.Services.AddHostedService<GalaxyService>();

// Allow the Vite dev server (localhost:5173) in development
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173", "http://localhost:4173")
     .AllowAnyHeader()
     .AllowAnyMethod()));

var app = builder.Build();

app.UseCors();

app.UseWebSockets(new WebSocketOptions
{
    KeepAliveInterval = TimeSpan.FromSeconds(30),
});

app.Map("/ws", async ctx =>
{
    if (!ctx.WebSockets.IsWebSocketRequest)
    {
        ctx.Response.StatusCode = 400;
        return;
    }
    var ws  = await ctx.WebSockets.AcceptWebSocketAsync();
    var hub = ctx.RequestServices.GetRequiredService<WsHub>();
    await hub.AcceptAsync(ws, ctx.RequestAborted);
});

app.MapGet("/", () => "DriftsInSpace server OK");

app.Run();

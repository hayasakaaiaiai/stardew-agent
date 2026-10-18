using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using StardewModdingAPI;

namespace StardewAgentBridge;

/// <summary>
/// WebSocket connection to the backend. Connects and reconnects in the background; received messages wait in a
/// queue for the game thread, since game state may only be touched there.
/// </summary>
internal sealed class BridgeClient : IDisposable
{
    private const int ProtocolVersion = 1;
    private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(3);

    private readonly Uri uri;
    private readonly IMonitor monitor;
    private readonly string modVersion;
    private readonly ConcurrentQueue<JsonElement> inbox = new();
    private readonly SemaphoreSlim sendLock = new(1, 1);
    private readonly CancellationTokenSource stop = new();
    private ClientWebSocket? socket;
    private int generation;
    private bool warned;

    public BridgeClient(Uri uri, IMonitor monitor, string modVersion)
    {
        this.uri = uri;
        this.monitor = monitor;
        this.modVersion = modVersion;
    }

    public bool IsConnected => this.socket?.State == WebSocketState.Open;

    /// <summary>Goes up on every successful connection, so the game thread can re-announce the loaded save.</summary>
    public int Generation => Volatile.Read(ref this.generation);

    public void Start() => _ = Task.Run(this.RunAsync);

    public bool TryReceive(out JsonElement message) => this.inbox.TryDequeue(out message);

    /// <summary>Fire and forget; dropped while disconnected, since the game falls back to vanilla behavior.</summary>
    public void Send(object message)
    {
        if (this.IsConnected)
            _ = this.SendAsync(message);
    }

    public void Dispose()
    {
        this.stop.Cancel();
        this.socket?.Abort();
    }

    private async Task RunAsync()
    {
        while (!this.stop.IsCancellationRequested)
        {
            ClientWebSocket ws = new();
            try
            {
                using CancellationTokenSource connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(this.stop.Token);
                connectTimeout.CancelAfter(RetryDelay);
                await ws.ConnectAsync(this.uri, connectTimeout.Token);
                this.socket = ws;
                Interlocked.Increment(ref this.generation);
                this.warned = false;
                this.monitor.Log($"已连接后端 {this.uri}。", LogLevel.Info);
                await this.SendAsync(new { type = "hello", modVersion = this.modVersion, protocol = ProtocolVersion });
                await this.ReceiveLoopAsync(ws);
                this.monitor.Log("和后端的连接断开了，会在后台重连。", LogLevel.Warn);
            }
            catch (Exception ex) when (!this.stop.IsCancellationRequested)
            {
                if (!this.warned)
                    this.monitor.Log($"连不上后端 {this.uri}（{ex.Message}）。会在后台每 3 秒重试，连上之前游戏是原版行为。", LogLevel.Info);
                this.warned = true;
            }
            finally
            {
                this.socket = null;
                ws.Dispose();
            }

            try
            {
                await Task.Delay(RetryDelay, this.stop.Token);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task ReceiveLoopAsync(ClientWebSocket ws)
    {
        byte[] buffer = new byte[16 * 1024];
        using MemoryStream message = new();
        while (ws.State == WebSocketState.Open && !this.stop.IsCancellationRequested)
        {
            WebSocketReceiveResult result = await ws.ReceiveAsync(buffer, this.stop.Token);
            if (result.MessageType == WebSocketMessageType.Close)
                return;
            message.Write(buffer, 0, result.Count);
            if (!result.EndOfMessage)
                continue;
            try
            {
                using JsonDocument document = JsonDocument.Parse(message.ToArray());
                this.inbox.Enqueue(document.RootElement.Clone());
            }
            catch (JsonException ex)
            {
                this.monitor.Log($"后端发来一条无法解析的消息：{ex.Message}", LogLevel.Warn);
            }
            message.SetLength(0);
        }
    }

    private async Task SendAsync(object message)
    {
        ClientWebSocket? ws = this.socket;
        if (ws is null)
            return;
        // Serialized by runtime type, so dictionaries and anonymous objects keep their fields.
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(message, message.GetType());
        await this.sendLock.WaitAsync();
        try
        {
            await ws.SendAsync(bytes, WebSocketMessageType.Text, true, this.stop.Token);
        }
        catch (Exception ex)
        {
            this.monitor.Log($"发送失败：{ex.Message}", LogLevel.Trace);
        }
        finally
        {
            this.sendLock.Release();
        }
    }
}

/** WebSocket service for the SMAPI mod (docs/game-bridge.md §5). M3a: today's talk is kept in memory only. */
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';
import { type Exchange, OPENING_LINE, runTurn, type Standing, type WorldState } from '../agent/dialogue.ts';
import type { ModelClient } from '../services/model/client.ts';
import type { Roster } from '../services/roster/index.ts';
import { type BackendMessage, type ModMessage, parseModMessage, type PlayerInfo, PROTOCOL_VERSION } from './protocol.ts';
import { worldState } from './world.ts';

export interface BridgeOptions {
  roster: Roster;
  model: ModelClient;
  /** 0 picks a free port (tests). */
  port: number;
  host?: string;
  log?: (line: string) => void;
}

/** Until save.loaded arrives; the mod always sends it first, this only keeps a stray talk from failing. */
const UNKNOWN_PLAYER: PlayerInfo = { name: '玩家', gender: 'male', farm: '' };

interface OpenTalk {
  npcId: string;
  standing: Standing;
  world: WorldState;
}

/** One game connection: who the player is, and today's conversations. */
class Session {
  player = UNKNOWN_PLAYER;
  readonly today = new Map<string, Exchange[]>();
  readonly open = new Map<string, OpenTalk>();
  busy = false;
}

export class BridgeServer {
  private readonly options: BridgeOptions;
  private readonly server: WebSocketServer;

  private constructor(options: BridgeOptions, server: WebSocketServer) {
    this.options = options;
    this.server = server;
    server.on('connection', (socket) => this.accept(socket));
  }

  static async start(options: BridgeOptions): Promise<BridgeServer> {
    const server = new WebSocketServer({ port: options.port, host: options.host ?? '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    return new BridgeServer(options, server);
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  close(): Promise<void> {
    for (const client of this.server.clients) client.terminate();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private log(line: string) {
    this.options.log?.(line);
  }

  private accept(socket: WebSocket) {
    const session = new Session();
    const send = (message: BackendMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    this.log('Mod 已连接');
    socket.on('close', () => this.log('Mod 已断开'));
    socket.on('message', (data) => {
      let message: ModMessage;
      try {
        message = parseModMessage(data.toString());
      } catch (error) {
        this.log(`忽略一条无法解析的消息：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      void this.handle(session, message, send).catch((error: unknown) => {
        this.log(`处理 ${message.type} 出错：${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  private async handle(session: Session, message: ModMessage, send: (message: BackendMessage) => void) {
    switch (message.type) {
      case 'hello':
        this.log(`Mod ${message.modVersion}，协议 ${message.protocol}`);
        send({ type: 'hello', protocol: PROTOCOL_VERSION });
        return;
      case 'save.loaded':
        session.player = message.player;
        session.today.clear();
        session.open.clear();
        this.log(`读档：${message.player.name}，${message.player.farm}农场`);
        return;
      case 'day.started':
        session.today.clear();
        session.open.clear();
        return;
      case 'talk.open': {
        const npcId = message.npc.toLowerCase();
        if (!this.options.roster.has(npcId)) {
          send({ type: 'talk.error', npc: message.npc, message: `没有 ${message.npc} 的角色卡` });
          return;
        }
        session.open.set(message.npc, {
          npcId,
          standing: { hearts: message.hearts, relation: message.relation, seenEvents: new Set(message.seenEvents) },
          world: worldState(message.world, session.player),
        });
        await this.turn(session, message.npc, OPENING_LINE, send);
        return;
      }
      case 'talk.say':
        await this.turn(session, message.npc, message.text, send);
        return;
      case 'talk.close':
        session.open.delete(message.npc);
        return;
    }
  }

  private async turn(session: Session, npc: string, playerLine: string, send: (message: BackendMessage) => void) {
    const talk = session.open.get(npc);
    if (!talk) {
      send({ type: 'talk.error', npc, message: '对话还没有打开' });
      return;
    }
    if (session.busy) {
      send({ type: 'talk.error', npc, message: '上一句还没回完' });
      return;
    }
    session.busy = true;
    try {
      const history = session.today.get(talk.npcId) ?? [];
      const result = await runTurn(
        { roster: this.options.roster, model: this.options.model },
        { npcId: talk.npcId, world: talk.world, standing: talk.standing, history, playerLine },
        { onReply: (text) => send({ type: 'talk.delta', npc, text }) },
      );
      session.today.set(talk.npcId, [...history, { player: playerLine, npc: result.reply }]);
      const { emotion, options, end } = result.meta;
      send({ type: 'talk.reply', npc, reply: result.reply, emotion, options, end });
      const usage = result.usage ? `输入 ${result.usage.inputTokens}，输出 ${result.usage.outputTokens}` : '无用量';
      this.log(`${talk.npcId}：首字 ${result.timing.firstReplyMs ?? '—'}ms，总 ${result.timing.totalMs}ms，${usage}${result.metaOk ? '' : '，格式解析失败'}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`${talk.npcId}：请求失败：${reason}`);
      send({ type: 'talk.error', npc, message: reason });
    } finally {
      session.busy = false;
    }
  }
}

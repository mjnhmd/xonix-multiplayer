import { DurableObject } from 'cloudflare:workers';
import { GameEngine, type ServerPlayer } from './game-engine';
import { generateBotName, updateBot } from './bot';
import {
  MAX_PLAYERS, TICK_MS,
  ClientMsgType, ServerMsgType,
  type ClientMsg, type ServerGameStateMsg, type ServerDeltaMsg,
  type ServerMsg, type PlayerInfo,
} from './protocol';

interface Env {
  GAME_ROOMS: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
}

interface ConnectionMeta {
  playerId: number;
  name: string;
}

export class GameRoom extends DurableObject<Env> {
  private engine: GameEngine;
  private playerSlots: (ConnectionMeta | null)[] = new Array(MAX_PLAYERS).fill(null);
  private botSlots: Set<number> = new Set();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private lastTickTime = 0;
  private fullStateSentAt: Map<WebSocket, number> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.engine = new GameEngine();
    this.restoreConnections();
  }

  private restoreConnections(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as ConnectionMeta | null;
      if (meta && meta.playerId >= 0 && meta.playerId < MAX_PLAYERS) {
        this.playerSlots[meta.playerId] = meta;
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      const name = url.searchParams.get('name') || `Player${Math.floor(Math.random() * 1000)}`;
      const slotId = this.findFreeSlot();

      if (slotId === -1) {
        return new Response('Room is full', { status: 503 });
      }

      const meta: ConnectionMeta = { playerId: slotId, name };
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(meta);
      this.playerSlots[slotId] = meta;

      if (this.botSlots.has(slotId)) {
        this.engine.removePlayer(slotId);
        this.botSlots.delete(slotId);
      }

      this.engine.addPlayer(slotId, name, false);
      this.ensureTickRunning();
      this.fillWithBots();

      const welcome: ServerMsg = {
        type: ServerMsgType.WELCOME,
        playerId: slotId,
        roomId: this.ctx.id.toString(),
      };
      server.send(JSON.stringify(welcome));

      this.sendFullState(server);
      this.broadcastPlayerJoined(slotId);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/status') {
      const humanCount = this.playerSlots.filter((s, i) => s && !this.botSlots.has(i)).length;
      const totalCount = this.playerSlots.filter(s => s !== null).length;
      return Response.json({
        humanPlayers: humanCount,
        totalPlayers: totalCount,
        gameOver: this.engine.gameOver,
      });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    const meta = ws.deserializeAttachment() as ConnectionMeta | null;
    if (!meta) return;

    let msg: ClientMsg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    switch (msg.type) {
      case ClientMsgType.INPUT:
        this.engine.setPlayerDirection(meta.playerId, msg.dir, msg.seq);
        break;
      case ClientMsgType.PING: {
        const pong: ServerMsg = {
          type: ServerMsgType.PONG,
          t: msg.t,
          serverTime: Date.now(),
        };
        ws.send(JSON.stringify(pong));
        break;
      }
      case ClientMsgType.LEAVE:
        this.handlePlayerLeave(meta.playerId);
        ws.close(1000, 'left');
        break;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const meta = ws.deserializeAttachment() as ConnectionMeta | null;
    if (meta) {
      this.handlePlayerLeave(meta.playerId);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const meta = ws.deserializeAttachment() as ConnectionMeta | null;
    if (meta) {
      this.handlePlayerLeave(meta.playerId);
    }
  }

  private eliminatePlayer(playerId: number): void {
    const isBot = this.botSlots.has(playerId);

    this.engine.removePlayer(playerId);
    this.playerSlots[playerId] = null;
    this.botSlots.delete(playerId);

    const leaveMsg: ServerMsg = {
      type: ServerMsgType.PLAYER_LEFT,
      playerId,
    };
    this.broadcast(JSON.stringify(leaveMsg));

    if (!isBot) {
      for (const ws of this.ctx.getWebSockets()) {
        const meta = ws.deserializeAttachment() as ConnectionMeta | null;
        if (meta && meta.playerId === playerId) {
          ws.close(1000, 'eliminated');
          break;
        }
      }
    }
  }

  private handlePlayerLeave(playerId: number): void {
    this.engine.removePlayer(playerId);
    this.playerSlots[playerId] = null;
    this.botSlots.delete(playerId);

    const leaveMsg: ServerMsg = {
      type: ServerMsgType.PLAYER_LEFT,
      playerId,
    };
    this.broadcast(JSON.stringify(leaveMsg));

    const humanCount = this.getHumanCount();
    if (humanCount === 0) {
      this.stopTick();
      this.cleanupBots();
    } else {
      this.fillWithBots();
    }
  }

  private findFreeSlot(): number {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (!this.playerSlots[i] || this.botSlots.has(i)) return i;
    }
    return -1;
  }

  private getHumanCount(): number {
    let count = 0;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (this.playerSlots[i] && !this.botSlots.has(i)) count++;
    }
    return count;
  }

  private fillWithBots(): void {
    const humanCount = this.getHumanCount();
    if (humanCount === 0) return;

    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (!this.playerSlots[i]) {
        const botName = generateBotName();
        this.playerSlots[i] = { playerId: i, name: botName };
        this.botSlots.add(i);
        this.engine.addPlayer(i, botName, true);
        this.broadcastPlayerJoined(i);
      }
    }
  }

  private cleanupBots(): void {
    for (const botId of this.botSlots) {
      this.engine.removePlayer(botId);
      this.playerSlots[botId] = null;
    }
    this.botSlots.clear();
  }

  private ensureTickRunning(): void {
    if (this.tickInterval) return;
    this.lastTickTime = Date.now();
    this.tickInterval = setInterval(() => this.gameTick(), TICK_MS);
  }

  private stopTick(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  private gameTick(): void {
    const now = Date.now();
    const dt = Math.min((now - this.lastTickTime) / 1000, 0.1);
    this.lastTickTime = now;

    this.updateBots();

    const events = this.engine.update(dt);

    for (const evt of events) {
      if (evt.type === 'player_died') {
        const msg: ServerMsg = {
          type: ServerMsgType.PLAYER_DIED,
          playerId: evt.playerId,
          killerId: evt.killerId ?? -1,
          reason: evt.reason ?? '',
        };
        this.broadcast(JSON.stringify(msg));
      } else if (evt.type === 'territory_claimed') {
        const msg: ServerMsg = {
          type: ServerMsgType.TERRITORY_CLAIMED,
          playerId: evt.playerId,
          newPercent: this.engine.players.get(evt.playerId)?.areaPercent ?? 0,
          pixelsClaimed: evt.pixelsClaimed ?? 0,
        };
        this.broadcast(JSON.stringify(msg));
      } else if (evt.type === 'game_over') {
        const msg: ServerMsg = {
          type: ServerMsgType.GAME_OVER,
          winnerId: evt.winnerId ?? -1,
          winnerName: evt.winnerName ?? '',
          rankings: this.engine.getRankings(),
        };
        this.broadcast(JSON.stringify(msg));
        this.stopTick();
      } else if (evt.type === 'player_eliminated') {
        this.eliminatePlayer(evt.playerId);
      }
    }

    this.broadcastDelta();
  }

  private updateBots(): void {
    for (const botId of this.botSlots) {
      const bot = this.engine.players.get(botId);
      if (!bot) continue;
      const newDir = updateBot(bot, this.engine);
      if (newDir !== null) {
        this.engine.setPlayerDirection(botId, newDir, 0);
      }
    }
  }

  private sendFullState(ws: WebSocket): void {
    const msg: ServerGameStateMsg = {
      type: ServerMsgType.GAME_STATE,
      tick: this.engine.tick,
      players: this.engine.getAllPlayerInfos(),
      enemies: this.engine.getEnemyInfos(),
      grid: this.engine.encodeGrid(),
      rankings: this.engine.getRankings(),
    };
    ws.send(JSON.stringify(msg));
    this.fullStateSentAt.set(ws, this.engine.tick);
  }

  private broadcastDelta(): void {
    const delta: ServerDeltaMsg = {
      type: ServerMsgType.DELTA,
      tick: this.engine.tick,
      players: this.engine.getAllPlayerInfos(),
      enemies: this.engine.getEnemyInfos(),
      changes: this.engine.getChangedPixels(),
      rankings: this.engine.getRankings(),
    };
    const data = JSON.stringify(delta);

    for (const ws of this.ctx.getWebSockets()) {
      try {
        const sentAt = this.fullStateSentAt.get(ws);
        if (!sentAt || this.engine.tick - sentAt > 200) {
          this.sendFullState(ws);
        } else {
          ws.send(data);
        }
      } catch {
        // connection dead
      }
    }
  }

  private broadcastPlayerJoined(playerId: number): void {
    const p = this.engine.players.get(playerId);
    if (!p) return;
    const msg: ServerMsg = {
      type: ServerMsgType.PLAYER_JOINED,
      player: this.engine.getPlayerInfo(p),
    };
    this.broadcast(JSON.stringify(msg));
  }

  private broadcast(data: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch { /* dead connection */ }
    }
  }
}

export class Lobby extends DurableObject<Env> {
  private rooms: Map<string, { humanCount: number; createdAt: number }> = new Map();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/find-room') {
      const roomId = await this.findOrCreateRoom();
      return Response.json({ roomId });
    }

    if (url.pathname === '/room-joined') {
      const roomId = url.searchParams.get('roomId');
      if (roomId) {
        const room = this.rooms.get(roomId);
        if (room) {
          room.humanCount = Math.min(MAX_PLAYERS, room.humanCount + 1);
        }
      }
      return new Response('ok');
    }

    if (url.pathname === '/room-left') {
      const roomId = url.searchParams.get('roomId');
      if (roomId) {
        const room = this.rooms.get(roomId);
        if (room) {
          room.humanCount = Math.max(0, room.humanCount - 1);
          if (room.humanCount === 0) {
            this.rooms.delete(roomId);
          }
        }
      }
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  }

  private async findOrCreateRoom(): Promise<string> {
    for (const [roomId, info] of this.rooms) {
      if (info.humanCount < MAX_PLAYERS) {
        return roomId;
      }
    }

    const newRoomId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.rooms.set(newRoomId, { humanCount: 0, createdAt: Date.now() });
    return newRoomId;
  }
}

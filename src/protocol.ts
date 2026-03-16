// ============================================================
// protocol.ts — 客户端/服务端共享的消息协议与类型定义
// ============================================================

// ---- 游戏常量 ----
export const GAME_W = 800;
export const GAME_H = 600;
export const BORDER = 10;
export const MAX_PLAYERS = 8;
export const PLAYER_SPEED = 120;     // px/s
export const PLAYER_RADIUS = 3;
export const ENEMY_RADIUS = 6;
export const ENEMY_SPEED = 70;
export const ENEMY_COUNT = 3;
export const WIN_PERCENT = 100;
export const TICK_RATE = 20;          // server ticks/s
export const TICK_MS = 1000 / TICK_RATE;

// ---- 玩家颜色 ----
export const PLAYER_COLORS = [
  '#e74c3c', // 红
  '#3498db', // 蓝
  '#2ecc71', // 绿
  '#f39c12', // 橙
  '#9b59b6', // 紫
  '#1abc9c', // 青
  '#e91e63', // 粉
  '#00bcd4', // 天蓝
] as const;

export const PLAYER_COLOR_NAMES = [
  'Red', 'Blue', 'Green', 'Orange', 'Purple', 'Teal', 'Pink', 'Cyan',
] as const;

// ---- 方向 ----
export const enum Direction {
  NONE = 0,
  UP = 1,
  DOWN = 2,
  LEFT = 3,
  RIGHT = 4,
}

// ---- 玩家状态 ----
export const enum PlayerState {
  IDLE = 0,
  MOVING_SAFE = 1,
  DRAWING = 2,
  DEAD = 3,
}

// ---- 消息类型: Client → Server ----
export const enum ClientMsgType {
  JOIN = 1,
  INPUT = 2,
  LEAVE = 3,
  PING = 4,
}

// ---- 消息类型: Server → Client ----
export const enum ServerMsgType {
  WELCOME = 10,         // 分配玩家ID + 初始状态
  GAME_STATE = 11,      // 完整状态快照
  DELTA = 12,           // 增量更新
  PLAYER_JOINED = 13,
  PLAYER_LEFT = 14,
  PLAYER_DIED = 15,
  TERRITORY_CLAIMED = 16,
  GAME_OVER = 17,       // 有人达到100%
  PONG = 18,
  RANKINGS = 19,        // 实时排行
}

// ---- 消息结构 ----
export interface ClientJoinMsg {
  type: ClientMsgType.JOIN;
  name: string;
}

export interface ClientInputMsg {
  type: ClientMsgType.INPUT;
  dir: Direction;
  seq: number;        // 输入序号，用于客户端预测对账
}

export interface ClientLeaveMsg {
  type: ClientMsgType.LEAVE;
}

export interface ClientPingMsg {
  type: ClientMsgType.PING;
  t: number;
}

export type ClientMsg = ClientJoinMsg | ClientInputMsg | ClientLeaveMsg | ClientPingMsg;

// ---- 玩家信息（网络传输用）----
export interface PlayerInfo {
  id: number;           // 0-7 slot index
  name: string;
  color: string;
  x: number;
  y: number;
  dir: Direction;
  state: PlayerState;
  trail: { x: number; y: number }[];
  areaPercent: number;
  isBot: boolean;
  lives: number;
}

// ---- 敌人信息 ----
export interface EnemyInfo {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// ---- 排行项 ----
export interface RankEntry {
  id: number;
  name: string;
  color: string;
  percent: number;
}

// ---- Server 消息结构 ----
export interface ServerWelcomeMsg {
  type: ServerMsgType.WELCOME;
  playerId: number;
  roomId: string;
}

export interface ServerGameStateMsg {
  type: ServerMsgType.GAME_STATE;
  tick: number;
  players: PlayerInfo[];
  enemies: EnemyInfo[];
  // grid 用 base64 编码的 Uint8Array，每字节 = ownerPlayerId (0=无人, 1-8=玩家slot+1)
  grid: string;
  rankings: RankEntry[];
}

export interface ServerDeltaMsg {
  type: ServerMsgType.DELTA;
  tick: number;
  players: PlayerInfo[];
  enemies: EnemyInfo[];
  // 只有变化的像素: [x, y, ownerId, x, y, ownerId, ...]
  changes: number[];
  rankings: RankEntry[];
}

export interface ServerPlayerJoinedMsg {
  type: ServerMsgType.PLAYER_JOINED;
  player: PlayerInfo;
}

export interface ServerPlayerLeftMsg {
  type: ServerMsgType.PLAYER_LEFT;
  playerId: number;
}

export interface ServerPlayerDiedMsg {
  type: ServerMsgType.PLAYER_DIED;
  playerId: number;
  killerId: number;   // -1=自杀, -2=AI敌人
  reason: string;
}

export interface ServerTerritoryClaimed {
  type: ServerMsgType.TERRITORY_CLAIMED;
  playerId: number;
  newPercent: number;
  pixelsClaimed: number;
}

export interface ServerGameOverMsg {
  type: ServerMsgType.GAME_OVER;
  winnerId: number;
  winnerName: string;
  rankings: RankEntry[];
}

export interface ServerPongMsg {
  type: ServerMsgType.PONG;
  t: number;
  serverTime: number;
}

export interface ServerRankingsMsg {
  type: ServerMsgType.RANKINGS;
  rankings: RankEntry[];
}

export type ServerMsg =
  | ServerWelcomeMsg
  | ServerGameStateMsg
  | ServerDeltaMsg
  | ServerPlayerJoinedMsg
  | ServerPlayerLeftMsg
  | ServerPlayerDiedMsg
  | ServerTerritoryClaimed
  | ServerGameOverMsg
  | ServerPongMsg
  | ServerRankingsMsg;

// ---- 工具函数 ----
export function dirToDelta(dir: Direction): { dx: number; dy: number } {
  switch (dir) {
    case Direction.UP: return { dx: 0, dy: -1 };
    case Direction.DOWN: return { dx: 0, dy: 1 };
    case Direction.LEFT: return { dx: -1, dy: 0 };
    case Direction.RIGHT: return { dx: 1, dy: 0 };
    default: return { dx: 0, dy: 0 };
  }
}

export function oppositeDir(dir: Direction): Direction {
  switch (dir) {
    case Direction.UP: return Direction.DOWN;
    case Direction.DOWN: return Direction.UP;
    case Direction.LEFT: return Direction.RIGHT;
    case Direction.RIGHT: return Direction.LEFT;
    default: return Direction.NONE;
  }
}

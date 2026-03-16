import {
  Direction, PlayerState,
  GAME_W, GAME_H, BORDER,
} from './protocol';
import { type ServerPlayer, type GameEngine } from './game-engine';

const BOT_FIRST_NAMES = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Ghost', 'Hawk',
  'Iron', 'Jade', 'Kilo', 'Luna', 'Maverick', 'Nova', 'Omega', 'Phoenix',
  'Quinn', 'Raven', 'Shadow', 'Thunder', 'Ultra', 'Viper', 'Wolf', 'Xenon',
  'Yeti', 'Zephyr', 'Blaze', 'Cipher', 'Drift', 'Ember',
];

const BOT_SUFFIXES = ['Bot', 'AI', 'Pro', 'X', 'Zero', 'One', 'Max', 'Jr'];

export function generateBotName(): string {
  const first = BOT_FIRST_NAMES[Math.floor(Math.random() * BOT_FIRST_NAMES.length)];
  const suffix = BOT_SUFFIXES[Math.floor(Math.random() * BOT_SUFFIXES.length)];
  const num = Math.floor(Math.random() * 100);
  return `${first}${suffix}${num}`;
}

interface BotPlan {
  steps: Direction[];
  stepIndex: number;
  stepDistances: number[];
  distanceTraveled: number;
}

const botPlans = new Map<number, BotPlan>();
const botExitDirs = new Map<number, Direction>();

export function updateBot(bot: ServerPlayer, engine: GameEngine): Direction | null {
  if (bot.state === PlayerState.DEAD) {
    botPlans.delete(bot.id);
    botExitDirs.delete(bot.id);
    return null;
  }

  if (bot.state === PlayerState.IDLE) {
    return pickExitDirection(bot, engine);
  }

  if (bot.state === PlayerState.MOVING_SAFE) {
    return handleMovingSafe(bot, engine);
  }

  if (bot.state === PlayerState.DRAWING) {
    return executeDrawingPlan(bot, engine);
  }

  return null;
}

function handleMovingSafe(bot: ServerPlayer, engine: GameEngine): Direction | null {
  const existingDir = botExitDirs.get(bot.id);

  if (existingDir && (existingDir as number) !== (Direction.NONE as number)) {
    if (isNearMapEdge(bot)) {
      return pickExitDirection(bot, engine);
    }
    return null;
  }

  return pickExitDirection(bot, engine);
}

function pickExitDirection(bot: ServerPlayer, engine: GameEngine): Direction {
  const dir = findDirectionToTerrritoryEdge(bot, engine);
  botExitDirs.set(bot.id, dir);
  botPlans.delete(bot.id);
  return dir;
}

function findDirectionToTerrritoryEdge(bot: ServerPlayer, engine: GameEngine): Direction {
  const ownerId = bot.id + 1;
  const dirs = [Direction.UP, Direction.DOWN, Direction.LEFT, Direction.RIGHT] as const;

  let bestDir = dirs[Math.floor(Math.random() * 4)];
  let bestDist = Infinity;

  for (const dir of dirs) {
    const dx = dir === Direction.LEFT ? -1 : dir === Direction.RIGHT ? 1 : 0;
    const dy = dir === Direction.UP ? -1 : dir === Direction.DOWN ? 1 : 0;

    for (let d = 1; d <= 400; d++) {
      const tx = Math.round(bot.x + dx * d);
      const ty = Math.round(bot.y + dy * d);

      if (tx <= BORDER || tx >= GAME_W - BORDER || ty <= BORDER || ty >= GAME_H - BORDER) break;

      const owner = engine.grid[ty * GAME_W + tx];
      if (owner !== ownerId && owner !== 255) {
        if (d < bestDist) {
          bestDist = d;
          bestDir = dir;
        }
        break;
      }
    }
  }

  return bestDir;
}

function createRectanglePlan(bot: ServerPlayer, engine: GameEngine): BotPlan {
  const currentDir = bot.dir;
  const outDist = 40 + Math.floor(Math.random() * 80);
  const sideDist = 40 + Math.floor(Math.random() * 80);

  const sideDir = pickPerpendicularDir(currentDir);
  const returnDir = oppositeOf(currentDir);

  // 矩形路线: 继续当前方向(深入) → 横移 → 返回安全区
  return {
    steps: [currentDir, sideDir, returnDir],
    stepDistances: [outDist, sideDist, outDist + 30],
    stepIndex: 0,
    distanceTraveled: 0,
  };
}

function executeDrawingPlan(bot: ServerPlayer, engine: GameEngine): Direction | null {
  let plan = botPlans.get(bot.id);

  if (!plan) {
    plan = createRectanglePlan(bot, engine);
    botPlans.set(bot.id, plan);
    return plan.steps[0];
  }

  plan.distanceTraveled += Math.abs(bot.vx) > 0 ? Math.abs(bot.vx) / 20 : Math.abs(bot.vy) / 20;

  if (isAboutToHitOwnTrail(bot)) {
    botPlans.delete(bot.id);
    return headTowardSafety(bot, engine);
  }

  if (isNearMapEdge(bot)) {
    botPlans.delete(bot.id);
    return headTowardSafety(bot, engine);
  }

  if (plan.distanceTraveled >= plan.stepDistances[plan.stepIndex]) {
    plan.stepIndex++;
    plan.distanceTraveled = 0;

    if (plan.stepIndex >= plan.steps.length) {
      botPlans.delete(bot.id);
      return headTowardSafety(bot, engine);
    }

    return plan.steps[plan.stepIndex];
  }

  return null;
}

function headTowardSafety(bot: ServerPlayer, engine: GameEngine): Direction {
  const ownerId = bot.id + 1;
  let bestDir = Direction.UP;
  let bestDist = Infinity;

  const dirs = [Direction.UP, Direction.DOWN, Direction.LEFT, Direction.RIGHT] as const;

  for (const dir of dirs) {
    if (dir === oppositeOf(bot.dir) && (bot.vx !== 0 || bot.vy !== 0)) continue;

    const dx = dir === Direction.LEFT ? -1 : dir === Direction.RIGHT ? 1 : 0;
    const dy = dir === Direction.UP ? -1 : dir === Direction.DOWN ? 1 : 0;

    for (let d = 1; d <= 400; d++) {
      const tx = Math.round(bot.x + dx * d);
      const ty = Math.round(bot.y + dy * d);
      if (tx < 0 || tx >= GAME_W || ty < 0 || ty >= GAME_H) break;

      const owner = engine.grid[ty * GAME_W + tx];
      if (owner === ownerId || owner === 255) {
        if (d < bestDist && !wouldHitOwnTrail(bot, dir, d)) {
          bestDist = d;
          bestDir = dir;
        }
        break;
      }
    }
  }

  return bestDir;
}

function wouldHitOwnTrail(bot: ServerPlayer, dir: Direction, maxDist: number): boolean {
  const dx = dir === Direction.LEFT ? -1 : dir === Direction.RIGHT ? 1 : 0;
  const dy = dir === Direction.UP ? -1 : dir === Direction.DOWN ? 1 : 0;

  for (let d = 1; d <= Math.min(maxDist, 100); d++) {
    const tx = bot.x + dx * d;
    const ty = bot.y + dy * d;
    for (let i = 0; i < bot.trail.length - 1; i++) {
      const seg = bot.trail[i];
      const segNext = bot.trail[i + 1];
      if (pointNearSegment(tx, ty, seg.x, seg.y, segNext.x, segNext.y, 3)) {
        return true;
      }
    }
  }
  return false;
}

function isAboutToHitOwnTrail(bot: ServerPlayer): boolean {
  if (bot.trail.length < 3) return false;

  const dx = bot.vx > 0 ? 1 : bot.vx < 0 ? -1 : 0;
  const dy = bot.vy > 0 ? 1 : bot.vy < 0 ? -1 : 0;
  if (dx === 0 && dy === 0) return false;

  for (let d = 1; d <= 10; d++) {
    const tx = bot.x + dx * d;
    const ty = bot.y + dy * d;
    for (let i = 0; i < bot.trail.length - 2; i++) {
      if (pointNearSegment(tx, ty, bot.trail[i].x, bot.trail[i].y, bot.trail[i + 1].x, bot.trail[i + 1].y, 4)) {
        return true;
      }
    }
  }
  return false;
}

function isNearMapEdge(bot: ServerPlayer): boolean {
  const margin = BORDER + 5;
  return bot.x <= margin || bot.x >= GAME_W - margin || bot.y <= margin || bot.y >= GAME_H - margin;
}

function pointNearSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number, threshold: number): boolean {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 < 0.01) return Math.hypot(px - ax, py - ay) < threshold;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2));
  const cx = ax + t * abx, cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy) < threshold;
}

function pickPerpendicularDir(dir: Direction): Direction {
  if (dir === Direction.UP || dir === Direction.DOWN) {
    return Math.random() < 0.5 ? Direction.LEFT : Direction.RIGHT;
  }
  return Math.random() < 0.5 ? Direction.UP : Direction.DOWN;
}

function oppositeOf(dir: Direction): Direction {
  switch (dir) {
    case Direction.UP: return Direction.DOWN;
    case Direction.DOWN: return Direction.UP;
    case Direction.LEFT: return Direction.RIGHT;
    case Direction.RIGHT: return Direction.LEFT;
    default: return Direction.UP;
  }
}

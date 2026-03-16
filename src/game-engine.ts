import {
  GAME_W, GAME_H, BORDER, PLAYER_SPEED, PLAYER_RADIUS,
  ENEMY_RADIUS, ENEMY_SPEED, ENEMY_COUNT, MAX_PLAYERS,
  Direction, PlayerState, dirToDelta, oppositeDir,
  type PlayerInfo, type EnemyInfo, type RankEntry,
  PLAYER_COLORS, PLAYER_COLOR_NAMES, WIN_PERCENT,
} from './protocol';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

function pointToSegDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-10) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / len2, 0, 1);
  const cx = ax + t * abx, cy = ay + t * aby;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

function segmentsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const denom = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(denom) < 1e-10) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denom;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denom;
  return t > 1e-8 && t < 1 - 1e-8 && u > 1e-8 && u < 1 - 1e-8;
}

interface Point { x: number; y: number; }

export interface ServerPlayer {
  id: number;
  name: string;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dir: Direction;
  state: PlayerState;
  trail: Point[];
  areaPercent: number;
  isBot: boolean;
  lives: number;
  respawnTimer: number;
  inputSeq: number;
}

export interface ServerEnemy {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

export interface GameEvent {
  type: 'player_died' | 'territory_claimed' | 'game_over' | 'player_eliminated';
  playerId: number;
  killerId?: number;
  reason?: string;
  winnerId?: number;
  winnerName?: string;
  newPercent?: number;
  pixelsClaimed?: number;
}

// grid[y * GAME_W + x] = ownerId (0 = unclaimed, 1-8 = player slot + 1)
export class GameEngine {
  grid: Uint8Array;
  players: Map<number, ServerPlayer> = new Map();
  enemies: ServerEnemy[] = [];
  tick = 0;
  gameOver = false;
  winnerId = -1;

  private spawnPoints: Point[];
  private changedPixels: number[] = [];

  constructor() {
    this.grid = new Uint8Array(GAME_W * GAME_H);
    this.spawnPoints = [
      { x: BORDER / 2, y: BORDER / 2 },
      { x: GAME_W - BORDER / 2, y: BORDER / 2 },
      { x: BORDER / 2, y: GAME_H - BORDER / 2 },
      { x: GAME_W - BORDER / 2, y: GAME_H - BORDER / 2 },
      { x: GAME_W / 2, y: BORDER / 2 },
      { x: GAME_W / 2, y: GAME_H - BORDER / 2 },
      { x: BORDER / 2, y: GAME_H / 2 },
      { x: GAME_W - BORDER / 2, y: GAME_H / 2 },
    ];
    this.initBorderSafe();
    this.spawnEnemies();
  }

  private initBorderSafe(): void {
    for (let y = 0; y < GAME_H; y++) {
      for (let x = 0; x < GAME_W; x++) {
        if (x < BORDER || x >= GAME_W - BORDER || y < BORDER || y >= GAME_H - BORDER) {
          // 边界标记为 255 (neutral safe zone, 不属于任何玩家)
          this.grid[y * GAME_W + x] = 255;
        }
      }
    }
  }

  private spawnEnemies(): void {
    this.enemies = [];
    const margin = BORDER + ENEMY_RADIUS * 2 + 10;
    for (let i = 0; i < ENEMY_COUNT; i++) {
      let ex: number, ey: number;
      let attempts = 0;
      do {
        ex = margin + Math.random() * (GAME_W - 2 * margin);
        ey = margin + Math.random() * (GAME_H - 2 * margin);
        attempts++;
      } while (this.grid[Math.round(ey) * GAME_W + Math.round(ex)] !== 0 && attempts < 100);

      const angle = Math.random() * Math.PI * 2;
      this.enemies.push({
        x: ex, y: ey,
        vx: Math.cos(angle) * ENEMY_SPEED,
        vy: Math.sin(angle) * ENEMY_SPEED,
        radius: ENEMY_RADIUS,
      });
    }
  }

  addPlayer(id: number, name: string, isBot: boolean): ServerPlayer {
    const spawn = this.spawnPoints[id % this.spawnPoints.length];
    const player: ServerPlayer = {
      id,
      name,
      color: PLAYER_COLORS[id % PLAYER_COLORS.length],
      x: spawn.x,
      y: spawn.y,
      vx: 0, vy: 0,
      dir: Direction.NONE,
      state: PlayerState.IDLE,
      trail: [],
      areaPercent: 0,
      isBot,
      lives: 3,
      respawnTimer: 0,
      inputSeq: 0,
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
    // 清除该玩家的领地 → 变为无主
    const ownerId = id + 1;
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] === ownerId) {
        this.grid[i] = 0;
        const x = i % GAME_W;
        const y = (i / GAME_W) | 0;
        this.changedPixels.push(x, y, 0);
      }
    }
  }

  setPlayerDirection(playerId: number, dir: Direction, seq: number): void {
    const p = this.players.get(playerId);
    if (!p || p.state === PlayerState.DEAD) return;

    // 禁止180度掉头
    if (dir !== Direction.NONE && dir === oppositeDir(p.dir) && (p.vx !== 0 || p.vy !== 0)) {
      return;
    }

    p.inputSeq = seq;

    if (dir === Direction.NONE) {
      if (p.state !== PlayerState.DRAWING) {
        p.vx = 0;
        p.vy = 0;
        p.state = PlayerState.IDLE;
      }
      return;
    }

    const { dx, dy } = dirToDelta(dir);
    const wasMoving = p.vx !== 0 || p.vy !== 0;

    p.dir = dir;
    p.vx = dx * PLAYER_SPEED;
    p.vy = dy * PLAYER_SPEED;

    if (wasMoving && p.state === PlayerState.DRAWING) {
      this.addTrailTurn(p);
    }

    if (p.state === PlayerState.IDLE) {
      p.state = PlayerState.MOVING_SAFE;
    }
  }

  update(dt: number): GameEvent[] {
    if (this.gameOver) return [];

    this.tick++;
    this.changedPixels = [];
    const events: GameEvent[] = [];

    for (const p of this.players.values()) {
      if (p.state === PlayerState.DEAD) {
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0) {
          this.respawnPlayer(p);
        }
        continue;
      }
      this.updatePlayer(p, dt, events);
    }

    this.updateEnemies(dt);
    this.checkTrailCollisions(events);
    this.updateAreaPercents(events);
    this.checkWinCondition(events);

    return events;
  }

  private updatePlayer(p: ServerPlayer, dt: number, events: GameEvent[]): void {
    if (p.vx === 0 && p.vy === 0) return;

    const prevX = p.x, prevY = p.y;
    const wasInSafe = this.isPointSafeForPlayer(prevX, prevY, p.id);

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    this.handlePlayerBoundary(p, events);

    const isInSafe = this.isPointSafeForPlayer(p.x, p.y, p.id);

    if (p.state === PlayerState.MOVING_SAFE && wasInSafe && !isInSafe) {
      p.trail = [{ x: prevX, y: prevY }];
      p.state = PlayerState.DRAWING;
    } else if (p.state === PlayerState.DRAWING && !wasInSafe && isInSafe) {
      this.addTrailTurn(p);
      this.completeCut(p, events);
      p.trail = [];
      p.state = PlayerState.MOVING_SAFE;
    }
  }

  private handlePlayerBoundary(p: ServerPlayer, events: GameEvent[]): void {
    let hitBoundary = false;

    if (p.x < 0) { p.x = 0; if (p.vx < 0) { p.vx = 0; hitBoundary = true; } }
    if (p.x > GAME_W) { p.x = GAME_W; if (p.vx > 0) { p.vx = 0; hitBoundary = true; } }
    if (p.y < 0) { p.y = 0; if (p.vy < 0) { p.vy = 0; hitBoundary = true; } }
    if (p.y > GAME_H) { p.y = GAME_H; if (p.vy > 0) { p.vy = 0; hitBoundary = true; } }

    if (hitBoundary && p.state === PlayerState.DRAWING) {
      this.addTrailTurn(p);
      this.completeCut(p, events);
      p.trail = [];
      p.state = PlayerState.MOVING_SAFE;
    }

    if (p.vx === 0 && p.vy === 0 && p.state === PlayerState.MOVING_SAFE) {
      p.state = PlayerState.IDLE;
    }
  }

  private addTrailTurn(p: ServerPlayer): void {
    const last = p.trail.length > 0 ? p.trail[p.trail.length - 1] : null;
    if (!last || dist(last.x, last.y, p.x, p.y) > 0.5) {
      p.trail.push({ x: p.x, y: p.y });
    }
  }

  private getTrailWithCurrent(p: ServerPlayer): Point[] {
    const arr = p.trail.slice();
    const last = arr.length > 0 ? arr[arr.length - 1] : null;
    if (!last || dist(last.x, last.y, p.x, p.y) > 0.5) {
      arr.push({ x: p.x, y: p.y });
    }
    return arr;
  }

  private isPointSafe(x: number, y: number): boolean {
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || ix >= GAME_W || iy < 0 || iy >= GAME_H) return true;
    return this.grid[iy * GAME_W + ix] !== 0;
  }

  private isPointSafeForPlayer(x: number, y: number, playerId: number): boolean {
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || ix >= GAME_W || iy < 0 || iy >= GAME_H) return true;
    const owner = this.grid[iy * GAME_W + ix];
    return owner === 255 || owner === (playerId + 1);
  }

  private getGridOwner(x: number, y: number): number {
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || ix >= GAME_W || iy < 0 || iy >= GAME_H) return 255;
    return this.grid[iy * GAME_W + ix];
  }

  private updateEnemies(dt: number): void {
    for (const enemy of this.enemies) {
      const steps = 3;
      for (let s = 0; s < steps; s++) {
        const stepDt = dt / steps;
        const testX = enemy.x + enemy.vx * stepDt;
        const testY = enemy.y + enemy.vy * stepDt;

        const hitX = this.isPointSafe(testX + (enemy.vx > 0 ? enemy.radius : -enemy.radius), enemy.y);
        const hitY = this.isPointSafe(enemy.x, testY + (enemy.vy > 0 ? enemy.radius : -enemy.radius));

        if (hitX) enemy.vx = -enemy.vx;
        if (hitY) enemy.vy = -enemy.vy;

        enemy.x += enemy.vx * stepDt;
        enemy.y += enemy.vy * stepDt;
      }

      enemy.x = clamp(enemy.x, BORDER + enemy.radius, GAME_W - BORDER - enemy.radius);
      enemy.y = clamp(enemy.y, BORDER + enemy.radius, GAME_H - BORDER - enemy.radius);

      if (this.isPointSafe(enemy.x, enemy.y)) {
        this.pushEnemyOutOfSafe(enemy);
      }
    }
  }

  private pushEnemyOutOfSafe(enemy: ServerEnemy): void {
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
      for (let d = 1; d < 40; d += 2) {
        const tx = enemy.x + Math.cos(angle) * d;
        const ty = enemy.y + Math.sin(angle) * d;
        if (tx > BORDER + enemy.radius && tx < GAME_W - BORDER - enemy.radius &&
          ty > BORDER + enemy.radius && ty < GAME_H - BORDER - enemy.radius &&
          !this.isPointSafe(tx, ty)) {
          enemy.x = tx;
          enemy.y = ty;
          return;
        }
      }
    }
  }

  private isPlayerDead(p: ServerPlayer): boolean {
    return (p.state as number) === (PlayerState.DEAD as number);
  }

  private checkTrailCollisions(events: GameEvent[]): void {
    for (const p of this.players.values()) {
      if (p.state !== PlayerState.DRAWING) continue;

      const trail = this.getTrailWithCurrent(p);

      for (const enemy of this.enemies) {
        if (dist(enemy.x, enemy.y, p.x, p.y) < enemy.radius + PLAYER_RADIUS) {
          this.killPlayer(p, -2, 'hit by enemy', events);
          break;
        }
        for (let i = 0; i < trail.length - 1; i++) {
          const d2 = pointToSegDistSq(enemy.x, enemy.y, trail[i].x, trail[i].y, trail[i + 1].x, trail[i + 1].y);
          if (d2 < enemy.radius * enemy.radius) {
            this.killPlayer(p, -2, 'trail hit by enemy', events);
            break;
          }
        }
        if (this.isPlayerDead(p)) break;
      }
      if (this.isPlayerDead(p)) continue;

      if (trail.length >= 4) {
        const last = trail.length - 1;
        for (let i = 0; i < last - 2; i++) {
          if (segmentsIntersect(
            trail[last - 1].x, trail[last - 1].y, trail[last].x, trail[last].y,
            trail[i].x, trail[i].y, trail[i + 1].x, trail[i + 1].y,
          )) {
            this.killPlayer(p, -1, 'self-intersection', events);
            break;
          }
        }
      }
      if (this.isPlayerDead(p)) continue;

      for (const other of this.players.values()) {
        if (other.id === p.id || this.isPlayerDead(other)) continue;

        if (!this.isPlayerDead(other) && !this.isPlayerDead(p)) {
          for (let i = 0; i < trail.length - 1; i++) {
            const d2 = pointToSegDistSq(other.x, other.y, trail[i].x, trail[i].y, trail[i + 1].x, trail[i + 1].y);
            if (d2 < PLAYER_RADIUS * PLAYER_RADIUS * 4) {
              this.killPlayer(p, other.id, `trail cut by ${other.name}`, events);
              break;
            }
          }
        }

        if (other.state === PlayerState.DRAWING && !this.isPlayerDead(other)) {
          const otherTrail = this.getTrailWithCurrent(other);
          for (let i = 0; i < otherTrail.length - 1; i++) {
            const d2 = pointToSegDistSq(p.x, p.y, otherTrail[i].x, otherTrail[i].y, otherTrail[i + 1].x, otherTrail[i + 1].y);
            if (d2 < PLAYER_RADIUS * PLAYER_RADIUS * 4) {
              this.killPlayer(other, p.id, `trail cut by ${p.name}`, events);
              break;
            }
          }
        }
      }
    }
  }

  private killPlayer(p: ServerPlayer, killerId: number, reason: string, events: GameEvent[]): void {
    p.state = PlayerState.DEAD;
    p.vx = 0;
    p.vy = 0;
    p.trail = [];
    p.lives--;
    p.respawnTimer = 2;

    events.push({
      type: 'player_died',
      playerId: p.id,
      killerId,
      reason,
    });
  }

  private respawnPlayer(p: ServerPlayer): void {
    const spawn = this.spawnPoints[p.id % this.spawnPoints.length];
    p.x = spawn.x;
    p.y = spawn.y;
    p.vx = 0;
    p.vy = 0;
    p.dir = Direction.NONE;
    p.state = PlayerState.IDLE;
    p.trail = [];
    p.respawnTimer = 0;
  }

  // flood-fill 切割算法 (像素级, 同原版)
  private completeCut(p: ServerPlayer, events: GameEvent[]): void {
    const trail = this.getTrailWithCurrent(p);
    if (trail.length < 2) return;

    const ownerId = p.id + 1;

    // 构建临时grid：自己的领地+边界 = 障碍(1)，其余 = 可占领(0)
    const cutGrid = new Uint8Array(GAME_W * GAME_H);
    for (let i = 0; i < GAME_W * GAME_H; i++) {
      const v = this.grid[i];
      cutGrid[i] = (v === ownerId || v === 255) ? 1 : 0;
    }

    // trail 线画到 cutGrid（作为分割障碍），不直接写 this.grid
    for (let i = 0; i < trail.length - 1; i++) {
      this.rasterizeLineToGrid(cutGrid, trail[i].x, trail[i].y, trail[i + 1].x, trail[i + 1].y, 1);
    }

    const regionMap = new Int32Array(GAME_W * GAME_H).fill(-1);
    const regions: { id: number; count: number; hasEnemy: boolean; hasOtherPlayer: boolean }[] = [];

    for (let y = 0; y < GAME_H; y++) {
      for (let x = 0; x < GAME_W; x++) {
        const pos = y * GAME_W + x;
        if (cutGrid[pos] === 0 && regionMap[pos] === -1) {
          const regionId = regions.length;
          const count = this.floodFill(cutGrid, regionMap, x, y, regionId);

          let hasEnemy = false;
          for (const enemy of this.enemies) {
            const ex = clamp(Math.round(enemy.x), 0, GAME_W - 1);
            const ey = clamp(Math.round(enemy.y), 0, GAME_H - 1);
            if (regionMap[ey * GAME_W + ex] === regionId) { hasEnemy = true; break; }
          }

          let hasOtherPlayer = false;
          for (const other of this.players.values()) {
            if (other.id === p.id || other.state === PlayerState.DEAD) continue;
            const ox = clamp(Math.round(other.x), 0, GAME_W - 1);
            const oy = clamp(Math.round(other.y), 0, GAME_H - 1);
            if (regionMap[oy * GAME_W + ox] === regionId) { hasOtherPlayer = true; break; }
          }

          regions.push({ id: regionId, count, hasEnemy, hasOtherPlayer });
        }
      }
    }

    if (regions.length < 2) return;

    // 找到有敌人/其他玩家的最大区域，其余归当前玩家
    const keepRegions = regions.filter(r => r.hasEnemy || r.hasOtherPlayer);
    const captureSet = new Set<number>();

    if (keepRegions.length > 0) {
      let maxRegion = keepRegions[0];
      for (const r of keepRegions) {
        if (r.count > maxRegion.count) maxRegion = r;
      }
      for (const r of regions) {
        if (r.id !== maxRegion.id) captureSet.add(r.id);
      }
    } else {
      let smallest = regions[0];
      for (const r of regions) {
        if (r.count < smallest.count) smallest = r;
      }
      captureSet.add(smallest.id);
    }

    let capturedCount = 0;
    for (let i = 0; i < GAME_W * GAME_H; i++) {
      if (regionMap[i] >= 0 && captureSet.has(regionMap[i])) {
        this.grid[i] = ownerId;
        const x = i % GAME_W;
        const y = (i / GAME_W) | 0;
        this.changedPixels.push(x, y, ownerId);
        capturedCount++;
      }
    }

    if (capturedCount < 10) return;

    for (let i = 0; i < trail.length - 1; i++) {
      this.rasterizeLine(trail[i].x, trail[i].y, trail[i + 1].x, trail[i + 1].y, ownerId);
    }

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const en = this.enemies[i];
      const ex = clamp(Math.round(en.x), 0, GAME_W - 1);
      const ey = clamp(Math.round(en.y), 0, GAME_H - 1);
      if (regionMap[ey * GAME_W + ex] >= 0 && captureSet.has(regionMap[ey * GAME_W + ex])) {
        this.enemies.splice(i, 1);
      }
    }

    // 把被圈住的其他玩家也推出去
    for (const other of this.players.values()) {
      if (other.id === p.id) continue;
      const ox = clamp(Math.round(other.x), 0, GAME_W - 1);
      const oy = clamp(Math.round(other.y), 0, GAME_H - 1);
      if (this.grid[oy * GAME_W + ox] === ownerId && other.state !== PlayerState.DEAD) {
        this.respawnPlayer(other);
      }
    }

    events.push({
      type: 'territory_claimed',
      playerId: p.id,
      pixelsClaimed: capturedCount,
    });
  }

  private rasterizeLineToGrid(targetGrid: Uint8Array, x0: number, y0: number, x1: number, y1: number, value: number): void {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let ix = Math.round(x0), iy = Math.round(y0);
    const ex = Math.round(x1), ey = Math.round(y1);
    let err = dx - dy;

    const maxSteps = Math.ceil(dx + dy) + 2;
    for (let step = 0; step < maxSteps; step++) {
      if (ix >= 0 && ix < GAME_W && iy >= 0 && iy < GAME_H) {
        targetGrid[iy * GAME_W + ix] = value;
      }
      if (ix === ex && iy === ey) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; ix += sx; }
      if (e2 < dx) { err += dx; iy += sy; }
    }
  }

  private rasterizeLine(x0: number, y0: number, x1: number, y1: number, value: number): void {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let ix = Math.round(x0), iy = Math.round(y0);
    const ex = Math.round(x1), ey = Math.round(y1);
    let err = dx - dy;

    const maxSteps = Math.ceil(dx + dy) + 2;
    for (let step = 0; step < maxSteps; step++) {
      if (ix >= 0 && ix < GAME_W && iy >= 0 && iy < GAME_H) {
        const pos = iy * GAME_W + ix;
        if (this.grid[pos] === 0) {
          this.grid[pos] = value;
          this.changedPixels.push(ix, iy, value);
        }
      }
      if (ix === ex && iy === ey) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; ix += sx; }
      if (e2 < dx) { err += dx; iy += sy; }
    }
  }

  private floodFill(grid: Uint8Array, regionMap: Int32Array, startX: number, startY: number, regionId: number): number {
    let count = 0;
    const stack: number[] = [startX, startY];
    while (stack.length > 0) {
      const cy = stack.pop()!;
      const cx = stack.pop()!;
      if (cx < 0 || cx >= GAME_W || cy < 0 || cy >= GAME_H) continue;
      const pos = cy * GAME_W + cx;
      if (grid[pos] !== 0 || regionMap[pos] !== -1) continue;
      regionMap[pos] = regionId;
      count++;
      stack.push(cx + 1, cy);
      stack.push(cx - 1, cy);
      stack.push(cx, cy + 1);
      stack.push(cx, cy - 1);
    }
    return count;
  }

  private updateAreaPercents(events: GameEvent[]): void {
    const totalPlayableArea = (GAME_W - 2 * BORDER) * (GAME_H - 2 * BORDER);
    const counts = new Map<number, number>();

    for (let y = BORDER; y < GAME_H - BORDER; y++) {
      for (let x = BORDER; x < GAME_W - BORDER; x++) {
        const owner = this.grid[y * GAME_W + x];
        if (owner > 0 && owner < 255) {
          counts.set(owner, (counts.get(owner) || 0) + 1);
        }
      }
    }

    for (const p of this.players.values()) {
      const ownerId = p.id + 1;
      const cnt = counts.get(ownerId) || 0;
      const prevPercent = p.areaPercent;
      p.areaPercent = Math.round((cnt / totalPlayableArea) * 100 * 10) / 10;

      if (prevPercent > 0 && p.areaPercent === 0) {
        events.push({
          type: 'player_eliminated',
          playerId: p.id,
          reason: 'territory lost',
        });
      }
    }
  }

  private checkWinCondition(events: GameEvent[]): void {
    for (const p of this.players.values()) {
      if (p.areaPercent >= WIN_PERCENT) {
        this.gameOver = true;
        this.winnerId = p.id;
        events.push({
          type: 'game_over',
          playerId: p.id,
          winnerId: p.id,
          winnerName: p.name,
        });
        return;
      }
    }
  }

  getRankings(): RankEntry[] {
    const entries: RankEntry[] = [];
    for (const p of this.players.values()) {
      entries.push({
        id: p.id,
        name: p.name,
        color: p.color,
        percent: p.areaPercent,
      });
    }
    entries.sort((a, b) => b.percent - a.percent);
    return entries;
  }

  getChangedPixels(): number[] {
    return this.changedPixels;
  }

  getPlayerInfo(p: ServerPlayer): PlayerInfo {
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      dir: p.dir,
      state: p.state,
      trail: p.trail.map(t => ({ x: Math.round(t.x), y: Math.round(t.y) })),
      areaPercent: p.areaPercent,
      isBot: p.isBot,
      lives: p.lives,
    };
  }

  getAllPlayerInfos(): PlayerInfo[] {
    return Array.from(this.players.values()).map(p => this.getPlayerInfo(p));
  }

  getEnemyInfos(): EnemyInfo[] {
    return this.enemies.map(e => ({
      x: Math.round(e.x * 10) / 10,
      y: Math.round(e.y * 10) / 10,
      vx: Math.round(e.vx * 10) / 10,
      vy: Math.round(e.vy * 10) / 10,
    }));
  }

  encodeGrid(): string {
    const bytes: number[] = [];
    for (let i = 0; i < this.grid.length; i += 3) {
      const b1 = this.grid[i] || 0;
      const b2 = this.grid[i + 1] || 0;
      const b3 = this.grid[i + 2] || 0;
      bytes.push(b1, b2, b3);
    }
    let binary = '';
    for (let i = 0; i < this.grid.length; i++) {
      binary += String.fromCharCode(this.grid[i]);
    }
    return btoa(binary);
  }
}

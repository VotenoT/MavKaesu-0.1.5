import { DurableObject } from "cloudflare:workers";

const MAP = { width: 960, height: 540 };
const TICK_MS = 100;          // 10 ticks/s: bem mais leve para Workers grátis
const STATE_MS = 250;         // 4 estados/s: reduz tráfego e travamentos
const MAX_PROJECTILES = 24;
const MAX_MINIONS = 8;
const MAX_AREAS = 8;
const MAX_PLAYERS = 4;
const ROOM_CODE_RE = /^[A-Z0-9_-]{3,18}$/;

const HEROES = {
  votenot: { label: "VotenoT", role: "Controle com chamas", hp: 125, speed: 165, color: "#ff7a1a", cds: { basic: 520, skill1: 5400, skill2: 8500, ult: 24000 } },
  astro:   { label: "Astro",   role: "Suporte com portais", hp: 106, speed: 176, color: "#b86bff", cds: { basic: 620, skill1: 8000, skill2: 10500, ult: 26000 } },
  akane:   { label: "Akane",   role: "Ataca-cura com sangue", hp: 112, speed: 166, color: "#ff2f61", cds: { basic: 620, skill1: 7800, skill2: 9000, ult: 27000 } },
  shadow:  { label: "Shadow",  role: "Curta distância com espada", hp: 116, speed: 190, color: "#8d97ff", cds: { basic: 470, skill1: 6500, skill2: 11500, ult: 25000 } }
};

const CORE_MAX = 520;
const TOWER_MAX = 250;

const now = () => Date.now();
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const enemyTeam = (team) => team === "blue" ? "red" : "blue";
const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

function nrm(x, y) {
  const d = Math.hypot(x, y);
  if (!Number.isFinite(d) || d < 0.01) return { x: 1, y: 0 };
  return { x: x / d, y: y / d };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function text(data, status = 200) {
  return new Response(data, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function cleanRoomCode(code) {
  return String(code || "").normalize("NFKC").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 18);
}

function cleanName(name) {
  const safe = String(name || "Jogador").normalize("NFKC").replace(/[^\p{L}\p{N}\s_.-]/gu, "").trim().slice(0, 18);
  return safe || "Jogador";
}

function safeHero(hero) {
  return HEROES[hero] ? hero : "votenot";
}

function rid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function spawnPoint(team) {
  return team === "blue" ? { x: 126, y: 270 } : { x: 834, y: 270 };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, engine: "Cloudflare Workers + Durable Objects", build: "MAVKaesu Arena 0.1.5 Ultra Stable", tickMs: TICK_MS, stateMs: STATE_MS });
    }

    if (url.pathname.startsWith("/ws/")) {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return text("Use WebSocket neste endpoint.", 426);
      const code = cleanRoomCode(url.pathname.split("/").pop());
      if (!ROOM_CODE_RE.test(code)) return json({ ok: false, error: "Código de sala inválido." }, 400);
      const id = env.MATCHROOM.idFromName(code);
      return env.MATCHROOM.get(id).fetch(request);
    }

    if (url.pathname.startsWith("/room/") && url.pathname.endsWith("/status")) {
      const code = cleanRoomCode(url.pathname.split("/")[2]);
      if (!ROOM_CODE_RE.test(code)) return json({ ok: false, error: "Sala inválida." }, 400);
      const id = env.MATCHROOM.idFromName(code);
      return env.MATCHROOM.get(id).fetch(request);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return text("Assets não configurados.", 500);
  }
};

export class MatchRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.roomCode = "ROOM";
    this.sessions = new Map();       // ws -> playerId
    this.players = new Map();        // id -> player
    this.projectiles = [];
    this.minions = [];
    this.areas = [];
    this.phase = "lobby";
    this.winner = null;
    this.cores = this.makeCores();
    this.towers = this.makeTowers();
    this.lastTick = now();
    this.lastSpawn = now();
    this.seq = 0;
    this.tickTimer = null;
    this.stateTimer = null;
  }

  makeCores() {
    return {
      blue: { id: "core-blue", kind: "core", team: "blue", x: 70, y: 270, r: 42, hp: CORE_MAX, maxHp: CORE_MAX, alive: true },
      red: { id: "core-red", kind: "core", team: "red", x: 890, y: 270, r: 42, hp: CORE_MAX, maxHp: CORE_MAX, alive: true }
    };
  }

  makeTowers() {
    return [
      { id: "tower-blue", kind: "tower", team: "blue", x: 245, y: 270, r: 30, hp: TOWER_MAX, maxHp: TOWER_MAX, alive: true, cd: 0, range: 158 },
      { id: "tower-red", kind: "tower", team: "red", x: 715, y: 270, r: 30, hp: TOWER_MAX, maxHp: TOWER_MAX, alive: true, cd: 0, range: 158 }
    ];
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/room/") && url.pathname.endsWith("/status")) {
      return json({ ok: true, room: this.roomCode, phase: this.phase, winner: this.winner, sockets: this.sessions.size, players: this.players.size, counts: { projectiles: this.projectiles.length, minions: this.minions.length, areas: this.areas.length }, seq: this.seq });
    }

    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return text("Sala ativa. Conecte em /ws/CODIGO.", 426);
    }

    this.roomCode = cleanRoomCode(url.pathname.split("/").pop()) || this.roomCode;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    if (this.players.size >= MAX_PLAYERS) {
      server.send(JSON.stringify({ type: "error", text: "Sala cheia." }));
      server.close(1008, "sala cheia");
      return new Response(null, { status: 101, webSocket: client });
    }

    const player = this.createPlayer(url.searchParams);
    this.sessions.set(server, player.id);
    this.players.set(player.id, player);

    server.addEventListener("message", (event) => this.onMessage(server, event.data));
    server.addEventListener("close", () => this.disconnect(server));
    server.addEventListener("error", () => this.disconnect(server));

    this.safeSend(server, { type: "welcome", id: player.id, room: this.roomCode, state: this.buildState() });
    this.broadcastSystem(`${player.name} entrou no time ${player.team === "blue" ? "Azul" : "Vermelho"}.`);
    this.startLoops();

    return new Response(null, { status: 101, webSocket: client });
  }

  createPlayer(params) {
    const team = this.countTeam("blue") <= this.countTeam("red") ? "blue" : "red";
    const hero = safeHero(params.get("hero"));
    const def = HEROES[hero];
    const sp = spawnPoint(team);
    return {
      id: rid("p"), name: cleanName(params.get("name")), hero, heroLabel: def.label, team,
      x: sp.x, y: sp.y, r: 18, facing: team === "blue" ? 1 : -1,
      hp: def.hp, maxHp: def.hp, shield: 0, dead: false, respawnAt: 0, ready: false,
      inputX: 0, inputY: 0, cds: { basic: 0, skill1: 0, skill2: 0, ult: 0 },
      speedBoostUntil: 0, stealthUntil: 0, lastSeen: now()
    };
  }

  countTeam(team) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n++;
    return n;
  }

  startLoops() {
    if (!this.tickTimer) {
      this.lastTick = now();
      this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    }
    if (!this.stateTimer) this.stateTimer = setInterval(() => this.broadcastState(), STATE_MS);
  }

  stopLoopsIfEmpty() {
    if (this.sessions.size > 0) return;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.tickTimer = null;
    this.stateTimer = null;
    this.resetRoom();
  }

  resetRoom() {
    this.players.clear();
    this.projectiles = [];
    this.minions = [];
    this.areas = [];
    this.phase = "lobby";
    this.winner = null;
    this.cores = this.makeCores();
    this.towers = this.makeTowers();
    this.lastSpawn = now();
    this.seq = 0;
  }

  disconnect(ws) {
    const id = this.sessions.get(ws);
    if (id) {
      const p = this.players.get(id);
      this.sessions.delete(ws);
      this.players.delete(id);
      if (p) this.broadcastSystem(`${p.name} saiu.`);
    }
    this.stopLoopsIfEmpty();
  }

  onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const id = this.sessions.get(ws);
    const p = this.players.get(id);
    if (!p) return;
    p.lastSeen = now();

    if (msg.type === "input") {
      const x = clamp(Number(msg.x || 0), -1, 1);
      const y = clamp(Number(msg.y || 0), -1, 1);
      const len = Math.hypot(x, y);
      p.inputX = len > 1 ? x / len : x;
      p.inputY = len > 1 ? y / len : y;
      if (Math.abs(p.inputX) > 0.08) p.facing = p.inputX > 0 ? 1 : -1;
      return;
    }

    if (msg.type === "choose") {
      if (this.phase !== "lobby") return;
      const hero = safeHero(msg.hero);
      const def = HEROES[hero];
      p.hero = hero; p.heroLabel = def.label; p.maxHp = def.hp; p.hp = Math.min(p.hp, p.maxHp);
      this.broadcastSystem(`${p.name} escolheu ${p.heroLabel}.`);
      return;
    }

    if (msg.type === "ready") {
      p.ready = true;
      this.maybeStart();
      this.broadcastSystem(`${p.name} está pronto.`);
      return;
    }

    if (msg.type === "attack") {
      if (this.phase !== "playing") this.phase = "playing"; // permite testar sozinho
      const slot = ["basic", "skill1", "skill2", "ult"].includes(msg.slot) ? msg.slot : "basic";
      const dir = this.smartAim(p, nrm(Number(msg.dx || 0), Number(msg.dy || 0)));
      this.useAbility(p, slot, dir);
      return;
    }

    if (msg.type === "ping") this.safeSend(ws, { type: "pong", t: msg.t, serverTime: now() });
  }

  maybeStart() {
    let ready = 0;
    for (const p of this.players.values()) if (p.ready) ready++;
    if (this.players.size >= 2 && ready >= 2 && this.phase === "lobby") {
      this.phase = "playing";
      this.broadcastSystem("Partida iniciada. Destrua o núcleo inimigo!");
    }
  }

  tick() {
    const t = now();
    const dt = Math.min(0.12, Math.max(0.01, (t - this.lastTick) / 1000));
    this.lastTick = t;
    if (this.winner) return;
    this.updatePlayers(t, dt);
    if (this.phase === "playing") {
      this.spawnMinions(t);
      this.updateMinions(t, dt);
      this.updateTowers(t);
      this.updateProjectiles(t, dt);
      this.updateAreas(t);
      this.cleanup();
      this.checkVictory();
    }
  }

  updatePlayers(t, dt) {
    for (const p of this.players.values()) {
      if (p.dead) {
        if (t >= p.respawnAt && !this.winner) {
          const sp = spawnPoint(p.team);
          p.x = sp.x; p.y = sp.y; p.hp = p.maxHp; p.shield = 0; p.dead = false;
        }
        continue;
      }
      const def = HEROES[p.hero];
      const speed = def.speed * (t < p.speedBoostUntil ? 1.28 : 1);
      p.x = clamp(p.x + p.inputX * speed * dt, 38, MAP.width - 38);
      p.y = clamp(p.y + p.inputY * speed * dt, 72, MAP.height - 72);
      if (p.shield > 0) p.shield = Math.max(0, p.shield - 5 * dt);
    }
  }

  spawnMinions(t) {
    if (t - this.lastSpawn < 8000 || this.minions.length >= MAX_MINIONS) return;
    this.lastSpawn = t;
    for (const team of ["blue", "red"]) {
      if (this.minions.length >= MAX_MINIONS) break;
      const x = team === "blue" ? 116 : 844;
      this.minions.push({ id: rid("m"), kind: "minion", team, x, y: 270, r: 13, hp: 46, maxHp: 46, alive: true, cd: 0 });
    }
  }

  updateMinions(t, dt) {
    for (const m of this.minions) {
      if (!m.alive) continue;
      const target = this.findNearestEnemy(m, enemyTeam(m.team), 42, true);
      if (target && t >= m.cd) {
        this.damageTarget(target, 7);
        m.cd = t + 1200;
      } else if (!target) {
        const dir = m.team === "blue" ? 1 : -1;
        m.x += dir * 46 * dt;
        m.y += (270 - m.y) * 0.8 * dt;
      }
    }
  }

  updateTowers(t) {
    for (const tower of this.towers) {
      if (!tower.alive || t < tower.cd) continue;
      const target = this.findNearestEnemy(tower, enemyTeam(tower.team), tower.range, false);
      if (!target) continue;
      const dir = nrm(target.x - tower.x, target.y - tower.y);
      this.spawnProjectile(tower.team, tower.id, tower.x, tower.y, dir, 275, 16, 8, 1300, "tower", tower.team === "blue" ? "#15e5ff" : "#ff4665");
      tower.cd = t + 2100;
    }
  }

  updateProjectiles(t, dt) {
    for (const pr of this.projectiles) {
      if (!pr.alive) continue;
      pr.life -= dt * 1000;
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      if (pr.life <= 0 || pr.x < -80 || pr.x > MAP.width + 80 || pr.y < -80 || pr.y > MAP.height + 80) { pr.alive = false; continue; }
      const target = this.findHit(pr);
      if (target) {
        this.damageTarget(target, pr.damage);
        if (pr.healOwner) {
          const owner = this.players.get(pr.owner);
          if (owner && !owner.dead) owner.hp = Math.min(owner.maxHp, owner.hp + pr.healOwner);
        }
        pr.alive = false;
      }
    }
  }

  updateAreas(t) {
    for (const a of this.areas) {
      if (!a.alive) continue;
      if (t >= a.expires) { a.alive = false; continue; }
      if (t < a.next) continue;
      this.applyArea(a);
      a.next = t + a.pulseMs;
    }
  }

  cleanup() {
    this.projectiles = this.projectiles.filter((x) => x.alive).slice(-MAX_PROJECTILES);
    this.minions = this.minions.filter((x) => x.alive && x.hp > 0).slice(-MAX_MINIONS);
    this.areas = this.areas.filter((x) => x.alive).slice(-MAX_AREAS);
  }

  checkVictory() {
    if (this.cores.blue.hp <= 0 && !this.winner) { this.winner = "red"; this.phase = "ended"; this.broadcast({ type: "gameOver", winner: "red", text: "Time Vermelho venceu!" }); }
    if (this.cores.red.hp <= 0 && !this.winner) { this.winner = "blue"; this.phase = "ended"; this.broadcast({ type: "gameOver", winner: "blue", text: "Time Azul venceu!" }); }
  }

  smartAim(p, dir) {
    if (Math.hypot(dir.x, dir.y) > 0.25) return dir;
    const target = this.findNearestEnemy(p, enemyTeam(p.team), 320, true);
    if (target) return nrm(target.x - p.x, target.y - p.y);
    return { x: p.facing || (p.team === "blue" ? 1 : -1), y: 0 };
  }

  useAbility(p, slot, dir) {
    if (!p || p.dead || this.winner) return;
    const t = now();
    const hero = HEROES[p.hero];
    if (t < p.cds[slot]) return;
    p.facing = dir.x >= 0 ? 1 : -1;
    if (p.hero === "votenot") this.votenot(p, slot, dir);
    else if (p.hero === "astro") this.astro(p, slot, dir);
    else if (p.hero === "akane") this.akane(p, slot, dir);
    else this.shadow(p, slot, dir);
    p.cds[slot] = t + (hero.cds[slot] || 1000);
  }

  votenot(p, slot, dir) {
    if (slot === "basic") return this.spawnProjectile(p.team, p.id, p.x + dir.x * 22, p.y + dir.y * 22, dir, 320, 12, 9, 950, "flame", "#ff8a22");
    if (slot === "skill1") return this.spawnProjectile(p.team, p.id, p.x, p.y, dir, 370, 20, 13, 900, "flame-wave", "#ffc14d");
    if (slot === "skill2") { p.shield = Math.min(42, p.shield + 30); return this.addArea(p.team, p.x, p.y, 60, 5, 0, 1700, 550, "fire-ring", "#ff7a1a"); }
    return this.addArea(p.team, p.x + dir.x * 122, p.y + dir.y * 122, 90, 12, 0, 2600, 700, "cyan-eye", "#23e7ff");
  }

  astro(p, slot, dir) {
    if (slot === "basic") return this.spawnProjectile(p.team, p.id, p.x + dir.x * 20, p.y + dir.y * 20, dir, 300, 10, 8, 1050, "star", "#c084fc");
    if (slot === "skill1") { p.x = clamp(p.x + dir.x * 105, 40, MAP.width - 40); p.y = clamp(p.y + dir.y * 105, 72, MAP.height - 72); return this.addArea(p.team, p.x, p.y, 54, 0, 7, 1200, 600, "portal-heal", "#b86bff"); }
    if (slot === "skill2") return this.addArea(p.team, p.x + dir.x * 90, p.y + dir.y * 90, 74, 5, 8, 2600, 700, "portal-field", "#9b5cff");
    return this.spawnProjectile(p.team, p.id, p.x, p.y, dir, 260, 28, 18, 1450, "comet", "#e9c8ff");
  }

  akane(p, slot, dir) {
    if (slot === "basic") return this.spawnProjectile(p.team, p.id, p.x + dir.x * 18, p.y + dir.y * 18, dir, 325, 12, 8, 980, "blood", "#ff2f61", 4);
    if (slot === "skill1") return this.addArea(p.team, p.x + dir.x * 70, p.y + dir.y * 70, 62, 7, 10, 1550, 650, "blood-pact", "#ff2f61");
    if (slot === "skill2") { this.damageCircle(p.x + dir.x * 60, p.y + dir.y * 60, 56, p.team, 21); p.hp = Math.min(p.maxHp, p.hp + 7); return; }
    return this.addArea(p.team, p.x + dir.x * 105, p.y + dir.y * 105, 92, 12, 8, 2600, 700, "red-tide", "#b00034");
  }

  shadow(p, slot, dir) {
    if (slot === "basic") return this.damageCircle(p.x + dir.x * 42, p.y + dir.y * 42, 45, p.team, 14);
    if (slot === "skill1") { p.x = clamp(p.x + dir.x * 88, 40, MAP.width - 40); p.y = clamp(p.y + dir.y * 88, 72, MAP.height - 72); return this.damageCircle(p.x + dir.x * 32, p.y + dir.y * 32, 58, p.team, 22); }
    if (slot === "skill2") { p.speedBoostUntil = now() + 2300; p.stealthUntil = now() + 2300; p.shield = Math.min(32, p.shield + 16); return; }
    return this.spawnProjectile(p.team, p.id, p.x + dir.x * 24, p.y + dir.y * 24, dir, 440, 30, 16, 760, "moon", "#cbd2ff");
  }

  spawnProjectile(team, owner, x, y, dir, speed, damage, r, life, kind, color, healOwner = 0) {
    if (this.projectiles.length >= MAX_PROJECTILES) this.projectiles.shift();
    const v = nrm(dir.x, dir.y);
    this.projectiles.push({ id: rid("pr"), kind, team, owner, x, y, vx: v.x * speed, vy: v.y * speed, damage, r, life, color, healOwner, alive: true });
  }

  addArea(team, x, y, r, damage, heal, duration, pulseMs, kind, color) {
    if (this.areas.length >= MAX_AREAS) this.areas.shift();
    const t = now();
    this.areas.push({ id: rid("a"), kind, team, x: clamp(x, 36, MAP.width - 36), y: clamp(y, 70, MAP.height - 70), r, damage, heal, expires: t + duration, next: t, pulseMs, color, alive: true });
  }

  applyArea(a) {
    for (const p of this.players.values()) {
      if (p.dead) continue;
      if (d2(a, p) <= (a.r + p.r) ** 2) {
        if (p.team === a.team && a.heal) p.hp = Math.min(p.maxHp, p.hp + a.heal);
        if (p.team !== a.team && a.damage) this.damageTarget(p, a.damage);
      }
    }
    for (const m of this.minions) if (m.alive && m.team !== a.team && a.damage && d2(a, m) <= (a.r + m.r) ** 2) this.damageTarget(m, a.damage);
    for (const tw of this.towers) if (tw.alive && tw.team !== a.team && a.damage && d2(a, tw) <= (a.r + tw.r) ** 2) this.damageTarget(tw, a.damage);
    const core = this.cores[enemyTeam(a.team)];
    if (core.alive && a.damage && d2(a, core) <= (a.r + core.r) ** 2) this.damageTarget(core, a.damage);
  }

  damageCircle(x, y, r, sourceTeam, amount) {
    const area = { x, y, r, team: sourceTeam };
    for (const p of this.players.values()) if (!p.dead && p.team !== sourceTeam && d2(area, p) <= (r + p.r) ** 2) this.damageTarget(p, amount);
    for (const m of this.minions) if (m.alive && m.team !== sourceTeam && d2(area, m) <= (r + m.r) ** 2) this.damageTarget(m, amount);
    for (const tw of this.towers) if (tw.alive && tw.team !== sourceTeam && d2(area, tw) <= (r + tw.r) ** 2) this.damageTarget(tw, amount);
    const core = this.cores[enemyTeam(sourceTeam)];
    if (core.alive && d2(area, core) <= (r + core.r) ** 2) this.damageTarget(core, amount);
  }

  findHit(pr) {
    for (const p of this.players.values()) if (!p.dead && p.team !== pr.team && d2(pr, p) <= (pr.r + p.r) ** 2) return p;
    for (const m of this.minions) if (m.alive && m.team !== pr.team && d2(pr, m) <= (pr.r + m.r) ** 2) return m;
    for (const tw of this.towers) if (tw.alive && tw.team !== pr.team && d2(pr, tw) <= (pr.r + tw.r) ** 2) return tw;
    const core = this.cores[enemyTeam(pr.team)];
    if (core.alive && d2(pr, core) <= (pr.r + core.r) ** 2) return core;
    return null;
  }

  findNearestEnemy(origin, team, range, includeCore) {
    let best = null, bestD = range * range;
    const consider = (obj) => { const dd = d2(origin, obj); if (dd < bestD) { bestD = dd; best = obj; } };
    for (const p of this.players.values()) if (!p.dead && p.team === team) consider(p);
    for (const m of this.minions) if (m.alive && m.team === team) consider(m);
    for (const tw of this.towers) if (tw.alive && tw.team === team) consider(tw);
    if (includeCore) { const c = this.cores[team]; if (c.alive) consider(c); }
    return best;
  }

  damageTarget(target, amount) {
    if (!target || !target.alive && target.kind !== undefined && target.kind !== "player") return;
    if (target.id && this.players.has(target.id)) {
      const p = this.players.get(target.id);
      if (p.dead) return;
      let dmg = amount;
      if (p.shield > 0) { const used = Math.min(p.shield, dmg); p.shield -= used; dmg -= used; }
      p.hp -= dmg;
      if (p.hp <= 0) { p.hp = 0; p.dead = true; p.respawnAt = now() + 4500; }
      return;
    }
    target.hp -= amount;
    if (target.hp <= 0) { target.hp = 0; target.alive = false; }
  }

  buildState() {
    const t = now();
    this.seq++;
    return {
      seq: this.seq, t, room: this.roomCode, phase: this.phase, winner: this.winner, map: MAP,
      players: Array.from(this.players.values(), (p) => ({ id: p.id, name: p.name, hero: p.hero, heroLabel: p.heroLabel, team: p.team, x: Math.round(p.x), y: Math.round(p.y), hp: Math.round(p.hp), maxHp: p.maxHp, shield: Math.round(p.shield), dead: p.dead, ready: p.ready, stealth: t < p.stealthUntil, cds: { basic: Math.max(0, p.cds.basic - t), skill1: Math.max(0, p.cds.skill1 - t), skill2: Math.max(0, p.cds.skill2 - t), ult: Math.max(0, p.cds.ult - t) } })),
      minions: this.minions.map((m) => ({ id: m.id, team: m.team, x: Math.round(m.x), y: Math.round(m.y), hp: Math.round(m.hp), maxHp: m.maxHp })),
      projectiles: this.projectiles.map((p) => ({ id: p.id, team: p.team, x: Math.round(p.x), y: Math.round(p.y), r: p.r, color: p.color, kind: p.kind })),
      areas: this.areas.map((a) => ({ id: a.id, team: a.team, x: Math.round(a.x), y: Math.round(a.y), r: a.r, color: a.color, kind: a.kind })),
      towers: this.towers.map((tw) => ({ id: tw.id, team: tw.team, x: tw.x, y: tw.y, hp: Math.round(tw.hp), maxHp: tw.maxHp, alive: tw.alive })),
      cores: this.cores,
      counts: { p: this.players.size, m: this.minions.length, pr: this.projectiles.length, a: this.areas.length }
    };
  }

  broadcastState() {
    if (this.sessions.size < 1) return;
    this.broadcast({ type: "state", state: this.buildState() });
  }

  broadcastSystem(textMsg) {
    this.broadcast({ type: "system", text: textMsg });
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.sessions.keys()) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch {}
    }
  }

  safeSend(ws, msg) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); } catch {}
  }
}

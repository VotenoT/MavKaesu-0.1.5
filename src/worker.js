import { DurableObject } from "cloudflare:workers";

const MAP = { width: 960, height: 540 };
const TICK_MS = 50;
const STATE_MS = 100;
const MAX_PROJECTILES = 64;
const MAX_MINIONS = 20;
const MAX_ZONES = 24;
const MAX_EFFECTS = 36;
const ROOM_CODE_RE = /^[A-Z0-9_-]{3,18}$/;

const HEROES = {
  votenot: { label: "VotenoT", role: "Controle com chamas", maxHp: 125, speed: 170, color: "#ff7a1a", cooldowns: { basic: 420, skill1: 5200, skill2: 8000, ult: 22000 } },
  astro: { label: "Astro", role: "Suporte com portais", maxHp: 105, speed: 178, color: "#b85cff", cooldowns: { basic: 500, skill1: 7000, skill2: 9500, ult: 24000 } },
  akane: { label: "Akane", role: "Ataca-cura com sangue", maxHp: 112, speed: 166, color: "#ff2f61", cooldowns: { basic: 520, skill1: 6500, skill2: 9000, ult: 25000 } },
  shadow: { label: "Shadow", role: "Curta distância com espada", maxHp: 116, speed: 195, color: "#7e8cff", cooldowns: { basic: 360, skill1: 6200, skill2: 11000, ult: 23000 } }
};

const BASE_CORES = {
  blue: { id: "core-blue", type: "core", team: "blue", x: 70, y: 270, hp: 650, maxHp: 650, radius: 44, alive: true },
  red: { id: "core-red", type: "core", team: "red", x: 890, y: 270, hp: 650, maxHp: 650, radius: 44, alive: true }
};

const clone = (v) => JSON.parse(JSON.stringify(v));
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const nowMs = () => Date.now();
const enemyTeam = (team) => team === "blue" ? "red" : "blue";
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

function norm(dx, dy) {
  const d = Math.hypot(dx, dy);
  if (!Number.isFinite(d) || d < 0.001) return { x: 1, y: 0 };
  return { x: dx / d, y: dy / d };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function text(data, status = 200) {
  return new Response(data, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function randId(prefix = "id") {
  const part = crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${part}`;
}

function sanitizeName(name) {
  const n = String(name || "Jogador").normalize("NFKC").replace(/[^\p{L}\p{N}\s_.-]/gu, "").trim().slice(0, 18);
  return n || "Jogador";
}

function cleanRoomCode(code) {
  return String(code || "").normalize("NFKC").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 18);
}

function safeHero(hero) {
  return HEROES[hero] ? hero : "votenot";
}

function teamSpawn(team) {
  return team === "blue" ? { x: 135, y: 270 } : { x: 825, y: 270 };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, engine: "Cloudflare Workers + Durable Objects + WebSocket", name: "MAVKaesu Arena 0.1.5 Cloudflare Edition", endpoints: ["/", "/ws/:room", "/room/:room/status"] });
    }

    if (url.pathname.startsWith("/ws/")) {
      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") return text("Este endpoint espera Upgrade: websocket.", 426);
      const roomCode = cleanRoomCode(url.pathname.split("/").pop());
      if (!ROOM_CODE_RE.test(roomCode)) return json({ ok: false, error: "Código de sala inválido." }, 400);
      const id = env.MATCHROOM.idFromName(roomCode);
      const stub = env.MATCHROOM.get(id);
      return stub.fetch(request);
    }

    if (url.pathname.startsWith("/room/") && url.pathname.endsWith("/status")) {
      const parts = url.pathname.split("/");
      const roomCode = cleanRoomCode(parts[2]);
      if (!ROOM_CODE_RE.test(roomCode)) return json({ ok: false, error: "Sala inválida." }, 400);
      const id = env.MATCHROOM.idFromName(roomCode);
      const stub = env.MATCHROOM.get(id);
      return stub.fetch(request);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return text("ASSETS não configurado. Verifique wrangler.toml.", 500);
  }
};

export class MatchRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.roomCode = "ROOM";
    this.sessions = new Map();
    this.players = new Map();
    this.projectiles = [];
    this.minions = [];
    this.zones = [];
    this.effects = [];
    this.cores = clone(BASE_CORES);
    this.towers = this.createTowers();
    this.phase = "lobby";
    this.winner = null;
    this.lastTick = nowMs();
    this.lastSpawn = nowMs();
    this.loopTimer = null;
    this.stateTimer = null;
  }

  createTowers() {
    return [
      { id: "tower-blue-1", type: "tower", team: "blue", x: 245, y: 270, hp: 320, maxHp: 320, radius: 32, range: 160, cd: 0, alive: true },
      { id: "tower-red-1", type: "tower", team: "red", x: 715, y: 270, hp: 320, maxHp: 320, radius: 32, range: 160, cd: 0, alive: true }
    ];
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/room/") && url.pathname.endsWith("/status")) {
      return json({ ok: true, room: this.roomCode, phase: this.phase, winner: this.winner, sockets: this.sessions.size, players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, hero: p.hero, team: p.team, hp: Math.round(p.hp), dead: p.dead })), counts: { projectiles: this.projectiles.length, minions: this.minions.length, zones: this.zones.length, effects: this.effects.length } });
    }

    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") return text("Durable Object da sala ativo. Use /ws/CODIGO para conectar.", 426);

    this.roomCode = cleanRoomCode(url.pathname.split("/").pop()) || this.roomCode;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const id = randId("p");
    const name = sanitizeName(url.searchParams.get("name"));
    const hero = safeHero(url.searchParams.get("hero"));
    const team = this.pickTeam();
    const spawn = teamSpawn(team);
    const def = HEROES[hero];

    const player = { id, name, hero, heroLabel: def.label, team, x: spawn.x, y: spawn.y, facing: team === "blue" ? 1 : -1, hp: def.maxHp, maxHp: def.maxHp, shield: 0, dead: false, respawnAt: 0, ready: false, input: { x: 0, y: 0 }, cooldowns: { basic: 0, skill1: 0, skill2: 0, ult: 0 }, stealthUntil: 0, speedBoostUntil: 0, lastSeen: nowMs() };

    this.sessions.set(server, { id });
    this.players.set(id, player);
    this.send(server, { type: "welcome", id, room: this.roomCode, player, state: this.buildState() });
    this.broadcast({ type: "system", text: `${name} entrou no time ${team === "blue" ? "Azul" : "Vermelho"}.` });

    server.addEventListener("message", (event) => this.onMessage(server, event.data));
    server.addEventListener("close", () => this.removeSession(server));
    server.addEventListener("error", () => this.removeSession(server));

    this.startLoops();
    return new Response(null, { status: 101, webSocket: client });
  }

  pickTeam() {
    let blue = 0, red = 0;
    for (const p of this.players.values()) p.team === "blue" ? blue++ : red++;
    return blue <= red ? "blue" : "red";
  }

  startLoops() {
    if (!this.loopTimer) {
      this.lastTick = nowMs();
      this.loopTimer = setInterval(() => this.tick(), TICK_MS);
    }
    if (!this.stateTimer) this.stateTimer = setInterval(() => this.broadcast({ type: "state", state: this.buildState() }), STATE_MS);
  }

  stopLoopsIfEmpty() {
    if (this.sessions.size > 0) return;
    if (this.loopTimer) clearInterval(this.loopTimer);
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.loopTimer = null;
    this.stateTimer = null;
    this.resetIfEmpty();
  }

  resetIfEmpty() {
    this.players.clear();
    this.projectiles = [];
    this.minions = [];
    this.zones = [];
    this.effects = [];
    this.cores = clone(BASE_CORES);
    this.towers = this.createTowers();
    this.phase = "lobby";
    this.winner = null;
    this.lastSpawn = nowMs();
  }

  removeSession(ws) {
    const sess = this.sessions.get(ws);
    if (sess) {
      const player = this.players.get(sess.id);
      this.sessions.delete(ws);
      this.players.delete(sess.id);
      if (player) this.broadcast({ type: "system", text: `${player.name} saiu da sala.` });
    }
    this.stopLoopsIfEmpty();
  }

  onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return this.send(ws, { type: "error", text: "Mensagem inválida." }); }
    const sess = this.sessions.get(ws);
    if (!sess) return;
    const p = this.players.get(sess.id);
    if (!p) return;
    p.lastSeen = nowMs();

    if (msg.type === "input") {
      const x = clamp(Number(msg.x || 0), -1, 1);
      const y = clamp(Number(msg.y || 0), -1, 1);
      const n = Math.hypot(x, y);
      p.input.x = n > 1 ? x / n : x;
      p.input.y = n > 1 ? y / n : y;
      if (Math.abs(p.input.x) > 0.05) p.facing = p.input.x > 0 ? 1 : -1;
      return;
    }

    if (msg.type === "choose") {
      if (this.phase !== "lobby") return;
      const hero = safeHero(msg.hero);
      p.hero = hero;
      p.heroLabel = HEROES[hero].label;
      p.maxHp = HEROES[hero].maxHp;
      p.hp = p.maxHp;
      this.broadcast({ type: "system", text: `${p.name} escolheu ${p.heroLabel}.` });
      return;
    }

    if (msg.type === "ready") {
      p.ready = true;
      this.maybeStart();
      this.broadcast({ type: "system", text: `${p.name} está pronto.` });
      return;
    }

    if (msg.type === "attack") {
      if (this.phase !== "playing") this.phase = "playing";
      const slot = ["basic", "skill1", "skill2", "ult"].includes(msg.slot) ? msg.slot : "basic";
      const dir = norm(Number(msg.dx || 0), Number(msg.dy || 0));
      this.useAbility(p, slot, dir);
      return;
    }

    if (msg.type === "ping") this.send(ws, { type: "pong", t: msg.t || nowMs(), serverTime: nowMs() });
  }

  maybeStart() {
    const players = [...this.players.values()];
    if (players.length >= 2 && players.filter((p) => p.ready).length >= 2) {
      this.phase = "playing";
      this.broadcast({ type: "system", text: "Partida iniciada! Destrua o núcleo inimigo." });
    }
  }

  tick() {
    const t = nowMs();
    const dt = Math.min(0.08, Math.max(0.001, (t - this.lastTick) / 1000));
    this.lastTick = t;
    if (this.winner) return;
    this.updatePlayers(t, dt);
    if (this.phase === "playing") {
      this.spawnMinions(t);
      this.updateMinions(t, dt);
      this.updateTowers(t);
      this.updateProjectiles(dt);
      this.updateZones(t);
      this.cleanup();
      this.checkVictory();
    }
  }

  updatePlayers(t, dt) {
    for (const p of this.players.values()) {
      if (p.dead) {
        if (t >= p.respawnAt && !this.winner) {
          const spawn = teamSpawn(p.team);
          p.x = spawn.x; p.y = spawn.y; p.hp = p.maxHp; p.shield = 0; p.dead = false;
          this.effects.push({ id: randId("fx"), kind: "respawn", x: p.x, y: p.y, color: HEROES[p.hero].color, life: 650, created: t });
        }
        continue;
      }
      const def = HEROES[p.hero];
      let speed = def.speed;
      if (t < p.speedBoostUntil) speed *= 1.35;
      p.x = clamp(p.x + p.input.x * speed * dt, 40, MAP.width - 40);
      p.y = clamp(p.y + p.input.y * speed * dt, 70, MAP.height - 70);
      if (p.shield > 0) p.shield = Math.max(0, p.shield - 7 * dt);
    }
  }

  spawnMinions(t) {
    if (t - this.lastSpawn < 3200) return;
    this.lastSpawn = t;
    if (this.minions.length >= MAX_MINIONS) return;
    for (const team of ["blue", "red"]) {
      for (let i = 0; i < 2; i++) {
        const spawn = team === "blue" ? { x: 115, y: 255 + i * 30 } : { x: 845, y: 255 + i * 30 };
        this.minions.push({ id: randId("m"), type: "minion", team, x: spawn.x, y: spawn.y, hp: 52, maxHp: 52, radius: 14, atkCd: 0, alive: true });
      }
    }
  }

  updateMinions(t, dt) {
    for (const m of this.minions) {
      if (!m.alive) continue;
      const target = this.findNearestTarget(m, enemyTeam(m.team), 42);
      if (target) {
        if (t > m.atkCd) {
          this.damageTarget(target, 8, m.team, "minion");
          m.atkCd = t + 850;
          this.effects.push({ id: randId("fx"), kind: "hit", x: target.x, y: target.y, color: "#ddd", life: 260, created: t });
        }
      } else {
        const dir = m.team === "blue" ? 1 : -1;
        m.x += dir * 55 * dt;
        m.y += (270 - m.y) * 0.9 * dt;
      }
    }
  }

  updateTowers(t) {
    for (const tower of this.towers) {
      if (!tower.alive || t < tower.cd) continue;
      const target = this.findNearestTarget(tower, enemyTeam(tower.team), tower.range);
      if (!target) continue;
      this.spawnProjectile({ owner: tower.id, team: tower.team, x: tower.x, y: tower.y, dir: norm(target.x - tower.x, target.y - tower.y), speed: 350, damage: 18, radius: 8, life: 1000, color: tower.team === "blue" ? "#00d8ff" : "#ff4655", kind: "tower" });
      tower.cd = t + 1250;
    }
  }

  updateProjectiles(dt) {
    const t = nowMs();
    for (const pr of this.projectiles) {
      if (!pr.alive) continue;
      pr.life -= dt * 1000;
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      if (pr.life <= 0 || pr.x < -60 || pr.x > MAP.width + 60 || pr.y < -60 || pr.y > MAP.height + 60) { pr.alive = false; continue; }
      const hit = this.findProjectileHit(pr);
      if (hit) {
        this.damageTarget(hit, pr.damage, pr.team, pr.kind || "projectile");
        if (pr.lifesteal) {
          const owner = this.players.get(pr.owner);
          if (owner && !owner.dead) owner.hp = Math.min(owner.maxHp, owner.hp + pr.lifesteal);
        }
        if (pr.slow) this.addZone({ team: pr.team, x: pr.x, y: pr.y, radius: 42, damage: 0, heal: 0, slow: true, duration: 700, color: "#9c6bff", kind: "slow" });
        this.effects.push({ id: randId("fx"), kind: "hit", x: pr.x, y: pr.y, color: pr.color, life: 300, created: t });
        pr.alive = false;
      }
    }
  }

  updateZones(t) {
    for (const z of this.zones) {
      if (!z.alive) continue;
      if (t >= z.expires) { z.alive = false; continue; }
      if (t >= z.nextPulse) {
        for (const target of this.getAllTargets()) {
          if (!target.alive && target.type !== "player") continue;
          if (target.type === "player" && target.dead) continue;
          const d = Math.sqrt(dist2(z, target));
          if (d > z.radius + (target.radius || 16)) continue;
          if (target.team === z.team && z.heal > 0 && target.type === "player") target.hp = Math.min(target.maxHp, target.hp + z.heal);
          else if (target.team !== z.team && z.damage > 0) this.damageTarget(target, z.damage, z.team, z.kind || "zone");
        }
        z.nextPulse = t + z.pulseMs;
      }
    }
  }

  cleanup() {
    this.projectiles = this.projectiles.filter((p) => p.alive).slice(-MAX_PROJECTILES);
    this.minions = this.minions.filter((m) => m.alive && m.hp > 0).slice(-MAX_MINIONS);
    this.zones = this.zones.filter((z) => z.alive).slice(-MAX_ZONES);
    const t = nowMs();
    this.effects = this.effects.filter((fx) => t - fx.created < fx.life).slice(-MAX_EFFECTS);
  }

  checkVictory() {
    if (this.cores.blue.hp <= 0 && !this.winner) { this.winner = "red"; this.phase = "ended"; this.broadcast({ type: "gameOver", winner: "red", text: "Time Vermelho venceu!" }); }
    if (this.cores.red.hp <= 0 && !this.winner) { this.winner = "blue"; this.phase = "ended"; this.broadcast({ type: "gameOver", winner: "blue", text: "Time Azul venceu!" }); }
  }

  useAbility(p, slot, dir) {
    if (p.dead || this.winner) return;
    const t = nowMs();
    const hero = HEROES[p.hero];
    const cd = hero.cooldowns[slot] || 1000;
    if (t < p.cooldowns[slot]) return;
    dir = this.aimOrAuto(p, dir);
    p.facing = dir.x >= 0 ? 1 : -1;
    if (p.hero === "votenot") this.votenotAbility(p, slot, dir);
    else if (p.hero === "astro") this.astroAbility(p, slot, dir);
    else if (p.hero === "akane") this.akaneAbility(p, slot, dir);
    else if (p.hero === "shadow") this.shadowAbility(p, slot, dir);
    p.cooldowns[slot] = t + cd;
  }

  aimOrAuto(p, dir) {
    if (Math.hypot(dir.x, dir.y) > 0.4) return norm(dir.x, dir.y);
    const target = this.findNearestTarget(p, enemyTeam(p.team), 300);
    if (target) return norm(target.x - p.x, target.y - p.y);
    return { x: p.facing || (p.team === "blue" ? 1 : -1), y: 0 };
  }

  votenotAbility(p, slot, dir) {
    if (slot === "basic") return this.spawnProjectile({ owner: p.id, team: p.team, x: p.x + dir.x * 24, y: p.y + dir.y * 24, dir, speed: 380, damage: 14, radius: 10, life: 850, color: "#ff7a1a", kind: "flame" });
    if (slot === "skill1") { for (const off of [-0.22, 0, 0.22]) this.spawnProjectile({ owner: p.id, team: p.team, x: p.x, y: p.y, dir: norm(dir.x - dir.y * off, dir.y + dir.x * off), speed: 430, damage: 18, radius: 12, life: 900, color: "#ffb12b", kind: "flame-wave" }); return; }
    if (slot === "skill2") { p.shield = Math.min(45, p.shield + 32); this.addZone({ team: p.team, x: p.x, y: p.y, radius: 58, damage: 5, duration: 1600, pulseMs: 400, color: "#ff6a00", kind: "flame-shield" }); return; }
    if (slot === "ult") this.addZone({ team: p.team, x: p.x + dir.x * 130, y: p.y + dir.y * 130, radius: 92, damage: 13, duration: 3300, pulseMs: 420, color: "#21e6ff", kind: "cyan-eye" });
  }

  astroAbility(p, slot, dir) {
    if (slot === "basic") return this.spawnProjectile({ owner: p.id, team: p.team, x: p.x + dir.x * 20, y: p.y + dir.y * 20, dir, speed: 360, damage: 11, radius: 9, life: 950, color: "#d66bff", kind: "star", slow: true });
    if (slot === "skill1") { const old = { x: p.x, y: p.y }; p.x = clamp(p.x + dir.x * 112, 45, MAP.width - 45); p.y = clamp(p.y + dir.y * 112, 75, MAP.height - 75); this.addZone({ team: p.team, x: old.x, y: old.y, radius: 50, heal: 6, duration: 1400, pulseMs: 350, color: "#a862ff", kind: "portal-afterimage" }); this.effects.push({ id: randId("fx"), kind: "portal", x: p.x, y: p.y, color: "#c084fc", life: 600, created: nowMs() }); return; }
    if (slot === "skill2") return this.addZone({ team: p.team, x: p.x + dir.x * 95, y: p.y + dir.y * 95, radius: 76, damage: 5, heal: 8, duration: 3100, pulseMs: 500, color: "#7c3cff", kind: "portal-field" });
    if (slot === "ult") for (let i = -2; i <= 2; i++) this.addZone({ team: p.team, x: clamp(p.x + dir.x * 120 + i * 32, 70, MAP.width - 70), y: clamp(p.y + dir.y * 120 - i * 28, 80, MAP.height - 80), radius: 44, damage: 11, heal: 3, duration: 2300, pulseMs: 450, color: "#e0aaff", kind: "constellation" });
  }

  akaneAbility(p, slot, dir) {
    if (slot === "basic") return this.spawnProjectile({ owner: p.id, team: p.team, x: p.x + dir.x * 20, y: p.y + dir.y * 20, dir, speed: 385, damage: 13, radius: 9, life: 900, color: "#ff2f61", kind: "blood-lance", lifesteal: 4 });
    if (slot === "skill1") return this.addZone({ team: p.team, x: p.x + dir.x * 68, y: p.y + dir.y * 68, radius: 62, damage: 7, heal: 11, duration: 1600, pulseMs: 420, color: "#ff386a", kind: "blood-pact" });
    if (slot === "skill2") { const px = p.x + dir.x * 72, py = p.y + dir.y * 72; this.damageArea(px, py, 58, p.team, 22, "blood-claw"); p.hp = Math.min(p.maxHp, p.hp + 8); this.effects.push({ id: randId("fx"), kind: "slash", x: px, y: py, color: "#ff174d", life: 420, created: nowMs() }); return; }
    if (slot === "ult") this.addZone({ team: p.team, x: p.x + dir.x * 105, y: p.y + dir.y * 105, radius: 96, damage: 14, heal: 10, duration: 3000, pulseMs: 500, color: "#b00034", kind: "red-tide" });
  }

  shadowAbility(p, slot, dir) {
    if (slot === "basic") { const px = p.x + dir.x * 48, py = p.y + dir.y * 48; this.damageArea(px, py, 44, p.team, 15, "katana"); this.effects.push({ id: randId("fx"), kind: "slash", x: px, y: py, color: "#b9c4ff", life: 260, created: nowMs() }); return; }
    if (slot === "skill1") { p.x = clamp(p.x + dir.x * 92

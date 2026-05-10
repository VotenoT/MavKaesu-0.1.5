import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 2;
const ROOM_CODE_RE = /^[A-Z0-9_-]{3,18}$/;
const STATE_THROTTLE_MS = 100;
const HEROES = {
  votenot: { label: "VotenoT", maxHp: 100, skin: "player", color: "#ff7a1a" },
  astro: { label: "Astro", maxHp: 125, skin: "astro", color: "#bb6dff" },
  rex: { label: "Rex", maxHp: 100, skin: "rex", color: "#7dff9d" },
  shadow: { label: "Shadow", maxHp: 100, skin: "shadow", color: "#363bff" }
};

const CYBER_EVENTS = [
  { type: "areia", label: "Areia Movediça", weight: 3 },
  { type: "matteus", label: "Gás do Matteus", weight: 4 },
  { type: "timao", label: "Timão", weight: 4 },
  { type: "kronos", label: "Kronos", weight: 5 },
  { type: "storm", label: "Tempestade", weight: 5 },
  { type: "crystal", label: "Kayllane", weight: 6 },
  { type: "scalding", label: "Chão Escaldante", weight: 6 },
  { type: "laura", label: "Laura", weight: 7 },
  { type: "akane", label: "Akane", weight: 9 },
  { type: "web", label: "Teia do Miranha", weight: 10 },
  { type: "maleta", label: "Chão do Maleta", weight: 8 },
  { type: "rocket", label: "Foguete do Astro", weight: 21 },
  { type: "other", label: "Sala silenciosa", weight: 10 },
  { type: "fire", label: "Sala em chamas", weight: 7 },
  { type: "none", label: "Sala silenciosa", weight: 0 }
];
const PREDICTABLE = ["laura", "web", "fire", "scalding", "rocket", "kronos", "maleta", "akane", "matteus", "areia", "storm"];

const now = () => Date.now();
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
function cleanClientId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || `c_${Math.random().toString(36).slice(2, 12)}`;
}
function safeHero(hero) { return HEROES[hero] ? hero : "votenot"; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n) || 0)); }
function roomCodeFromUrl(url) { return cleanRoomCode(url.pathname.split("/").pop()); }
function mulberry32(seed) {
  return function rand() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function weightedPick(list, rand) {
  const total = list.reduce((a, e) => a + e.weight, 0);
  let roll = rand() * total;
  for (const e of list) { roll -= e.weight; if (roll <= 0) return e; }
  return list[0];
}
function makeEvent(type, room, seed, forced = false) {
  const def = CYBER_EVENTS.find(e => e.type === type) || { type, label: type };
  const normalizedType = type === "other" ? "other" : type;
  const event = { type: normalizedType, label: def.label, room, seed, serial: `${room}_${seed}_${type}_${now()}`, startedAt: now(), forced };
  if (type === "akane") event.mode = ((seed + room * 7) % 2 === 0) ? "heal" : "damage";
  if (type === "rocket") event.lane = 383;
  if (type === "kronos") event.runes = Array.from({ length: 6 }, (_, i) => ({ x: 150 + ((seed + i * 137 + room * 71) % 650), y: 280 + ((seed + i * 53) % 85), symbol: ["◆","●","▲","✦","⬟","✧"][i] }));
  if (type === "crystal") {
    const future = room + 1 + ((seed + room * 11) % 5);
    const predicted = PREDICTABLE[(seed + room * 19) % PREDICTABLE.length];
    event.prediction = { room: future, type: predicted };
  }
  return event;
}
function freshGame() {
  return {
    mode: "lobby",
    world: "cyberpunk",
    room: 1,
    runId: Math.random().toString(36).slice(2, 10),
    seed: Math.floor(Math.random() * 2 ** 31),
    event: makeEvent("none", 1, 1),
    prediction: null,
    lauraRoomsLeft: 0,
    maletaRoomsLeft: 0,
    stormRoomsLeft: 0,
    startedAt: 0,
    endedAt: 0,
    message: "Escolham os personagens e apertem COMEÇAR.",
    stats: { advances: 0, deaths: 0 }
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, build: "MAVKaesu Coop Standard 0.1.5", mode: "MAVKaesu padrão cooperativo", engine: "Cloudflare Workers + Durable Objects + WebSocket" });
    }
    if (url.pathname.startsWith("/ws/")) {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return text("Este endpoint precisa de WebSocket.", 426);
      const code = roomCodeFromUrl(url);
      if (!ROOM_CODE_RE.test(code)) return json({ ok: false, error: "Código de sala inválido." }, 400);
      const id = env.COOP_ROOM.idFromName(code);
      return env.COOP_ROOM.get(id).fetch(request);
    }
    if (url.pathname.startsWith("/room/") && url.pathname.endsWith("/status")) {
      const code = cleanRoomCode(url.pathname.split("/")[2]);
      if (!ROOM_CODE_RE.test(code)) return json({ ok: false, error: "Sala inválida." }, 400);
      const id = env.COOP_ROOM.idFromName(code);
      return env.COOP_ROOM.get(id).fetch(new Request(new URL("/status", url.origin), request));
    }
    return env.ASSETS.fetch(request);
  }
};

export class MatchRoom extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.players = {};
    this.game = freshGame();
    this.roomCode = "";
    this.lastStateAt = 0;
    this.lastAdvanceAt = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/status") return json({ ok: true, roomCode: this.roomCode, game: this.publicGame(), players: this.publicPlayers() });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.attach(server, url);
    return new Response(null, { status: 101, webSocket: client });
  }

  attach(ws, url) {
    this.roomCode = cleanRoomCode(url.pathname.split("/").pop() || this.roomCode || "ROOM");
    const session = { id: null, joinedAt: now(), lastSeen: now() };
    this.sessions.set(ws, session);
    ws.addEventListener("message", (event) => {
      try { this.handle(ws, JSON.parse(event.data)); }
      catch { this.send(ws, { type: "error", message: "Mensagem inválida." }); }
    });
    ws.addEventListener("close", () => this.detach(ws));
    ws.addEventListener("error", () => this.detach(ws));
    this.send(ws, { type: "hello", roomCode: this.roomCode, serverTime: now() });
  }

  detach(ws) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (session?.id && this.players[session.id]) {
      this.players[session.id].connected = false;
      this.players[session.id].lastSeen = now();
      this.broadcastState(true);
    }
  }

  handle(ws, msg) {
    const type = String(msg?.type || "");
    if (type === "join") return this.join(ws, msg);
    if (type === "ping") return this.send(ws, { type: "pong", t: msg.t || now(), serverTime: now() });
    const session = this.sessions.get(ws);
    if (!session?.id || !this.players[session.id]) return this.send(ws, { type: "error", message: "Entre na sala primeiro." });
    const player = this.players[session.id];
    player.lastSeen = now();

    if (type === "selectHero") {
      if (this.game.mode !== "playing") {
        player.hero = safeHero(msg.hero);
        player.maxHp = HEROES[player.hero].maxHp;
        player.hp = player.maxHp;
        this.game.message = `${player.name} escolheu ${HEROES[player.hero].label}.`;
      }
      return this.broadcastState(true);
    }
    if (type === "ready") {
      if (this.game.mode === "post") this.resetToLobby();
      player.ready = !!msg.ready;
      this.game.message = player.ready ? `${player.name} está pronto.` : `${player.name} cancelou o começo.`;
      this.tryStart();
      return this.broadcastState(true);
    }
    if (type === "position") {
      if (this.game.mode !== "playing") return;
      player.x = clamp(msg.x, 20, 940);
      player.y = clamp(msg.y, 120, 500);
      player.vx = clamp(msg.vx, -700, 700);
      player.vy = clamp(msg.vy, -1200, 1200);
      player.dir = msg.dir === -1 ? -1 : 1;
      player.anim = String(msg.anim || "idle").slice(0, 20);
      player.defending = !!msg.defending;
      return this.broadcastState(false);
    }
    if (type === "advanceRoom") {
      if (this.game.mode !== "playing" || !player.alive || player.out) return;
      if (now() - this.lastAdvanceAt < 650) return;
      this.lastAdvanceAt = now();
      this.advanceRoom(player.name, Number(msg.jump || 1));
      return this.broadcastState(true);
    }
    if (type === "damage") {
      if (this.game.mode !== "playing") return;
      const amount = clamp(msg.amount, 0, 200);
      this.damagePlayer(player, amount, String(msg.reason || "perigo").slice(0, 50));
      return this.broadcastState(true);
    }
    if (type === "heal") {
      if (this.game.mode !== "playing" || !player.alive || player.out) return;
      const amount = clamp(msg.amount, 0, 200);
      player.hp = Math.min(player.maxHp, player.hp + amount);
      this.game.message = `${player.name} recuperou vida.`;
      return this.broadcastState(true);
    }
    if (type === "clearEvent") {
      if (this.game.mode !== "playing") return;
      this.game.message = String(msg.message || `${player.name} superou o evento.`).slice(0, 100);
      return this.broadcastState(true);
    }
    if (type === "quitRun") {
      player.out = true; player.alive = false; player.ready = false;
      this.game.message = `${player.name} saiu da tentativa.`;
      this.checkPostRun(); return this.broadcastState(true);
    }
    if (type === "again") { this.resetToLobby(); return this.broadcastState(true); }
    if (type === "leaveRoom") {
      delete this.players[player.id];
      try { ws.close(1000, "Saiu da sala"); } catch {}
      this.checkPostRun(); return this.broadcastState(true);
    }
  }

  join(ws, msg) {
    const clientId = cleanClientId(msg.clientId);
    const name = cleanName(msg.name);
    const hero = safeHero(msg.hero);
    const session = this.sessions.get(ws);
    if (this.players[clientId]) {
      const old = this.players[clientId];
      old.name = name;
      old.hero = safeHero(old.hero || hero);
      old.maxHp = HEROES[old.hero].maxHp;
      old.hp = Math.min(old.maxHp, Math.max(0, Number(old.hp) || old.maxHp));
      old.connected = true;
      old.lastSeen = now();
      session.id = clientId;
      this.send(ws, { type: "joined", id: clientId, roomCode: this.roomCode, slot: old.slot });
      return this.broadcastState(true);
    }
    const activeIds = Object.keys(this.players);
    if (activeIds.length >= MAX_PLAYERS) return this.send(ws, { type: "error", message: "Sala cheia. O modo coop aceita 2 jogadores." });
    const slot = activeIds.length;
    this.players[clientId] = { id: clientId, slot, name, hero, maxHp: HEROES[hero].maxHp, hp: HEROES[hero].maxHp, ready: false, alive: true, out: false, connected: true, x: slot === 0 ? 155 : 210, y: 420, vx: 0, vy: 0, dir: 1, anim: "idle", defending: false, deaths: 0, joinedAt: now(), lastSeen: now() };
    session.id = clientId;
    this.game.message = `${name} entrou na sala.`;
    this.send(ws, { type: "joined", id: clientId, roomCode: this.roomCode, slot });
    this.broadcastState(true);
  }

  tryStart() {
    const list = Object.values(this.players);
    if (this.game.mode !== "lobby") return;
    if (list.length < 2) { this.game.message = "Aguardando o segundo jogador."; return; }
    if (!list.every(p => p.ready)) return;
    const seed = Math.floor(Math.random() * 2 ** 31);
    this.game = { ...freshGame(), mode: "playing", room: 1, seed, runId: Math.random().toString(36).slice(2, 10), startedAt: now(), message: "A dupla entrou na sala 1 de Cyberpunk." };
    this.enterRoom("Sistema", true);
    let i = 0;
    for (const p of list) {
      p.ready = false; p.alive = true; p.out = false; p.hp = HEROES[p.hero].maxHp; p.maxHp = HEROES[p.hero].maxHp; p.x = i === 0 ? 150 : 205; p.y = 420; p.vx = 0; p.vy = 0; p.dir = 1; p.anim = "idle"; p.defending = false; i++;
    }
  }

  enterRoom(byName = "Sistema", first = false) {
    const room = this.game.room;
    const seed = this.game.seed + room * 7919 + this.game.stats.advances * 17;
    if (room === 50) {
      this.game.event = makeEvent("wardenBoss", room, seed, true);
      this.game.event.label = "Warden";
      this.game.message = "O Warden bloqueou a sala 50.";
      return;
    }
    if (this.game.lauraRoomsLeft > 0) {
      this.game.event = makeEvent("laura", room, seed, true);
      this.game.lauraRoomsLeft -= 1;
      this.game.message = this.game.lauraRoomsLeft > 0 ? `Laura continua perseguindo por mais ${this.game.lauraRoomsLeft} sala(s).` : "Laura sumiu no corredor.";
      return;
    }
    if (this.game.maletaRoomsLeft > 0) {
      this.game.event = makeEvent("maleta", room, seed, true);
      this.game.maletaRoomsLeft -= 1;
      this.game.message = `O chão do Maleta ainda pulsa por ${this.game.maletaRoomsLeft + 1} sala(s).`;
      return;
    }
    if (this.game.stormRoomsLeft > 0) {
      this.game.event = makeEvent("storm", room, seed, true);
      this.game.stormRoomsLeft -= 1;
      this.game.message = this.game.stormRoomsLeft > 0 ? `A tempestade continua por mais ${this.game.stormRoomsLeft} sala(s).` : "A tempestade está se dissipando.";
      return;
    }
    if (this.game.prediction && this.game.prediction.room === room) {
      const pred = this.game.prediction;
      this.game.prediction = null;
      this.game.event = makeEvent(pred.type, room, seed, true);
      this.applyPersistentEventEffects();
      this.game.message = `A previsão da Kayllane se cumpriu: ${this.game.event.label}.`;
      return;
    }
    const rand = mulberry32(seed);
    const picked = first ? { type: "none", label: "Sala silenciosa" } : weightedPick(CYBER_EVENTS, rand);
    this.game.event = makeEvent(picked.type, room, seed, false);
    this.applyPersistentEventEffects();
    if (this.game.event.type === "timao") {
      const jump = 5;
      this.game.room += jump;
      this.game.stats.advances += jump;
      this.game.message = `Timão atropelou o destino. A dupla avançou ${jump} salas.`;
      return this.enterRoom("Timão", false);
    }
    if (this.game.event.type === "crystal") {
      this.game.prediction = this.game.event.prediction;
      const futureLabel = CYBER_EVENTS.find(e => e.type === this.game.prediction.type)?.label || this.game.prediction.type;
      this.game.message = `Kayllane previu ${futureLabel} na sala ${this.game.prediction.room}.`;
      return;
    }
    this.game.message = first ? "Sala 1: o corredor está quieto demais." : `${byName} chegou à sala ${room}: ${this.game.event.label}.`;
  }

  applyPersistentEventEffects() {
    if (this.game.event.type === "laura") this.game.lauraRoomsLeft = 4;
    if (this.game.event.type === "maleta") this.game.maletaRoomsLeft = 2;
    if (this.game.event.type === "storm") this.game.stormRoomsLeft = 2;
  }

  advanceRoom(byName, jump = 1) {
    const steps = Math.max(1, Math.min(5, Math.floor(jump || 1)));
    this.game.room += steps;
    this.game.stats.advances += steps;
    let i = 0;
    for (const p of Object.values(this.players)) {
      if (p.alive && !p.out) { p.x = i === 0 ? 150 : 205; p.y = 420; p.vx = 0; p.vy = 0; p.dir = 1; p.anim = "idle"; p.defending = false; i++; }
    }
    this.enterRoom(byName, false);
  }

  damagePlayer(player, amount, reason) {
    if (!player.alive || player.out) return;
    const dmg = player.defending ? Math.ceil(amount * 0.35) : amount;
    player.hp = Math.max(0, player.hp - dmg);
    if (player.hp <= 0) {
      player.alive = false; player.deaths += 1; this.game.stats.deaths += 1;
      this.game.message = `${player.name} morreu para ${reason}. O outro jogador ainda pode continuar.`;
      this.checkPostRun();
    }
  }

  checkPostRun() {
    if (this.game.mode !== "playing") return;
    const list = Object.values(this.players);
    const someoneStillRunning = list.some(p => p.alive && !p.out);
    if (!someoneStillRunning) { this.game.mode = "post"; this.game.endedAt = now(); this.game.message = "Fim da tentativa. Escolham nova partida ou saiam da sala."; }
  }

  resetToLobby() {
    this.game = freshGame();
    let i = 0;
    for (const p of Object.values(this.players)) { p.ready = false; p.alive = true; p.out = false; p.hp = HEROES[p.hero].maxHp; p.maxHp = HEROES[p.hero].maxHp; p.x = i === 0 ? 150 : 205; p.y = 420; p.vx = 0; p.vy = 0; p.dir = 1; p.anim = "idle"; p.defending = false; i++; }
  }

  publicGame() {
    return { ...this.game, event: this.game.event ? { ...this.game.event } : null, prediction: this.game.prediction ? { ...this.game.prediction } : null };
  }
  publicPlayers() { return Object.values(this.players).map(p => { const maxHp = HEROES[p.hero]?.maxHp || 100; if (p.maxHp !== maxHp) { p.maxHp = maxHp; p.hp = Math.min(maxHp, Math.max(0, Number(p.hp) || maxHp)); } return { id: p.id, slot: p.slot, name: p.name, hero: p.hero, maxHp, hp: Math.round(Math.min(maxHp, Math.max(0, Number(p.hp) || 0))), ready: p.ready, alive: p.alive, out: p.out, connected: p.connected, x: p.x, y: p.y, vx: p.vx, vy: p.vy, dir: p.dir, anim: p.anim, defending: p.defending, deaths: p.deaths }; }); }
  broadcastState(force = false) {
    const t = now(); if (!force && t - this.lastStateAt < STATE_THROTTLE_MS) return; this.lastStateAt = t;
    this.broadcast({ type: "state", game: this.publicGame(), players: this.publicPlayers(), serverTime: t });
  }
  send(ws, msg) { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); } catch {} }
  broadcast(msg) { const data = JSON.stringify(msg); for (const ws of this.sessions.keys()) { try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch {} } }
}

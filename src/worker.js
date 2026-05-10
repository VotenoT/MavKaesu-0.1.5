import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 2;
const ROOM_CODE_RE = /^[A-Z0-9_-]{3,18}$/;
const STATE_THROTTLE_MS = 120;
const HEROES = {
  votenot: { label: "VotenoT", maxHp: 100, skin: "player", color: "#ff7a1a" },
  astro: { label: "Astro", maxHp: 92, skin: "astro", color: "#bb6dff" },
  rex: { label: "Rex", maxHp: 115, skin: "rex", color: "#7dff9d" }
};

const EVENTS = [
  { type: "none", label: "Sala tranquila", weight: 34 },
  { type: "sculk", label: "Sculk", weight: 12 },
  { type: "laura", label: "Laura", weight: 10 },
  { type: "akane", label: "Akane", weight: 12 },
  { type: "rocket", label: "Foguete do Astro", weight: 10 },
  { type: "maleta", label: "Chão do Maleta", weight: 8 },
  { type: "heat", label: "Chamas instáveis", weight: 8 },
  { type: "warden", label: "Presságio do Warden", weight: 6 }
];

const now = () => Date.now();

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function text(data, status = 200) {
  return new Response(data, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });
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

function safeHero(hero) {
  return HEROES[hero] ? hero : "votenot";
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Number(n) || 0));
}

function roomCodeFromUrl(url) {
  return cleanRoomCode(url.pathname.split("/").pop());
}

function mulberry32(seed) {
  return function rand() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chooseEvent(room, seed) {
  if (room === 50) return { type: "wardenBoss", label: "Warden", seed, startedAt: now(), room };
  const rand = mulberry32(seed + room * 1337);
  const total = EVENTS.reduce((a, e) => a + e.weight, 0);
  let roll = rand() * total;
  for (const ev of EVENTS) {
    roll -= ev.weight;
    if (roll <= 0) return { type: ev.type, label: ev.label, seed, startedAt: now(), room };
  }
  return { type: "none", label: "Sala tranquila", seed, startedAt: now(), room };
}

function freshGame() {
  const seed = Math.floor(Math.random() * 2 ** 31);
  return {
    mode: "lobby",
    world: "cyberpunk",
    room: 1,
    runId: Math.random().toString(36).slice(2, 10),
    seed,
    event: chooseEvent(1, seed),
    startedAt: 0,
    endedAt: 0,
    message: "Escolham os personagens e apertem PRONTO.",
    stats: { advances: 0, deaths: 0 }
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        build: "MAVKaesu Coop 0.1.5 Cloudflare Edition",
        engine: "Workers + Durable Objects + WebSocket puro",
        players: MAX_PLAYERS,
        note: "Abra / para jogar. Use /ws/CODIGO para WebSocket."
      });
    }

    if (url.pathname.startsWith("/ws/")) {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return text("Este endpoint precisa de WebSocket.", 426);
      }
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
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/status") {
      return json({ ok: true, roomCode: this.roomCode, game: this.publicGame(), players: this.publicPlayers() });
    }

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
      try {
        this.handle(ws, JSON.parse(event.data));
      } catch (err) {
        this.send(ws, { type: "error", message: "Mensagem inválida." });
      }
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
    if (!session?.id || !this.players[session.id]) {
      return this.send(ws, { type: "error", message: "Entre na sala primeiro." });
    }

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
      this.game.message = player.ready ? `${player.name} está pronto.` : `${player.name} cancelou pronto.`;
      this.tryStart();
      return this.broadcastState(true);
    }

    if (type === "position") {
      if (this.game.mode !== "playing") return;
      player.x = clamp(msg.x, 20, 940);
      player.y = clamp(msg.y, 130, 500);
      player.vx = clamp(msg.vx, -600, 600);
      player.vy = clamp(msg.vy, -1000, 1000);
      player.dir = msg.dir === -1 ? -1 : 1;
      player.anim = String(msg.anim || "idle").slice(0, 20);
      player.defending = !!msg.defending;
      return this.broadcastState(false);
    }

    if (type === "advanceRoom") {
      if (this.game.mode !== "playing") return;
      if (!player.alive || player.out) return;
      this.advanceRoom(player.name);
      return this.broadcastState(true);
    }

    if (type === "damage") {
      if (this.game.mode !== "playing") return;
      const amount = clamp(msg.amount, 0, 100);
      this.damagePlayer(player, amount, String(msg.reason || "perigo").slice(0, 40));
      return this.broadcastState(true);
    }

    if (type === "heal") {
      if (this.game.mode !== "playing") return;
      const amount = clamp(msg.amount, 0, 100);
      player.hp = Math.min(player.maxHp, player.hp + amount);
      return this.broadcastState(true);
    }

    if (type === "quitRun") {
      player.out = true;
      player.alive = false;
      player.ready = false;
      this.game.message = `${player.name} saiu da partida.`;
      this.checkPostRun();
      return this.broadcastState(true);
    }

    if (type === "again") {
      this.resetToLobby();
      return this.broadcastState(true);
    }

    if (type === "leaveRoom") {
      delete this.players[player.id];
      try { ws.close(1000, "Saiu da sala"); } catch {}
      this.checkPostRun();
      return this.broadcastState(true);
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
      old.connected = true;
      old.lastSeen = now();
      session.id = clientId;
      this.send(ws, { type: "joined", id: clientId, roomCode: this.roomCode, slot: old.slot });
      return this.broadcastState(true);
    }

    const activeIds = Object.keys(this.players);
    if (activeIds.length >= MAX_PLAYERS) {
      return this.send(ws, { type: "error", message: "Sala cheia. O modo coop aceita 2 jogadores." });
    }

    const slot = activeIds.length;
    const player = {
      id: clientId,
      slot,
      name,
      hero,
      maxHp: HEROES[hero].maxHp,
      hp: HEROES[hero].maxHp,
      ready: false,
      alive: true,
      out: false,
      connected: true,
      x: slot === 0 ? 160 : 210,
      y: 420,
      vx: 0,
      vy: 0,
      dir: 1,
      anim: "idle",
      defending: false,
      deaths: 0,
      joinedAt: now(),
      lastSeen: now()
    };

    this.players[clientId] = player;
    session.id = clientId;
    this.game.message = `${name} entrou na sala.`;
    this.send(ws, { type: "joined", id: clientId, roomCode: this.roomCode, slot });
    this.broadcastState(true);
  }

  tryStart() {
    const list = Object.values(this.players);
    if (this.game.mode !== "lobby") return;
    if (list.length < 2) {
      this.game.message = "Aguardando o segundo jogador.";
      return;
    }
    if (!list.every((p) => p.ready)) return;

    const seed = Math.floor(Math.random() * 2 ** 31);
    this.game = {
      ...freshGame(),
      mode: "playing",
      room: 1,
      seed,
      event: chooseEvent(1, seed),
      startedAt: now(),
      message: "A dupla entrou na sala 1 de Cyberpunk."
    };

    let i = 0;
    for (const p of list) {
      p.ready = false;
      p.alive = true;
      p.out = false;
      p.hp = HEROES[p.hero].maxHp;
      p.maxHp = HEROES[p.hero].maxHp;
      p.x = i === 0 ? 150 : 205;
      p.y = 420;
      p.vx = 0;
      p.vy = 0;
      p.dir = 1;
      p.anim = "idle";
      p.defending = false;
      i++;
    }
  }

  advanceRoom(byName) {
    this.game.room += 1;
    this.game.stats.advances += 1;
    this.game.event = chooseEvent(this.game.room, this.game.seed);
    this.game.message = `${byName} avançou. A dupla foi para a sala ${this.game.room}.`;
    let i = 0;
    for (const p of Object.values(this.players)) {
      if (p.alive && !p.out) {
        p.x = i === 0 ? 150 : 205;
        p.y = 420;
        p.vx = 0;
        p.vy = 0;
        p.dir = 1;
        p.anim = "idle";
        p.defending = false;
        i++;
      }
    }
  }

  damagePlayer(player, amount, reason) {
    if (!player.alive || player.out) return;
    const dmg = player.defending ? Math.ceil(amount * 0.35) : amount;
    player.hp = Math.max(0, player.hp - dmg);
    if (player.hp <= 0) {
      player.alive = false;
      player.deaths += 1;
      this.game.stats.deaths += 1;
      this.game.message = `${player.name} morreu para ${reason}. O outro jogador ainda pode continuar.`;
      this.checkPostRun();
    }
  }

  checkPostRun() {
    if (this.game.mode !== "playing") return;
    const list = Object.values(this.players);
    if (list.length === 0) {
      this.game.mode = "post";
      this.game.endedAt = now();
      this.game.message = "Sala vazia.";
      return;
    }
    const someoneStillRunning = list.some((p) => p.alive && !p.out);
    if (!someoneStillRunning) {
      this.game.mode = "post";
      this.game.endedAt = now();
      this.game.message = "Fim da tentativa. Escolham nova partida ou saiam da sala.";
    }
  }

  resetToLobby() {
    this.game = freshGame();
    let i = 0;
    for (const p of Object.values(this.players)) {
      p.ready = false;
      p.alive = true;
      p.out = false;
      p.hp = HEROES[p.hero].maxHp;
      p.maxHp = HEROES[p.hero].maxHp;
      p.x = i === 0 ? 150 : 205;
      p.y = 420;
      p.vx = 0;
      p.vy = 0;
      p.dir = 1;
      p.anim = "idle";
      p.defending = false;
      i++;
    }
    this.game.message = "Escolham os personagens e apertem PRONTO.";
  }

  publicPlayers() {
    return Object.values(this.players).map((p) => ({
      id: p.id,
      slot: p.slot,
      name: p.name,
      hero: p.hero,
      label: HEROES[p.hero]?.label || "VotenoT",
      color: HEROES[p.hero]?.color || "#ff7a1a",
      hp: p.hp,
      maxHp: p.maxHp,
      ready: p.ready,
      alive: p.alive,
      out: p.out,
      connected: p.connected,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      dir: p.dir,
      anim: p.anim,
      defending: p.defending,
      deaths: p.deaths
    }));
  }

  publicGame() {
    return {
      mode: this.game.mode,
      world: this.game.world,
      room: this.game.room,
      event: this.game.event,
      message: this.game.message,
      runId: this.game.runId,
      startedAt: this.game.startedAt,
      endedAt: this.game.endedAt,
      stats: this.game.stats
    };
  }

  broadcastState(force = false) {
    const t = now();
    if (!force && t - this.lastStateAt < STATE_THROTTLE_MS) return;
    this.lastStateAt = t;
    this.broadcast({ type: "state", roomCode: this.roomCode, game: this.publicGame(), players: this.publicPlayers(), serverTime: t });
  }

  send(ws, msg) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    } catch {}
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.sessions.keys()) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      } catch {}
    }
  }
}

const express = require('express');
const http = require('http');
const os = require('os');
const { WebSocketServer } = require('ws');
const path = require('path');
const { Game, isValidThrow } = require('./gameEngine');

function parseBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'false') return false;
  if (value === 'true') return true;
  return fallback;
}

// Capped above the UI's 10-player limit (which only the client enforces) so
// a direct API call can't push past the dartboard's 20-number pool - beyond
// that, Killer's number assignment starts reusing numbers between players,
// silently misdirecting hits (gameEngine.js's _assignKillerNumbers).
const MAX_PLAYERS = 20;

// Called before a game is constructed/stored - server.js used to let a bad
// teamId reach Game/getState() and throw mid-request, by which point the
// broken game was already in the `games` Map with no id the client ever
// received back, i.e. a permanently stuck entry. Reject up front instead.
function gameSetupError(body) {
  const { players, teams } = body;
  if (players !== undefined) {
    if (!Array.isArray(players) || players.length === 0) return 'players must be a non-empty array';
    if (players.length > MAX_PLAYERS) return `players cannot exceed ${MAX_PLAYERS}`;
    for (const p of players) {
      if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || !p.name.trim()) {
        return 'each player needs a string id and a non-empty string name';
      }
    }
  }
  if (teams !== undefined && teams !== null) {
    if (!Array.isArray(teams)) return 'teams must be an array';
    for (const t of teams) {
      if (!t || typeof t.id !== 'string' || typeof t.name !== 'string') return 'each team needs a string id and name';
    }
  }
  if (Array.isArray(players) && Array.isArray(teams) && teams.length) {
    const teamIds = new Set(teams.map((t) => t.id));
    for (const p of players) {
      if (p.teamId !== undefined && p.teamId !== null && !teamIds.has(p.teamId)) {
        return `player ${p.id} has a teamId that doesn't match any team`;
      }
    }
  }
  return null;
}

const app = express();
// Default 100kb is too small once a few players have photo avatars embedded
// in the game-creation payload (each is a compressed ~160x160 JPEG, but
// several together can still add up past the default).
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const games = new Map(); // id -> Game

function broadcast(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  const payload = JSON.stringify({ type: 'state', game: game.getState() });
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client.gameId === gameId) client.send(payload);
  });
}

// --- REST API ---

// Create a new game
app.post('/api/game', (req, res) => {
  const { type, startScore, doubleOut, players, legsToWin, teams, livesStart } = req.body;
  const setupError = gameSetupError(req.body);
  if (setupError) return res.status(400).json({ error: setupError });
  const game = new Game({
    type: type || 'x01',
    startScore: startScore || 501,
    doubleOut: parseBool(doubleOut, true),
    legsToWin: legsToWin || 1,
    livesStart: livesStart || 3,
    teams: teams && teams.length ? teams : null,
    players: players && players.length ? players : [{ id: 'p1', name: 'Player 1' }, { id: 'p2', name: 'Player 2' }],
  });
  games.set(game.id, game);
  res.json(game.getState());
});

app.get('/api/game/:id', (req, res) => {
  const game = games.get(req.params.id);
  if (!game) return res.status(404).json({ error: 'not found' });
  res.json(game.getState());
});

// Register a single dart throw.
// Used by: the on-screen clickable board AND the camera detection script (vision/*.py).
// body: { segment: 1-20 | "BULL" | "MISS", multiplier: 1|2|3 }
app.post('/api/game/:id/throw', (req, res) => {
  const game = games.get(req.params.id);
  if (!game) return res.status(404).json({ error: 'not found' });
  const { segment, multiplier, throwId } = req.body;
  if (!isValidThrow(segment, multiplier)) {
    return res.status(400).json({ error: 'invalid throw: segment must be 1-20, "BULL", or "MISS"; multiplier must be 1, 2, or 3' });
  }
  const state = game.throwDart(segment, multiplier, throwId);
  broadcast(game.id);
  res.json(state);
});

app.post('/api/game/:id/undo', (req, res) => {
  const game = games.get(req.params.id);
  if (!game) return res.status(404).json({ error: 'not found' });
  const state = game.undo();
  broadcast(game.id);
  res.json(state);
});

// Called by the client on "End game"/"New game" so finished games don't sit
// in memory forever - see server.js's `games` Map.
app.delete('/api/game/:id', (req, res) => {
  games.delete(req.params.id);
  res.json({ ok: true });
});

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'subscribe' && games.has(msg.gameId)) {
        ws.gameId = msg.gameId;
        ws.send(JSON.stringify({ type: 'state', game: games.get(msg.gameId).getState() }));
      }
    } catch (e) { /* ignore malformed messages */ }
  });
});

function lanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dart scoring server running on port ${PORT}`);
  console.log('Open one of these from your tablet/phone browser on the same WiFi:');
  const addrs = lanAddresses();
  if (addrs.length) {
    addrs.forEach((ip) => console.log(`  http://${ip}:${PORT}`));
  } else {
    console.log('  (no LAN network detected — connect to WiFi/ethernet and restart)');
  }
});

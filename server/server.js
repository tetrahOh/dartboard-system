const express = require('express');
const http = require('http');
const os = require('os');
const { WebSocketServer } = require('ws');
const path = require('path');
const { Game } = require('./gameEngine');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const games = new Map(); // id -> Game

function broadcast(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  const payload = JSON.stringify({ type: 'state', game: game.getState() });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

// --- REST API ---

// Create a new game
app.post('/api/game', (req, res) => {
  const { type, startScore, doubleOut, players, legsToWin, teams, livesStart } = req.body;
  const game = new Game({
    type: type || 'x01',
    startScore: startScore || 501,
    doubleOut: doubleOut !== false,
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
  const { segment, multiplier } = req.body;
  const state = game.throwDart(segment, multiplier);
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

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'subscribe' && games.has(msg.gameId)) {
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

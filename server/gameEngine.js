// gameEngine.js
// Pure game-state logic. No I/O here — server.js wraps this and broadcasts state.

const crypto = require('crypto');

const CRICKET_NUMBERS = [20, 19, 18, 17, 16, 15, 'BULL'];

function scoreValue(segment, multiplier) {
  if (segment === 'BULL') return multiplier === 2 ? 50 : 25; // inner bull = 2x outer
  if (segment === 'MISS') return 0;
  return segment * multiplier;
}

function label(segment, multiplier) {
  if (segment === 'MISS') return 'MISS';
  if (segment === 'BULL') return multiplier === 2 ? 'DB' : 'B';
  const p = multiplier === 3 ? 'T' : multiplier === 2 ? 'D' : 'S';
  return `${p}${segment}`;
}

class Game {
  constructor({ type = 'x01', startScore = 501, doubleOut = true, players, legsToWin = 1 }) {
    this.id = crypto.randomBytes(4).toString('hex'); // unguessable — this ID doubles as the only access control
    this.type = type; // 'x01' | 'cricket'
    this.startScore = startScore;
    this.doubleOut = doubleOut;
    this.legsToWin = legsToWin;
    this.currentPlayerIndex = 0;
    this.currentTurnThrows = []; // [{segment, multiplier, value, label}]
    this.status = 'in_progress'; // in_progress | leg_won | game_won
    this.winnerId = null;
    this.log = []; // human-readable event log, newest first

    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      score: type === 'x01' ? startScore : 0,
      legsWon: 0,
      history: [], // completed turns: [{throws:[...], total, bust}]
      marks: type === 'cricket'
        ? Object.fromEntries(CRICKET_NUMBERS.map((n) => [n, 0]))
        : undefined,
    }));
  }

  get currentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  // segment: 1-20 | 'BULL' | 'MISS'   multiplier: 1|2|3
  throwDart(segment, multiplier) {
    if (this.status !== 'in_progress') return this.getState();
    if (this.currentTurnThrows.length >= 3) return this.getState();
    if (segment === 'BULL' && multiplier === 3) multiplier = 2; // no triple bull

    const value = scoreValue(segment, multiplier);
    const entry = { segment, multiplier, value, label: label(segment, multiplier) };
    this.currentTurnThrows.push(entry);

    if (this.type === 'x01') this._applyX01(entry);
    else this._applyCricket(entry);

    // auto end turn after 3 darts (unless leg/game already ended this throw)
    if (this.status === 'in_progress' && this.currentTurnThrows.length >= 3) {
      this._endTurn(false);
    }
    return this.getState();
  }

  _applyX01(entry) {
    const player = this.currentPlayer;
    const remaining = player.score - entry.value;
    const isDoubleFinish = entry.multiplier === 2;

    if (remaining < 0 || remaining === 1 && this.doubleOut || (remaining === 0 && this.doubleOut && !isDoubleFinish)) {
      // bust: score doesn't change, turn ends immediately
      this.log.unshift(`${player.name} throws ${entry.label} — BUST`);
      this._endTurn(true);
      return;
    }

    player.score = remaining;
    this.log.unshift(`${player.name} throws ${entry.label} (${remaining} left)`);

    if (remaining === 0) {
      this.log.unshift(`${player.name} wins the leg!`);
      this._finishLeg(player);
    }
  }

  _applyCricket(entry) {
    const player = this.currentPlayer;
    const key = entry.segment;
    if (!CRICKET_NUMBERS.includes(key)) {
      this.log.unshift(`${player.name} throws ${entry.label} (no effect)`);
      return; // numbers outside 15-20/Bull don't count in standard cricket
    }
    const hits = entry.multiplier; // treat multiplier as number of marks (T=3, D=2, S=1); bull D=2
    const current = player.marks[key];
    const opensNeeded = Math.max(0, 3 - current);
    const marksToOpen = Math.min(hits, opensNeeded);
    const marksToScore = hits - marksToOpen;

    player.marks[key] = current + marksToOpen;

    // scoring marks only count if at least one opponent hasn't closed that number
    const othersOpen = this.players.some((p) => p !== player && p.marks[key] < 3);
    let scored = 0;
    if (marksToScore > 0 && player.marks[key] >= 3 && othersOpen) {
      scored = marksToScore * (key === 'BULL' ? 25 : key);
      player.score += scored;
    }

    this.log.unshift(
      `${player.name} throws ${entry.label}${scored ? ` (+${scored} pts)` : ''}`
    );

    // win check: all numbers closed by this player AND their score is >= everyone else's
    const allClosed = CRICKET_NUMBERS.every((n) => player.marks[n] >= 3);
    if (allClosed) {
      const highestOther = Math.max(0, ...this.players.filter((p) => p !== player).map((p) => p.score));
      if (player.score >= highestOther) {
        this.log.unshift(`${player.name} wins the leg!`);
        this._finishLeg(player);
      }
    }
  }

  _endTurn(bust) {
    const player = this.currentPlayer;
    const total = this.currentTurnThrows.reduce((s, t) => s + t.value, 0);
    player.history.push({ throws: [...this.currentTurnThrows], total: bust ? 0 : total, bust });
    if (bust && this.type === 'x01') {
      // revert score to what it was at start of turn
      const priorTurns = player.history.slice(0, -1);
      player.score = this.startScore - priorTurns.reduce((s, t) => s + t.total, 0);
    }
    this.currentTurnThrows = [];
    if (this.status === 'in_progress') {
      this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    }
  }

  _finishLeg(winner) {
    winner.legsWon += 1;
    if (winner.legsWon >= this.legsToWin) {
      this.status = 'game_won';
      this.winnerId = winner.id;
    } else {
      this.status = 'leg_won';
      // reset for next leg, winner throws first
      this.players.forEach((p) => {
        p.score = this.type === 'x01' ? this.startScore : 0;
        p.history = [];
        if (this.type === 'cricket') p.marks = Object.fromEntries(CRICKET_NUMBERS.map((n) => [n, 0]));
      });
      this.currentPlayerIndex = this.players.findIndex((p) => p.id === winner.id);
      this.currentTurnThrows = [];
      this.status = 'in_progress';
    }
  }

  undo() {
    if (this.currentTurnThrows.length > 0) {
      const last = this.currentTurnThrows.pop();
      if (this.type === 'x01') this.currentPlayer.score += last.value;
      this.log.unshift(`Undo: removed ${last.label}`);
      return this.getState();
    }
    // undo previous player's completed turn
    const prevIndex = (this.currentPlayerIndex - 1 + this.players.length) % this.players.length;
    const prevPlayer = this.players[prevIndex];
    const lastTurn = prevPlayer.history.pop();
    if (lastTurn) {
      if (this.type === 'x01' && !lastTurn.bust) prevPlayer.score += lastTurn.total;
      this.currentPlayerIndex = prevIndex;
      this.log.unshift(`Undo: reverted ${prevPlayer.name}'s last turn`);
    }
    return this.getState();
  }

  checkoutSuggestion(score) {
    if (score > 170 || score < 2) return null;
    if (!this.doubleOut) return null;
    const doubles = [...Array(20)].map((_, i) => 2 * (i + 1)).concat([50]);
    if (doubles.includes(score)) return [label(score === 50 ? 'BULL' : score / 2, score === 50 ? 2 : 2)];
    // simple table for common checkouts, falls back to null for exotic ones
    const table = {
      170: ['T20', 'T20', 'DB'], 167: ['T20', 'T19', 'DB'], 164: ['T20', 'T18', 'DB'],
      161: ['T20', 'T17', 'DB'], 160: ['T20', 'T20', 'D20'], 158: ['T20', 'T20', 'D19'],
      121: ['T20', 'S11', 'D25'], 100: ['T20', 'D20'], 96: ['T20', 'D18'],
      80: ['T20', 'D10'], 60: ['S20', 'D20'], 50: ['DB'], 40: ['D20'], 32: ['D16'],
    };
    return table[score] || null;
  }

  getState() {
    return {
      id: this.id,
      type: this.type,
      startScore: this.startScore,
      doubleOut: this.doubleOut,
      status: this.status,
      winnerId: this.winnerId,
      currentPlayerIndex: this.currentPlayerIndex,
      currentTurnThrows: this.currentTurnThrows,
      players: this.players,
      log: this.log.slice(0, 20),
      checkout: this.type === 'x01' ? this.checkoutSuggestion(this.currentPlayer.score) : null,
    };
  }
}

module.exports = { Game, scoreValue, label };

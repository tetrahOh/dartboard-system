// gameEngine.js
// Pure game-state logic. No I/O here — server.js wraps this and broadcasts state.
//
// Supports solo/1v1/multiplayer (1-10 players) and optional teams. When teams
// are present, individuals still take turns in sequence, but score/lives/marks
// accumulate on the shared team object instead of the individual — see
// `competitorOf()`. Every mode's per-dart handler mutates whatever
// `currentCompetitor` resolves to, so team support didn't need special-casing
// inside each game's rules.

const crypto = require('crypto');

const CRICKET_NUMBERS = [20, 19, 18, 17, 16, 15, 'BULL'];
const AROUND_THE_CLOCK_SEQUENCE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 'BULL'];
const SHANGHAI_ROUNDS = 20;
const HALVE_IT_ROUNDS = [
  { label: '20', match: (seg) => seg === 20 },
  { label: 'Any Double', match: (_seg, mult) => mult === 2 },
  { label: '19', match: (seg) => seg === 19 },
  { label: '17', match: (seg) => seg === 17 },
  { label: 'Any Double', match: (_seg, mult) => mult === 2 },
  { label: '15', match: (seg) => seg === 15 },
  { label: 'Any Triple', match: (_seg, mult) => mult === 3 },
  { label: '20', match: (seg) => seg === 20 },
  { label: 'Bullseye', match: (seg) => seg === 'BULL' },
];
const LEG_BASED_TYPES = new Set(['x01', 'cricket']);

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
  constructor({
    type = 'x01', startScore = 501, doubleOut = true, players, legsToWin = 1,
    teams = null, livesStart = 3,
  }) {
    this.id = crypto.randomBytes(4).toString('hex'); // unguessable — this ID doubles as the only access control
    this.type = type;
    this.startScore = startScore;
    this.doubleOut = doubleOut;
    this.legsToWin = LEG_BASED_TYPES.has(type) ? (legsToWin || 1) : 1;
    this.livesStart = livesStart;
    this.currentPlayerIndex = 0;
    this.currentTurnThrows = [];
    this.roundIndex = 0; // shanghai / halve_it round counter; limit's round-within-turns counter
    this.turnsThisRound = 0;
    this.currentLimit = null; // 'limit' mode only
    this.status = 'in_progress'; // in_progress | leg_won | game_won
    this.winnerId = null;
    this.winnerName = null;
    this.log = [];

    this.players = players.map((p) => this._makeCompetitor(p.id, p.name, p.teamId || null));
    this.teams = teams && teams.length ? teams.map((t) => this._makeCompetitor(t.id, t.name, null, true)) : null;

    if (type === 'killer') this._assignKillerNumbers();
  }

  _makeCompetitor(id, name, teamId, isTeam = false) {
    return {
      id, name, teamId, isTeam,
      history: isTeam ? undefined : [],
      score: this.type === 'x01' ? this.startScore : 0,
      legsWon: 0,
      marks: this.type === 'cricket' ? Object.fromEntries(CRICKET_NUMBERS.map((n) => [n, 0])) : undefined,
      lives: (this.type === 'killer' || this.type === 'limit') ? this.livesStart : undefined,
      isKiller: this.type === 'killer' ? false : undefined,
      killerNumber: undefined,
      targetIndex: this.type === 'around_the_clock' ? 0 : undefined,
      eliminated: (this.type === 'killer' || this.type === 'limit') ? false : undefined,
    };
  }

  get competitors() { return this.teams || this.players; }
  competitorOf(player) {
    if (!this.teams) return player;
    return this.teams.find((t) => t.id === player.teamId);
  }
  get currentPlayer() { return this.players[this.currentPlayerIndex]; }
  get currentCompetitor() { return this.competitorOf(this.currentPlayer); }

  turnLength() { return this.type === 'limit' ? 1 : 3; }

  _assignKillerNumbers() {
    const pool = [...Array(20)].map((_, i) => i + 1);
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    this.competitors.forEach((c, i) => { c.killerNumber = pool[i % pool.length]; });
  }

  // segment: 1-20 | 'BULL' | 'MISS'   multiplier: 1|2|3
  throwDart(segment, multiplier) {
    if (this.status !== 'in_progress') return this.getState();
    if (this.currentTurnThrows.length >= this.turnLength()) return this.getState();
    if (segment === 'BULL' && multiplier === 3) multiplier = 2; // no triple bull
    if (this.currentTurnThrows.length === 0) this._turnStartSnapshot = this._snapshot();

    const value = scoreValue(segment, multiplier);
    const entry = { segment, multiplier, value, label: label(segment, multiplier) };
    this.currentTurnThrows.push(entry);
    this._dispatch(entry);

    if (this.status === 'in_progress' && this.currentTurnThrows.length >= this.turnLength()) {
      this._endTurn(false);
    }
    return this.getState();
  }

  _dispatch(entry) {
    switch (this.type) {
      case 'x01': return this._applyX01(entry);
      case 'cricket': return this._applyCricket(entry);
      case 'around_the_clock': return this._applyAroundTheClock(entry);
      case 'killer': return this._applyKiller(entry);
      case 'shanghai': return this._applyShanghai(entry);
      case 'halve_it': return this._applyHalveIt(entry);
      case 'limit': return this._applyLimit(entry);
      default: return undefined;
    }
  }

  _applyX01(entry) {
    const player = this.currentPlayer;
    const scorer = this.currentCompetitor;
    const remaining = scorer.score - entry.value;
    const isDoubleFinish = entry.multiplier === 2;

    if (remaining < 0 || (remaining === 1 && this.doubleOut) || (remaining === 0 && this.doubleOut && !isDoubleFinish)) {
      this.log.unshift(`${player.name} throws ${entry.label} — BUST`);
      this._restore(this._turnStartSnapshot);
      this._endTurn(true);
      return;
    }

    scorer.score = remaining;
    this.log.unshift(`${player.name} throws ${entry.label} (${remaining} left)`);

    if (remaining === 0) {
      this._declareWinner(scorer, `${scorer.name} wins the leg!`);
    }
  }

  _applyCricket(entry) {
    const player = this.currentPlayer;
    const scorer = this.currentCompetitor;
    const key = entry.segment;
    if (!CRICKET_NUMBERS.includes(key)) {
      this.log.unshift(`${player.name} throws ${entry.label} (no effect)`);
      return;
    }
    const hits = entry.multiplier; // treat multiplier as number of marks (T=3, D=2, S=1); bull D=2
    const current = scorer.marks[key];
    const opensNeeded = Math.max(0, 3 - current);
    const marksToOpen = Math.min(hits, opensNeeded);
    const marksToScore = hits - marksToOpen;
    scorer.marks[key] = current + marksToOpen;

    const othersOpen = this.competitors.some((c) => c !== scorer && c.marks[key] < 3);
    let scored = 0;
    if (marksToScore > 0 && scorer.marks[key] >= 3 && othersOpen) {
      scored = marksToScore * (key === 'BULL' ? 25 : key);
      scorer.score += scored;
    }

    this.log.unshift(`${player.name} throws ${entry.label}${scored ? ` (+${scored} pts)` : ''}`);

    const allClosed = CRICKET_NUMBERS.every((n) => scorer.marks[n] >= 3);
    if (allClosed) {
      const highestOther = Math.max(0, ...this.competitors.filter((c) => c !== scorer).map((c) => c.score));
      if (scorer.score >= highestOther) this._declareWinner(scorer, `${scorer.name} wins the leg!`);
    }
  }

  _applyAroundTheClock(entry) {
    const player = this.currentPlayer;
    const scorer = this.currentCompetitor;
    const target = AROUND_THE_CLOCK_SEQUENCE[scorer.targetIndex];
    if (entry.segment === target) {
      scorer.targetIndex += 1;
      if (scorer.targetIndex >= AROUND_THE_CLOCK_SEQUENCE.length) {
        this._declareWinner(scorer, `${player.name} completes Around the Clock and wins!`);
        return;
      }
      this.log.unshift(`${player.name} hits ${entry.label} — next target: ${AROUND_THE_CLOCK_SEQUENCE[scorer.targetIndex]}`);
    } else {
      this.log.unshift(`${player.name} throws ${entry.label} (needs ${target})`);
    }
  }

  _applyKiller(entry) {
    const player = this.currentPlayer;
    const scorer = this.currentCompetitor;
    if (entry.segment === 'MISS' || entry.segment === 'BULL') {
      this.log.unshift(`${player.name} throws ${entry.label} (no effect)`);
      return;
    }
    if (entry.segment === scorer.killerNumber) {
      if (!scorer.isKiller && entry.multiplier === 2) {
        scorer.isKiller = true;
        this.log.unshift(`${player.name} becomes a KILLER!`);
      } else {
        this.log.unshift(`${player.name} throws ${entry.label} (no effect)`);
      }
      return;
    }
    if (!scorer.isKiller) {
      this.log.unshift(`${player.name} throws ${entry.label} (not a killer yet)`);
      return;
    }
    const target = this.competitors.find((c) => c !== scorer && c.killerNumber === entry.segment && !c.eliminated);
    if (!target) {
      this.log.unshift(`${player.name} throws ${entry.label} (no effect)`);
      return;
    }
    target.lives = Math.max(0, target.lives - entry.multiplier);
    this.log.unshift(`${player.name} hits ${target.name}'s number! (${target.name}: ${target.lives} lives left)`);
    if (target.lives === 0) {
      target.eliminated = true;
      this.log.unshift(`${target.name} is eliminated!`);
      this._checkEliminationWin();
    }
  }

  _applyShanghai(entry) {
    const player = this.currentPlayer;
    const scorer = this.currentCompetitor;
    const target = this.roundIndex + 1;
    if (entry.segment !== target) {
      this.log.unshift(`${player.name} throws ${entry.label} (not this round's number)`);
      return;
    }
    scorer.score += entry.value;
    this.log.unshift(`${player.name} throws ${entry.label} for the ${target}s (+${entry.value})`);
    const hitMultipliers = new Set(this.currentTurnThrows.filter((t) => t.segment === target).map((t) => t.multiplier));
    if (hitMultipliers.has(1) && hitMultipliers.has(2) && hitMultipliers.has(3)) {
      this._declareWinner(scorer, `${player.name} hits a SHANGHAI (S+D+T of ${target}) and wins instantly!`);
    }
  }

  _applyHalveIt(entry) {
    const player = this.currentPlayer;
    this.log.unshift(`${player.name} throws ${entry.label}`);
  }

  _resolveHalveItTurn(player) {
    const scorer = this.competitorOf(player);
    const round = HALVE_IT_ROUNDS[this.roundIndex];
    const throwsThisTurn = player.history[player.history.length - 1].throws;
    const matched = throwsThisTurn.filter((t) => round.match(t.segment, t.multiplier));
    if (matched.length > 0) {
      const gained = matched.reduce((s, t) => s + t.value, 0);
      scorer.score += gained;
      this.log.unshift(`${player.name} scores ${gained} for "${round.label}" (${scorer.score} total)`);
    } else {
      const before = scorer.score;
      scorer.score = Math.floor(scorer.score / 2);
      this.log.unshift(`${player.name} misses "${round.label}" — score halved (${before} → ${scorer.score})`);
    }
  }

  _applyLimit(entry) {
    const player = this.currentPlayer;
    const scorer = this.currentCompetitor;
    const isSetter = this.turnsThisRound === 0;
    if (isSetter) {
      if (this.currentLimit === null || entry.value < this.currentLimit) {
        this.currentLimit = entry.value;
        this.log.unshift(`${player.name} sets the limit to ${entry.value}`);
      } else {
        this.log.unshift(`${player.name} throws ${entry.label} (${entry.value}) — limit stays at ${this.currentLimit}`);
      }
      return;
    }
    if (entry.value >= this.currentLimit) {
      this.log.unshift(`${player.name} throws ${entry.label} — beats the limit of ${this.currentLimit}`);
      return;
    }
    scorer.lives -= 1;
    this.log.unshift(`${player.name} throws ${entry.label} — under the limit of ${this.currentLimit}, loses a life (${scorer.lives} left)`);
    if (scorer.lives <= 0) {
      scorer.eliminated = true;
      this.log.unshift(`${player.name} is eliminated!`);
      this._checkEliminationWin();
    }
  }

  _checkEliminationWin() {
    const active = this.competitors.filter((c) => !c.eliminated);
    if (active.length === 1) this._declareWinner(active[0], `${active[0].name} is the last one standing and wins!`);
    else if (active.length === 0) { this.status = 'game_won'; this.log.unshift('Everyone is eliminated — no winner!'); }
  }

  _endTurn(bust) {
    const player = this.currentPlayer;
    const total = this.currentTurnThrows.reduce((s, t) => s + t.value, 0);
    player.history.push({ throws: [...this.currentTurnThrows], total: bust ? 0 : total, bust, startSnapshot: this._turnStartSnapshot });
    this.currentTurnThrows = [];
    if (this.status !== 'in_progress') return;

    if (this.type === 'halve_it') this._resolveHalveItTurn(player);

    if (this.type === 'shanghai' || this.type === 'halve_it') {
      this.turnsThisRound += 1;
      if (this.turnsThisRound >= this.players.length) {
        this.turnsThisRound = 0;
        this.roundIndex += 1;
        const totalRounds = this.type === 'shanghai' ? SHANGHAI_ROUNDS : HALVE_IT_ROUNDS.length;
        if (this.status === 'in_progress' && this.roundIndex >= totalRounds) {
          this._endByHighScore();
          return;
        }
      }
    }

    if (this.type === 'limit') {
      const active = this.competitors.filter((c) => !c.eliminated);
      this.turnsThisRound += 1;
      if (this.turnsThisRound >= active.length) this.turnsThisRound = 0;
    }

    if (this.status === 'in_progress') this.currentPlayerIndex = this._nextActivePlayerIndex();
  }

  _nextActivePlayerIndex() {
    const n = this.players.length;
    for (let i = 1; i <= n; i += 1) {
      const cand = (this.currentPlayerIndex + i) % n;
      const comp = this.competitorOf(this.players[cand]);
      if (!comp.eliminated) return cand;
    }
    return this.currentPlayerIndex;
  }

  _endByHighScore() {
    const best = this.competitors.reduce((a, b) => (b.score > a.score ? b : a));
    this.status = 'game_won';
    this.winnerId = best.id;
    this.winnerName = best.name;
    this.log.unshift(`${best.name} wins with ${best.score} points!`);
  }

  _declareWinner(competitor, message) {
    if (message) this.log.unshift(message);
    competitor.legsWon += 1;
    if (competitor.legsWon >= this.legsToWin) {
      this.status = 'game_won';
      this.winnerId = competitor.id;
      this.winnerName = competitor.name;
    } else {
      this.status = 'leg_won';
      this.competitors.forEach((c) => {
        c.score = this.type === 'x01' ? this.startScore : 0;
        if (this.type === 'cricket') c.marks = Object.fromEntries(CRICKET_NUMBERS.map((n) => [n, 0]));
      });
      this.currentPlayerIndex = this.players.findIndex((p) => this.competitorOf(p) === competitor);
      this.currentTurnThrows = [];
      this.status = 'in_progress';
    }
  }

  undo() {
    if (this.currentTurnThrows.length > 0) {
      const removed = this.currentTurnThrows.pop();
      this._restore(this._turnStartSnapshot);
      const remaining = [...this.currentTurnThrows];
      this.currentTurnThrows = [];
      remaining.forEach((e) => { this.currentTurnThrows.push(e); this._dispatch(e); });
      this.log.unshift(`Undo: removed ${removed.label}`);
      return this.getState();
    }
    const prevIndex = (this.currentPlayerIndex - 1 + this.players.length) % this.players.length;
    const prevPlayer = this.players[prevIndex];
    const lastTurn = prevPlayer.history.pop();
    if (lastTurn) {
      this._restore(lastTurn.startSnapshot);
      this.status = 'in_progress';
      this.winnerId = null;
      this.winnerName = null;
      this.currentPlayerIndex = prevIndex;
      this.log.unshift(`Undo: reverted ${prevPlayer.name}'s last turn`);
    }
    return this.getState();
  }

  _snapshot() {
    return {
      competitors: this.competitors.map((c) => ({ ...c, marks: c.marks ? { ...c.marks } : undefined })),
      currentLimit: this.currentLimit,
      roundIndex: this.roundIndex,
      turnsThisRound: this.turnsThisRound,
    };
  }

  _restore(snapshot) {
    this.competitors.forEach((c, i) => {
      const s = snapshot.competitors[i];
      Object.assign(c, s);
      if (s.marks) c.marks = { ...s.marks };
    });
    this.currentLimit = snapshot.currentLimit;
    this.roundIndex = snapshot.roundIndex;
    this.turnsThisRound = snapshot.turnsThisRound;
  }

  checkoutSuggestion(score) {
    if (score > 170 || score < 2) return null;
    if (!this.doubleOut) return null;
    const doubles = [...Array(20)].map((_, i) => 2 * (i + 1)).concat([50]);
    if (doubles.includes(score)) return [label(score === 50 ? 'BULL' : score / 2, score === 50 ? 2 : 2)];
    const table = {
      170: ['T20', 'T20', 'DB'], 167: ['T20', 'T19', 'DB'], 164: ['T20', 'T18', 'DB'],
      161: ['T20', 'T17', 'DB'], 160: ['T20', 'T20', 'D20'], 158: ['T20', 'T20', 'D19'],
      121: ['T20', 'S11', 'D25'], 100: ['T20', 'D20'], 96: ['T20', 'D18'],
      80: ['T20', 'D10'], 60: ['S20', 'D20'], 50: ['DB'], 40: ['D20'], 32: ['D16'],
    };
    return table[score] || null;
  }

  _roundLabel() {
    if (this.type === 'shanghai') return `Round ${this.roundIndex + 1}/${SHANGHAI_ROUNDS} — target: ${Math.min(this.roundIndex + 1, 20)}`;
    if (this.type === 'halve_it') {
      const r = HALVE_IT_ROUNDS[Math.min(this.roundIndex, HALVE_IT_ROUNDS.length - 1)];
      return `Round ${this.roundIndex + 1}/${HALVE_IT_ROUNDS.length} — ${r.label}`;
    }
    return null;
  }

  _sanitizeCompetitor(c) {
    return {
      id: c.id,
      name: c.name,
      teamId: c.teamId,
      isTeam: c.isTeam,
      score: c.score,
      legsWon: c.legsWon,
      marks: c.marks,
      lives: c.lives,
      isKiller: c.isKiller,
      killerNumber: c.killerNumber,
      eliminated: c.eliminated,
      target: c.targetIndex !== undefined ? AROUND_THE_CLOCK_SEQUENCE[Math.min(c.targetIndex, AROUND_THE_CLOCK_SEQUENCE.length - 1)] : undefined,
      memberNames: c.isTeam ? this.players.filter((p) => p.teamId === c.id).map((p) => p.name) : undefined,
      history: c.isTeam ? undefined : c.history.map((h) => ({ throws: h.throws, total: h.total, bust: h.bust })),
    };
  }

  getState() {
    return {
      id: this.id,
      type: this.type,
      startScore: this.startScore,
      doubleOut: this.doubleOut,
      legsToWin: this.legsToWin,
      livesStart: this.livesStart,
      status: this.status,
      winnerId: this.winnerId,
      winnerName: this.winnerName,
      currentPlayerIndex: this.currentPlayerIndex,
      currentPlayerId: this.currentPlayer.id,
      currentCompetitorId: this.currentCompetitor.id,
      currentTurnThrows: this.currentTurnThrows,
      roundIndex: this.roundIndex,
      roundLabel: this._roundLabel(),
      currentLimit: this.currentLimit,
      limitPhase: this.type === 'limit' ? (this.turnsThisRound === 0 ? 'setter' : 'challenger') : null,
      players: this.players.map((p) => this._sanitizeCompetitor(p)),
      teams: this.teams ? this.teams.map((t) => this._sanitizeCompetitor(t)) : null,
      log: this.log.slice(0, 20),
      checkout: this.type === 'x01' ? this.checkoutSuggestion(this.currentCompetitor.score) : null,
    };
  }
}

module.exports = { Game, scoreValue, label, AROUND_THE_CLOCK_SEQUENCE, HALVE_IT_ROUNDS };

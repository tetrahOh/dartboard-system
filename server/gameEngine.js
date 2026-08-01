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
const LEG_BASED_TYPES = new Set(['x01', 'cricket', 'tower_collapse']);
// Tower Collapse is X01's exact rules (countdown to exactly 0, bust on
// overshoot) with a different client-side visual (a shrinking tower/shield
// instead of a plain number) - reuses _applyX01 and every other X01 code
// path via this set, rather than duplicating the countdown logic.
const X01_LIKE_TYPES = new Set(['x01', 'tower_collapse']);

// Snakes and Ladders: not a real-world dart game, invented for this app.
// Each dart's normal scoreValue (segment*multiplier, so a treble is a big
// jump) moves you along a 1-100 board - reuses the same scoreValue/label
// machinery every other mode uses, no new throw-handling concept needed.
// Landing exactly on a ladder's bottom climbs to its top; landing exactly on
// a snake's head slides to its tail. Must land exactly on 100 to win -
// overshooting just wastes that dart, same "precision" spirit as X01's
// double-out. Board layout chosen so no ladder-top/snake-tail is itself
// another ladder-bottom/snake-head, so a single dart can never chain.
const SNAKES_AND_LADDERS_BOARD_SIZE = 100;
// The 9->96 ladder and 99->3 snake are the "big" pair spanning almost the
// whole board - one huge early skip toward the finish, one huge late fall
// back near the start, for real late-game tension.
const SNAKES_AND_LADDERS_LADDERS = { 1: 38, 4: 14, 9: 96, 21: 42, 28: 84, 36: 44, 51: 67, 71: 91 };
const SNAKES_AND_LADDERS_SNAKES = { 17: 7, 54: 34, 62: 19, 64: 60, 87: 24, 93: 73, 95: 75, 98: 79, 99: 3 };

// Movement is a 1-6 dice-style value based on WHICH of the 6 real dartboard
// zones was hit, not the number - using the raw dart score (up to 60 for a
// treble) would let a single lucky treble skip most of the board. Ordered
// roughly by real difficulty: the two single zones (biggest, easiest targets)
// are worth least, the two bull zones (smallest, hardest) worth most.
const SNAKES_AND_LADDERS_RING_VALUES = {
  'outer-single': 1, 'inner-single': 2, double: 3, treble: 4, 'outer-bull': 5, 'inner-bull': 6,
};
function snakesAndLaddersDiceValue(segment, multiplier, ring) {
  if (segment === 'MISS') return 0;
  if (SNAKES_AND_LADDERS_RING_VALUES[ring] !== undefined) return SNAKES_AND_LADDERS_RING_VALUES[ring];
  // Fallback when no ring hint arrives (e.g. the camera-detection bridge,
  // which only ever sends segment+multiplier) - derive the best guess from
  // multiplier alone, defaulting ambiguous "single" to the more common outer one.
  if (segment === 'BULL') return multiplier === 2 ? 6 : 5;
  if (multiplier === 3) return 4;
  if (multiplier === 2) return 3;
  return 1;
}

// Donkey Race: not a real-world dart game, invented for this app. Each
// competitor is assigned their own number at random (reuses
// _assignKillerNumbers, same as Killer) - only hits on YOUR number move
// you, and the multiplier decides how far: single = 1, double = 2,
// treble = 3. Hits on anyone else's number (or Bull, or a miss) don't
// move you at all, same spirit as Killer requiring a hit on your own
// number before anything happens. No "exact landing" requirement, unlike
// Snakes & Ladders - first to cross the finish line wins, same as a real
// race. Track is shorter than Snakes & Ladders' 100 squares since only a
// fraction of darts thrown will actually land on your own number.
const DONKEY_RACE_TRACK_LENGTH = 20;

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

// All single-dart scoring options, highest value first (checkout searches
// prefer big hits first, matching how real checkout charts are presented).
const DOUBLES = [...Array(20)].map((_, i) => ({ value: 2 * (i + 1), label: `D${i + 1}` }));
DOUBLES.push({ value: 50, label: 'DB' });
const ALL_THROWS = [...Array(20)].flatMap((_, i) => {
  const n = i + 1;
  return [{ value: n * 3, label: `T${n}` }, { value: n * 2, label: `D${n}` }, { value: n, label: `S${n}` }];
});
ALL_THROWS.push({ value: 25, label: 'B' }, { value: 50, label: 'DB' });
ALL_THROWS.sort((a, b) => b.value - a.value);

// Exhaustive search for a double-out checkout using at most maxDarts darts
// (the number actually left in the current turn - a 3-dart combo suggested
// with 1 dart left would be impossible to complete). Cheap enough to run on
// every state update without caching.
function findCheckout(score, maxDarts) {
  const oneDart = DOUBLES.find((d) => d.value === score);
  if (oneDart) return [oneDart.label];
  if (maxDarts < 2) return null;

  for (const first of ALL_THROWS) {
    if (first.value >= score) continue;
    const finish = DOUBLES.find((d) => d.value === score - first.value);
    if (finish) return [first.label, finish.label];
  }
  if (maxDarts < 3) return null;

  for (const first of ALL_THROWS) {
    if (first.value >= score) continue;
    for (const second of ALL_THROWS) {
      const remaining = score - first.value - second.value;
      if (remaining <= 0) continue;
      const finish = DOUBLES.find((d) => d.value === remaining);
      if (finish) return [first.label, second.label, finish.label];
    }
  }
  return null;
}

// segment: 1-20 (number) | 'BULL' | 'MISS'   multiplier: 1 | 2 | 3
const VALID_SEGMENTS = new Set([...Array(20)].map((_, i) => i + 1));
function isValidThrow(segment, multiplier) {
  const segmentOk = segment === 'BULL' || segment === 'MISS' || VALID_SEGMENTS.has(segment);
  const multiplierOk = multiplier === 1 || multiplier === 2 || multiplier === 3;
  return segmentOk && multiplierOk;
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
    this._turnSeq = 0; // monotonic counter so undo() can find the true last turn even after elimination-caused skips
    this._roundPlayerCount = null; // 'limit' mode only - fixed at the start of each round, not recomputed mid-round
    this._processedThrowIds = new Set(); // dedupe retried throws so a lost-response retry can't double-count a dart

    this.players = players.map((p) => this._makeCompetitor(p.id, p.name, p.teamId || null, false, p.avatar));
    this.teams = teams && teams.length ? teams.map((t) => this._makeCompetitor(t.id, t.name, null, true)) : null;
    this._roundPlayerCount = this.players.length; // no one eliminated yet at construction time

    if (type === 'killer' || type === 'donkey_race') this._assignKillerNumbers();
  }

  _makeCompetitor(id, name, teamId, isTeam = false, avatar) {
    return {
      id, name, teamId, isTeam, avatar: avatar || null,
      history: isTeam ? undefined : [],
      score: X01_LIKE_TYPES.has(this.type) ? this.startScore : 0,
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
  // throwId: optional client-generated id. A postJSON retry after a lost
  // response resends the same id, so a duplicate is a no-op instead of
  // double-counting the dart.
  // ring: optional zone hint ('inner-single'|'outer-single'|'treble'|'double'
  // |'outer-bull'|'inner-bull') - only used by Snakes & Ladders to derive a
  // 1-6 dice-like movement value; every other mode's scoring is unaffected
  // and ignores it entirely.
  throwDart(segment, multiplier, throwId, ring) {
    if (this.status !== 'in_progress') return this.getState();
    if (throwId !== undefined && this._processedThrowIds.has(throwId)) return this.getState();
    if (this.currentTurnThrows.length >= this.turnLength()) return this.getState();
    if (segment === 'BULL' && multiplier === 3) multiplier = 2; // no triple bull
    if (this.currentTurnThrows.length === 0) this._turnStartSnapshot = this._snapshot();
    if (throwId !== undefined) this._processedThrowIds.add(throwId);

    const value = scoreValue(segment, multiplier);
    const entry = { segment, multiplier, value, label: label(segment, multiplier), ring };
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
      case 'tower_collapse': return this._applyX01(entry);
      case 'cricket': return this._applyCricket(entry);
      case 'around_the_clock': return this._applyAroundTheClock(entry);
      case 'killer': return this._applyKiller(entry);
      case 'shanghai': return this._applyShanghai(entry);
      case 'halve_it': return this._applyHalveIt(entry);
      case 'limit': return this._applyLimit(entry);
      case 'snakes_and_ladders': return this._applySnakesAndLadders(entry);
      case 'donkey_race': return this._applyDonkeyRace(entry);
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

  _applySnakesAndLadders(entry) {
    const player = this.currentPlayer;
    const scorer = this.currentCompetitor;
    const roll = snakesAndLaddersDiceValue(entry.segment, entry.multiplier, entry.ring);
    const newPos = scorer.score + roll;
    if (newPos > SNAKES_AND_LADDERS_BOARD_SIZE) {
      this.log.unshift(`${player.name} throws ${entry.label} (rolls a ${roll}) — overshoots ${SNAKES_AND_LADDERS_BOARD_SIZE}, stays on ${scorer.score}`);
      return;
    }
    scorer.score = newPos;
    if (SNAKES_AND_LADDERS_LADDERS[newPos] !== undefined) {
      scorer.score = SNAKES_AND_LADDERS_LADDERS[newPos];
      this.log.unshift(`${player.name} throws ${entry.label} (rolls a ${roll}), lands on ${newPos} — climbs a ladder to ${scorer.score}!`);
    } else if (SNAKES_AND_LADDERS_SNAKES[newPos] !== undefined) {
      scorer.score = SNAKES_AND_LADDERS_SNAKES[newPos];
      this.log.unshift(`${player.name} throws ${entry.label} (rolls a ${roll}), lands on ${newPos} — slides down a snake to ${scorer.score}!`);
    } else {
      this.log.unshift(`${player.name} throws ${entry.label} (rolls a ${roll}, now on ${newPos})`);
    }
    if (scorer.score === SNAKES_AND_LADDERS_BOARD_SIZE) {
      this._declareWinner(scorer, `${player.name} reaches ${SNAKES_AND_LADDERS_BOARD_SIZE} and wins!`);
    }
  }

  _applyDonkeyRace(entry) {
    const player = this.currentPlayer;
    const scorer = this.currentCompetitor;
    if (entry.segment !== scorer.killerNumber) {
      this.log.unshift(`${player.name} throws ${entry.label} (not their number — no movement)`);
      return;
    }
    const move = entry.multiplier; // single=1, double=2, treble=3
    scorer.score = Math.min(DONKEY_RACE_TRACK_LENGTH, scorer.score + move);
    this.log.unshift(`${player.name} hits their number with ${entry.label} — moves ${move} (now at ${scorer.score}/${DONKEY_RACE_TRACK_LENGTH})`);
    if (scorer.score >= DONKEY_RACE_TRACK_LENGTH) {
      this._declareWinner(scorer, `${player.name} crosses the finish line and wins the race!`);
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
    player.history.push({
      throws: [...this.currentTurnThrows], total: bust ? 0 : total, bust, startSnapshot: this._turnStartSnapshot, seq: this._turnSeq,
    });
    this._turnSeq += 1;
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
      // Round length is fixed to however many players were active when the round
      // STARTED, not recomputed every turn - an elimination that happens mid-round
      // (the eliminated player just took their turn this round) must not shrink
      // the round retroactively and skip whoever still hasn't gone yet.
      this.turnsThisRound += 1;
      if (this.turnsThisRound >= this._roundPlayerCount) {
        this.turnsThisRound = 0;
        this._roundPlayerCount = this.players.filter((p) => !this.competitorOf(p).eliminated).length;
      }
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
    const topScore = Math.max(...this.competitors.map((c) => c.score));
    const tied = this.competitors.filter((c) => c.score === topScore);
    const best = tied[0];
    this.status = 'game_won';
    this.winnerId = best.id;
    this.winnerName = best.name;
    if (tied.length > 1) {
      this.log.unshift(`${tied.map((c) => c.name).join(' & ')} tie at ${topScore} points — ${best.name} wins the tiebreak!`);
    } else {
      this.log.unshift(`${best.name} wins with ${best.score} points!`);
    }
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
        c.score = X01_LIKE_TYPES.has(this.type) ? this.startScore : 0;
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
    // Find whoever's last completed turn has the highest sequence number, rather
    // than assuming turn order is strictly sequential - eliminated players get
    // skipped (see _nextActivePlayerIndex), so a naive "previous index" decrement
    // targets the wrong player once any elimination has happened this game.
    let prevIndex = -1;
    let lastSeq = -1;
    this.players.forEach((p, i) => {
      const h = p.history[p.history.length - 1];
      if (h && h.seq > lastSeq) { lastSeq = h.seq; prevIndex = i; }
    });
    if (prevIndex === -1) return this.getState();
    const prevPlayer = this.players[prevIndex];
    const lastTurn = prevPlayer.history.pop();
    this._restore(lastTurn.startSnapshot);
    this.status = 'in_progress';
    this.winnerId = null;
    this.winnerName = null;
    this.currentPlayerIndex = prevIndex;
    this.log.unshift(`Undo: reverted ${prevPlayer.name}'s last turn`);
    return this.getState();
  }

  _snapshot() {
    return {
      competitors: this.competitors.map((c) => ({ ...c, marks: c.marks ? { ...c.marks } : undefined })),
      currentLimit: this.currentLimit,
      roundIndex: this.roundIndex,
      turnsThisRound: this.turnsThisRound,
      roundPlayerCount: this._roundPlayerCount,
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
    this._roundPlayerCount = snapshot.roundPlayerCount;
  }

  checkoutSuggestion(score) {
    if (score > 170 || score < 2) return null;
    if (!this.doubleOut) return null;
    const dartsLeft = this.turnLength() - this.currentTurnThrows.length;
    if (dartsLeft <= 0) return null;
    return findCheckout(score, dartsLeft);
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
      avatar: c.avatar,
      score: c.score,
      legsWon: c.legsWon,
      marks: c.marks,
      lives: c.lives,
      isKiller: c.isKiller,
      killerNumber: c.killerNumber,
      eliminated: c.eliminated,
      target: c.targetIndex !== undefined ? AROUND_THE_CLOCK_SEQUENCE[Math.min(c.targetIndex, AROUND_THE_CLOCK_SEQUENCE.length - 1)] : undefined,
      memberNames: c.isTeam ? this.players.filter((p) => p.teamId === c.id).map((p) => p.name) : undefined,
      memberAvatars: c.isTeam ? this.players.filter((p) => p.teamId === c.id).map((p) => p.avatar) : undefined,
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
      checkout: X01_LIKE_TYPES.has(this.type) ? this.checkoutSuggestion(this.currentCompetitor.score) : null,
      snakesAndLaddersBoard: this.type === 'snakes_and_ladders'
        ? { size: SNAKES_AND_LADDERS_BOARD_SIZE, ladders: SNAKES_AND_LADDERS_LADDERS, snakes: SNAKES_AND_LADDERS_SNAKES }
        : null,
      donkeyRaceTrackLength: this.type === 'donkey_race' ? DONKEY_RACE_TRACK_LENGTH : null,
    };
  }
}

module.exports = { Game, scoreValue, label, isValidThrow, AROUND_THE_CLOCK_SEQUENCE, HALVE_IT_ROUNDS };

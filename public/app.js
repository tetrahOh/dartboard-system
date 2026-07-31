(function () {
  let gameId = null;
  let ws = null;

  // ---------- Setup state ----------
  let mode = { type: 'x01', startScore: 501 };
  let doubleOut = true;
  let legsToWin = 1;
  let livesStart = 3;
  let teamsEnabled = false;
  let nextTeamNum = 1;
  const MAX_PLAYERS = 10;
  const TEAM_COLORS = ['#ff3ea8', '#2fe8ff', '#c6ff5a', '#ff8a3d', '#8b5cf6', '#ffd23f'];
  const AVATARS = ['🐶', '🐱', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐸', '🐵', '🐔', '🐧', '🦄', '🐙', '🐢'];

  let players = [
    { id: 'p1', name: 'Player 1', teamId: null, avatar: AVATARS[0] },
    { id: 'p2', name: 'Player 2', teamId: null, avatar: AVATARS[1] },
  ];
  let teams = [];
  let avatarPickerOpenFor = null;

  const LEGS_MODES = new Set(['x01', 'cricket']);
  const LIVES_MODES = new Set(['killer', 'limit']);

  // ---------- How-to-play tutorials ----------
  const TUTORIAL_TITLES = {
    x01: 'How to play X01', cricket: 'How to play Cricket',
    around_the_clock: 'How to play Around the Clock', killer: 'How to play Killer',
    shanghai: 'How to play Shanghai', halve_it: 'How to play Halve It', limit: 'How to play Limit',
  };
  const TUTORIALS = {
    x01: [
      { icon: '🎯', text: 'Start at 501 (or 301 / 701)' },
      { icon: '🎯', text: 'Throw 3 darts a turn', example: 'T20 = -60 points' },
      { icon: '🔢', text: 'Get to exactly 0 to win' },
      { icon: '✅', text: 'Your last dart must be a DOUBLE', example: 'D20 finishes 40', bad: 'Go below 0, or land on 1 — BUST' },
    ],
    cricket: [
      { icon: '🎯', text: 'Close 15, 16, 17, 18, 19, 20 & Bull' },
      { icon: '🔓', text: 'Hit a number 3 times to open it', example: 'S = 1 mark  D = 2  T = 3' },
      { icon: '💰', text: "Extra hits SCORE — if rivals haven't closed it yet" },
      { icon: '🏆', text: 'Close everything + highest score wins' },
    ],
    around_the_clock: [
      { icon: '🔢', text: 'Hit 1, 2, 3 … up to 20, then Bull — in order' },
      { icon: '🎯', text: 'Any hit on your number advances you', example: 'Single, double, or triple all count' },
      { icon: '❌', text: 'Miss your number? Try again next turn' },
      { icon: '🏁', text: 'First to hit Bull after 20 wins!' },
    ],
    killer: [
      { icon: '🔢', text: 'Everyone gets a random number' },
      { icon: '🔪', text: 'Double your own number to go KILLER' },
      { icon: '💥', text: "Then hit opponents' numbers to take their lives" },
      { icon: '🏆', text: 'Last player with lives left wins!' },
    ],
    shanghai: [
      { icon: '🔢', text: '20 rounds — round 1 targets 1, round 2 targets 2…' },
      { icon: '🎯', text: "Score by hitting THIS round's number", example: 'Single, Double, Triple all count' },
      { icon: '🎉', text: 'S + D + T of it in ONE turn = SHANGHAI', example: 'Instant win!' },
      { icon: '🏆', text: 'Otherwise, highest score after 20 rounds wins' },
    ],
    halve_it: [
      { icon: '🎯', text: 'Each round has a target', example: 'A number, any double, any triple, or Bull' },
      { icon: '💰', text: 'Hit it this turn and you score points' },
      { icon: '😬', text: 'Miss completely and your ENTIRE score is HALVED' },
      { icon: '🏆', text: 'Highest score after all rounds wins' },
    ],
    limit: [
      { icon: '👑', text: 'Each round, one player is the SETTER' },
      { icon: '📉', text: 'Their dart sets the limit', example: 'It can only go LOWER than before' },
      { icon: '❤️', text: 'Everyone else: beat the limit, or lose a life' },
      { icon: '🏆', text: '3 lives each — last one standing wins!' },
    ],
  };

  function openTutorial(modeKey) {
    const steps = TUTORIALS[modeKey];
    if (!steps) return;
    document.getElementById('tutorial-title').textContent = TUTORIAL_TITLES[modeKey] || 'How to play';
    const cycle = `${steps.length * 3}s`;
    const slidesEl = document.getElementById('tutorial-slides');
    const dotsEl = document.getElementById('tutorial-dots');
    slidesEl.innerHTML = '';
    dotsEl.innerHTML = '';
    steps.forEach((step, i) => {
      const delay = `${i * 3}s`;
      const slide = document.createElement('div');
      slide.className = 'tutorial-slide';
      slide.style.setProperty('--cycle', cycle);
      slide.style.setProperty('--delay', delay);
      slide.innerHTML = `<div class="icon">${step.icon}</div><div class="text">${step.text}</div>` +
        (step.example ? `<div class="example">${step.example}</div>` : '') +
        (step.bad ? `<div class="example bad">${step.bad}</div>` : '');
      slidesEl.appendChild(slide);

      const dot = document.createElement('div');
      dot.className = 'tutorial-dot';
      dot.style.setProperty('--cycle', cycle);
      dot.style.setProperty('--delay', delay);
      dotsEl.appendChild(dot);
    });
    document.getElementById('tutorial-overlay').classList.remove('hidden');
  }

  function closeTutorial() {
    document.getElementById('tutorial-overlay').classList.add('hidden');
  }

  document.getElementById('tutorial-close').addEventListener('click', closeTutorial);
  document.getElementById('tutorial-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'tutorial-overlay') closeTutorial();
  });

  const playerList = document.getElementById('player-list');
  const playerCountNote = document.getElementById('player-count-note');
  const teamsPanel = document.getElementById('teams-panel');

  function renderPlayerRows() {
    playerList.innerHTML = '';
    players.forEach((p, i) => {
      if (!p.avatar) p.avatar = AVATARS[i % AVATARS.length];

      const row = document.createElement('div');
      row.className = 'player-row';

      const avatarBtn = document.createElement('button');
      avatarBtn.type = 'button';
      avatarBtn.className = 'avatar-btn';
      avatarBtn.textContent = p.avatar;
      avatarBtn.setAttribute('aria-label', 'Choose avatar');
      avatarBtn.addEventListener('click', () => {
        avatarPickerOpenFor = avatarPickerOpenFor === p.id ? null : p.id;
        renderPlayerRows();
      });
      row.appendChild(avatarBtn);

      const input = document.createElement('input');
      input.type = 'text';
      input.value = p.name;
      input.placeholder = 'Player name';
      input.addEventListener('input', () => { p.name = input.value; });
      row.appendChild(input);

      if (teamsEnabled && teams.length) {
        const teamSelect = document.createElement('div');
        teamSelect.className = 'team-select';
        teams.forEach((t) => {
          const chip = document.createElement('div');
          chip.className = 'team-chip' + (p.teamId === t.id ? ' active' : '');
          chip.textContent = t.name;
          if (p.teamId === t.id) chip.style.background = t.color;
          chip.addEventListener('click', () => { p.teamId = t.id; renderPlayerRows(); });
          teamSelect.appendChild(chip);
        });
        row.appendChild(teamSelect);
      }

      if (players.length > 1) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-btn';
        removeBtn.setAttribute('aria-label', 'Remove');
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', () => { players.splice(i, 1); renderPlayerRows(); });
        row.appendChild(removeBtn);
      }
      playerList.appendChild(row);

      if (avatarPickerOpenFor === p.id) {
        const picker = document.createElement('div');
        picker.className = 'avatar-picker';
        AVATARS.forEach((a) => {
          const opt = document.createElement('button');
          opt.type = 'button';
          opt.className = 'avatar-option' + (a === p.avatar ? ' active' : '');
          opt.textContent = a;
          opt.addEventListener('click', () => {
            p.avatar = a;
            avatarPickerOpenFor = null;
            renderPlayerRows();
          });
          picker.appendChild(opt);
        });
        playerList.appendChild(picker);
      }
    });
    playerCountNote.textContent = `${players.length}/${MAX_PLAYERS} players`;
    document.getElementById('add-player').classList.toggle('hidden', players.length >= MAX_PLAYERS);
  }

  document.getElementById('add-player').addEventListener('click', () => {
    if (players.length >= MAX_PLAYERS) return;
    let teamId = null;
    if (teamsEnabled && teams.length) {
      const counts = teams.map((t) => players.filter((p) => p.teamId === t.id).length);
      teamId = teams[counts.indexOf(Math.min(...counts))].id;
    }
    players.push({ id: `p${Date.now()}${players.length}`, name: `Player ${players.length + 1}`, teamId, avatar: AVATARS[players.length % AVATARS.length] });
    renderPlayerRows();
  });

  // ---------- Mode grid ----------
  document.getElementById('mode-grid').addEventListener('click', (e) => {
    const howTo = e.target.closest('.how-to-btn');
    if (howTo) {
      openTutorial(howTo.dataset.tutorial);
      return;
    }
    const el = e.target.closest('.mode-card');
    if (!el) return;
    [...el.parentElement.children].forEach((c) => c.classList.remove('active'));
    el.classList.add('active');
    mode = { type: el.dataset.mode, startScore: el.dataset.score ? Number(el.dataset.score) : undefined };

    document.getElementById('x01-options').classList.toggle('hidden', mode.type !== 'x01');
    document.getElementById('legs-card').classList.toggle('hidden', !LEGS_MODES.has(mode.type));
    document.getElementById('lives-card').classList.toggle('hidden', !LIVES_MODES.has(mode.type));
  });

  document.getElementById('x01-options').addEventListener('click', (e) => {
    const el = e.target.closest('.choice');
    if (!el) return;
    [...el.parentElement.children].forEach((c) => c.classList.remove('active'));
    el.classList.add('active');
    doubleOut = el.dataset.double === 'true';
  });

  document.getElementById('legs-choices').addEventListener('click', (e) => {
    const el = e.target.closest('.choice');
    if (!el) return;
    [...el.parentElement.children].forEach((c) => c.classList.remove('active'));
    el.classList.add('active');
    legsToWin = Number(el.dataset.legs);
  });

  document.getElementById('lives-choices').addEventListener('click', (e) => {
    const el = e.target.closest('.choice');
    if (!el) return;
    [...el.parentElement.children].forEach((c) => c.classList.remove('active'));
    el.classList.add('active');
    livesStart = Number(el.dataset.lives);
  });

  // ---------- Teams ----------
  function addTeam() {
    const color = TEAM_COLORS[teams.length % TEAM_COLORS.length];
    teams.push({ id: `t${Date.now()}${teams.length}`, name: `Team ${nextTeamNum}`, color });
    nextTeamNum += 1;
  }

  document.getElementById('teams-off').addEventListener('click', () => setTeamsEnabled(false));
  document.getElementById('teams-on').addEventListener('click', () => setTeamsEnabled(true));

  function setTeamsEnabled(on) {
    teamsEnabled = on;
    document.getElementById('teams-off').classList.toggle('active', !on);
    document.getElementById('teams-on').classList.toggle('active', on);
    teamsPanel.classList.toggle('hidden', !on);
    if (on && teams.length === 0) {
      addTeam();
      addTeam();
      players.forEach((p, i) => { p.teamId = teams[i % teams.length].id; });
    }
    renderPlayerRows();
  }

  document.getElementById('add-team').addEventListener('click', () => {
    addTeam();
    renderPlayerRows();
  });

  document.getElementById('shuffle-teams').addEventListener('click', () => {
    if (!teams.length) return;
    const shuffled = [...players];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    shuffled.forEach((p, i) => { p.teamId = teams[i % teams.length].id; });
    renderPlayerRows();
  });

  renderPlayerRows();

  // ---------- Start game ----------
  document.getElementById('start-btn').addEventListener('click', async () => {
    let payloadPlayers = players.map((p) => ({ id: p.id, name: p.name.trim() || 'Player', teamId: teamsEnabled ? p.teamId : undefined, avatar: p.avatar }));

    if (teamsEnabled && teams.length) {
      // interleave players by team, round-robin, so turns alternate fairly across teams
      const byTeam = teams.map((t) => payloadPlayers.filter((p) => p.teamId === t.id));
      const interleaved = [];
      let more = true;
      let round = 0;
      while (more) {
        more = false;
        byTeam.forEach((group) => {
          if (group[round]) { interleaved.push(group[round]); more = true; }
        });
        round += 1;
      }
      payloadPlayers = interleaved;
    }

    const body = {
      type: mode.type,
      startScore: mode.startScore,
      doubleOut,
      legsToWin: LEGS_MODES.has(mode.type) ? legsToWin : 1,
      livesStart: LIVES_MODES.has(mode.type) ? livesStart : 3,
      players: payloadPlayers,
      teams: teamsEnabled && teams.length ? teams.map((t) => ({ id: t.id, name: t.name })) : undefined,
    };

    const res = await fetch('/api/game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const state = await res.json();
    gameId = state.id;
    document.getElementById('setup').classList.add('hidden');
    document.getElementById('game').classList.remove('hidden');
    connectWS();
    render(state);
  });

  // ---------- WebSocket live sync ----------
  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'subscribe', gameId })));
    ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'state' && msg.game.id === gameId) render(msg.game);
    });
    ws.addEventListener('close', () => setTimeout(connectWS, 1500));
  }

  // ---------- Throw input ----------
  document.addEventListener('dart-segment', async (e) => {
    if (!gameId) return;
    await sendThrow(e.detail.segment, e.detail.multiplier);
  });
  document.getElementById('miss-btn').addEventListener('click', () => sendThrow('MISS', 1));
  document.getElementById('undo-btn').addEventListener('click', async () => {
    render(await postJSON(`/api/game/${gameId}/undo`));
  });
  document.getElementById('end-game-btn').addEventListener('click', endGame);
  document.getElementById('new-game-btn').addEventListener('click', endGame);

  async function endGame() {
    if (gameId) {
      try { await fetch(`/api/game/${gameId}`, { method: 'DELETE' }); } catch (e) { /* best-effort cleanup */ }
    }
    location.reload();
  }

  function makeThrowId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // Throws are sent one at a time, each waiting for the previous request to
  // fully resolve (including its retries) before the next is sent - without
  // this, several darts thrown while offline could each retry independently
  // and land at the server in a different order than they were thrown.
  let throwQueue = Promise.resolve();

  function sendThrow(segment, multiplier) {
    const throwId = makeThrowId();
    throwQueue = throwQueue
      .then(() => postJSON(`/api/game/${gameId}/throw`, { segment, multiplier, throwId }))
      .then((state) => render(state));
    return throwQueue;
  }

  // Retries indefinitely on network failure or a non-OK response, showing a
  // visible banner the whole time - a dart was physically thrown, so the
  // score must eventually catch up once the connection recovers rather than
  // silently dropping it (matters most on venue/portable WiFi, not just
  // home use).
  async function postJSON(url, body) {
    const opts = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'POST' };
    for (;;) {
      try {
        const res = await fetch(url, opts);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        document.getElementById('connection-error').classList.add('hidden');
        return await res.json();
      } catch (err) {
        document.getElementById('connection-error').classList.remove('hidden');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // ---------- Render ----------
  function competitorStat(state, c) {
    if (state.type === 'around_the_clock') return c.target === 'BULL' ? 'B' : c.target;
    if (state.type === 'killer' || state.type === 'limit') return c.lives;
    return c.score;
  }

  function competitorBadges(state, c) {
    const badges = [];
    if (state.type === 'killer') {
      if (c.killerNumber !== undefined) badges.push(`<span class="badge killer">#${c.killerNumber}</span>`);
      if (c.isKiller) badges.push('<span class="badge killer">KILLER</span>');
    }
    if (state.type === 'around_the_clock') badges.push('<span class="badge target">next</span>');
    return badges.join('');
  }

  function render(state) {
    const board = document.getElementById('scoreboard');
    board.innerHTML = '';
    const competitors = state.teams && state.teams.length ? state.teams : state.players;

    competitors.forEach((c) => {
      const card = document.createElement('div');
      card.dataset.id = c.id;
      const isTurn = c.id === state.currentCompetitorId && state.status === 'in_progress';
      card.className = 'player-card' + (isTurn ? ' turn' : '') + (c.eliminated ? ' eliminated' : '');
      const avatar = c.isTeam
        ? `<div class="avatar-display team-avatars">${(c.memberAvatars || []).map((a) => a || '🎯').join('')}</div>`
        : `<div class="avatar-display">${c.avatar || '🎯'}</div>`;
      const members = c.isTeam && c.memberNames ? `<div class="members">${c.memberNames.join(' · ')}</div>` : '';
      const legsPips = LEGS_MODES.has(state.type) && state.legsToWin > 1
        ? `<div class="legs">${'●'.repeat(c.legsWon)}${'○'.repeat(Math.max(0, state.legsToWin - c.legsWon))}</div>` : '';
      const livesBadge = (state.type === 'killer' || state.type === 'limit') ? `<span class="badge lives">${c.lives} ♥</span>` : '';
      card.innerHTML = `${avatar}
                         <div class="name">${c.name}</div>
                         ${members}
                         <div class="score">${competitorStat(state, c)}</div>
                         ${legsPips}
                         <div class="badge-row">${livesBadge}${competitorBadges(state, c)}</div>
                         ${state.type === 'cricket' ? cricketMarksHtml(c.marks) : ''}`;
      board.appendChild(card);
    });

    for (let i = 0; i < 3; i += 1) {
      const pip = document.getElementById(`pip-${i}`);
      const t = state.currentTurnThrows[i];
      pip.textContent = t ? t.label : '—';
      pip.classList.toggle('filled', !!t);
    }

    const roundBanner = document.getElementById('round-banner');
    roundBanner.classList.toggle('hidden', !state.roundLabel);
    roundBanner.textContent = state.roundLabel || '';

    const checkoutHint = document.getElementById('checkout-hint');
    checkoutHint.textContent = state.checkout ? `Checkout: ${state.checkout.join(' → ')}` : '';

    const limitHint = document.getElementById('limit-hint');
    if (state.type === 'limit' && state.status === 'in_progress') {
      limitHint.textContent = state.limitPhase === 'setter'
        ? (state.currentLimit === null ? 'Throw to set the first limit' : `Setting a new limit (current: ${state.currentLimit})`)
        : `Beat the limit: ${state.currentLimit}`;
    } else {
      limitHint.textContent = '';
    }

    const logPanel = document.getElementById('log-panel');
    logPanel.innerHTML = state.log.map((l) => `<div>${l}</div>`).join('');

    const winnerBanner = document.getElementById('winner-banner');
    if (state.status === 'game_won') {
      document.getElementById('winner-text').textContent = state.winnerName ? `${state.winnerName} wins! 🎯` : 'Game over!';
      winnerBanner.classList.remove('hidden');
    } else {
      winnerBanner.classList.add('hidden');
    }

    triggerFlavorAnimations(state);
  }

  // ---------- Flavor animations ----------
  let lastSeenLog = null;

  function resolveCardIdFromLog(state, logLine) {
    const competitors = state.teams && state.teams.length ? state.teams : state.players;
    const directHit = competitors.find((c) => logLine.startsWith(c.name));
    if (directHit) return directHit.id;
    const player = state.players.find((p) => logLine.startsWith(p.name));
    if (!player) return null;
    if (state.teams && state.teams.length) {
      const team = state.teams.find((t) => t.id === player.teamId);
      return team ? team.id : null;
    }
    return player.id;
  }

  function flashCard(card, cls, ms) {
    if (!card) return;
    card.classList.remove(cls);
    void card.offsetWidth; // restart animation if the class is re-applied quickly
    card.classList.add(cls);
    setTimeout(() => card.classList.remove(cls), ms);
  }

  function spawnConfetti() {
    const colors = ['#ff3ea8', '#2fe8ff', '#c6ff5a', '#ff8a3d', '#8b5cf6', '#ffd23f'];
    for (let i = 0; i < 28; i += 1) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = `${Math.random() * 100}vw`;
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = `${Math.random() * 0.3}s`;
      piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 220}px`);
      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), 1900);
    }
  }

  function triggerFlavorAnimations(state) {
    const latest = state.log[0];
    if (!latest || latest === lastSeenLog) { lastSeenLog = latest; return; }
    lastSeenLog = latest;

    const id = resolveCardIdFromLog(state, latest);
    const card = id ? document.querySelector(`.player-card[data-id="${CSS.escape(id)}"]`) : null;

    if (latest.startsWith('Undo:')) {
      flashCard(card, 'anim-undo', 300);
    } else if (latest.includes('— BUST')) {
      flashCard(card, 'anim-bust', 500);
    } else if (latest.includes('becomes a KILLER')) {
      flashCard(card, 'anim-killer', 1400);
    } else if (latest.includes('is eliminated')) {
      flashCard(card, 'anim-eliminated', 900);
    } else if (latest.includes('loses a life')) {
      flashCard(card, 'anim-heartbreak', 500);
    } else if (latest.includes('score halved')) {
      flashCard(card, 'anim-halve', 500);
    } else if (latest.includes('wins') || latest.includes('SHANGHAI') || latest.includes('last one standing')) {
      flashCard(card, 'anim-win-pulse', 1200);
      spawnConfetti();
    } else if (card) {
      flashCard(card, 'anim-hit', 350);
    }
  }

  function cricketMarksHtml(marks) {
    if (!marks) return '';
    const order = [20, 19, 18, 17, 16, 15, 'BULL'];
    return `<div style="font-size:0.7rem;color:var(--muted);margin-top:0.35rem">` +
      order.map((n) => `${n === 'BULL' ? 'B' : n}:${'✓'.repeat(marks[n])}`).join('  ') +
      `</div>`;
  }
})();

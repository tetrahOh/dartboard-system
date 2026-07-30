(function () {
  let gameId = null;
  let ws = null;

  // ---------- Setup state ----------
  let mode = { type: 'x01', startScore: 501 };
  let doubleOut = true;
  let legsToWin = 1;
  let livesStart = 3;
  let teamsEnabled = false;
  let nextPlayerNum = 3;
  let nextTeamNum = 1;
  const MAX_PLAYERS = 10;
  const TEAM_COLORS = ['#ff3ea8', '#2fe8ff', '#c6ff5a', '#ff8a3d', '#8b5cf6', '#ffd23f'];

  let players = [
    { id: 'p1', name: 'Player 1', teamId: null },
    { id: 'p2', name: 'Player 2', teamId: null },
  ];
  let teams = [];

  const LEGS_MODES = new Set(['x01', 'cricket']);
  const LIVES_MODES = new Set(['killer', 'limit']);

  const playerList = document.getElementById('player-list');
  const playerCountNote = document.getElementById('player-count-note');
  const teamsPanel = document.getElementById('teams-panel');

  function renderPlayerRows() {
    playerList.innerHTML = '';
    players.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'player-row';
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
    });
    playerCountNote.textContent = `${players.length}/${MAX_PLAYERS} players`;
    document.getElementById('add-player').classList.toggle('hidden', players.length >= MAX_PLAYERS);
  }

  document.getElementById('add-player').addEventListener('click', () => {
    if (players.length >= MAX_PLAYERS) return;
    nextPlayerNum += 1;
    let teamId = null;
    if (teamsEnabled && teams.length) {
      const counts = teams.map((t) => players.filter((p) => p.teamId === t.id).length);
      teamId = teams[counts.indexOf(Math.min(...counts))].id;
    }
    players.push({ id: `p${Date.now()}${players.length}`, name: `Player ${players.length + 1}`, teamId });
    renderPlayerRows();
  });

  // ---------- Mode grid ----------
  document.getElementById('mode-grid').addEventListener('click', (e) => {
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
    let payloadPlayers = players.map((p) => ({ id: p.id, name: p.name.trim() || 'Player', teamId: teamsEnabled ? p.teamId : undefined }));

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
    const res = await fetch(`/api/game/${gameId}/undo`, { method: 'POST' });
    render(await res.json());
  });
  document.getElementById('end-game-btn').addEventListener('click', () => location.reload());
  document.getElementById('new-game-btn').addEventListener('click', () => location.reload());

  async function sendThrow(segment, multiplier) {
    const res = await fetch(`/api/game/${gameId}/throw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segment, multiplier }),
    });
    render(await res.json());
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
      const isTurn = c.id === state.currentCompetitorId && state.status === 'in_progress';
      card.className = 'player-card' + (isTurn ? ' turn' : '') + (c.eliminated ? ' eliminated' : '');
      const members = c.isTeam && c.memberNames ? `<div class="members">${c.memberNames.join(' · ')}</div>` : '';
      const legsPips = LEGS_MODES.has(state.type) && state.legsToWin > 1
        ? `<div class="legs">${'●'.repeat(c.legsWon)}${'○'.repeat(Math.max(0, state.legsToWin - c.legsWon))}</div>` : '';
      const livesBadge = (state.type === 'killer' || state.type === 'limit') ? `<span class="badge lives">${c.lives} ♥</span>` : '';
      card.innerHTML = `<div class="name">${c.name}</div>
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
  }

  function cricketMarksHtml(marks) {
    if (!marks) return '';
    const order = [20, 19, 18, 17, 16, 15, 'BULL'];
    return `<div style="font-size:0.7rem;color:var(--muted);margin-top:0.35rem">` +
      order.map((n) => `${n === 'BULL' ? 'B' : n}:${'✓'.repeat(marks[n])}`).join('  ') +
      `</div>`;
  }
})();

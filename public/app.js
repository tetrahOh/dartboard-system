(function () {
  let gameId = null;
  let ws = null;
  let gameTypeChoice = 'x01_501';
  let doubleOut = true;
  let legsToWin = 1;

  // ---------- Setup screen ----------
  const playerList = document.getElementById('player-list');

  function addPlayerRow(name) {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `<input type="text" value="${name}" placeholder="Player name">
                      <button type="button" aria-label="Remove">✕</button>`;
    row.querySelector('button').addEventListener('click', () => {
      if (playerList.children.length > 1) row.remove();
    });
    playerList.appendChild(row);
  }
  addPlayerRow('Player 1');
  addPlayerRow('Player 2');
  document.getElementById('add-player').addEventListener('click', () => addPlayerRow(`Player ${playerList.children.length + 1}`));

  document.getElementById('game-type-choices').addEventListener('click', (e) => {
    const el = e.target.closest('.choice');
    if (!el) return;
    [...el.parentElement.children].forEach((c) => c.classList.remove('active'));
    el.classList.add('active');
    gameTypeChoice = el.dataset.value;
    document.getElementById('x01-options').classList.toggle('hidden', gameTypeChoice === 'cricket');
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

  document.getElementById('start-btn').addEventListener('click', async () => {
    const names = [...playerList.querySelectorAll('input')].map((i) => i.value.trim() || 'Player');
    const players = names.map((name, i) => ({ id: `p${i + 1}`, name }));
    const type = gameTypeChoice.startsWith('x01') ? 'x01' : 'cricket';
    const startScore = gameTypeChoice === 'x01_301' ? 301 : gameTypeChoice === 'x01_701' ? 701 : 501;

    const res = await fetch('/api/game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, startScore, doubleOut, players, legsToWin }),
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
  function render(state) {
    const board = document.getElementById('scoreboard');
    board.innerHTML = '';
    state.players.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'player-card' + (i === state.currentPlayerIndex && state.status === 'in_progress' ? ' turn' : '');
      const scoreDisplay = state.type === 'cricket' ? p.score : p.score;
      card.innerHTML = `<div class="name">${p.name}</div>
                         <div class="score">${scoreDisplay}</div>
                         <div class="legs">${'●'.repeat(p.legsWon)}${'○'.repeat(Math.max(0, state.legsToWin ? state.legsToWin - p.legsWon : 0))}</div>
                         ${state.type === 'cricket' ? cricketMarksHtml(p.marks) : ''}`;
      board.appendChild(card);
    });

    for (let i = 0; i < 3; i++) {
      const pip = document.getElementById(`pip-${i}`);
      const t = state.currentTurnThrows[i];
      pip.textContent = t ? t.label : '—';
      pip.classList.toggle('filled', !!t);
    }

    document.getElementById('checkout-hint').textContent = state.checkout ? `Checkout: ${state.checkout.join(' → ')}` : '';

    const logPanel = document.getElementById('log-panel');
    logPanel.innerHTML = state.log.map((l) => `<div>${l}</div>`).join('');

    const winnerBanner = document.getElementById('winner-banner');
    if (state.status === 'game_won') {
      const winner = state.players.find((p) => p.id === state.winnerId);
      document.getElementById('winner-text').textContent = `${winner.name} wins! 🎯`;
      winnerBanner.classList.remove('hidden');
    } else {
      winnerBanner.classList.add('hidden');
    }
  }

  function cricketMarksHtml(marks) {
    const order = [20, 19, 18, 17, 16, 15, 'BULL'];
    return `<div style="font-size:0.7rem;color:var(--muted);margin-top:0.35rem">` +
      order.map((n) => `${n === 'BULL' ? 'B' : n}:${'✓'.repeat(marks[n])}`).join('  ') +
      `</div>`;
  }
})();

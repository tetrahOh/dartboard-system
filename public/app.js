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
  // Same colors as the player-card rotation (style.css's -fill palette) so a
  // token/shield/lane marker and that player's scoreboard card read as the
  // same person at a glance, across every game-specific visualization.
  const PLAYER_TOKEN_COLORS = ['#c2126f', '#b5490f', '#7645d6', '#158080', '#3d7a1f', '#8f6000'];

  let players = [
    { id: 'p1', name: 'Player 1', teamId: null, avatar: AVATARS[0] },
    { id: 'p2', name: 'Player 2', teamId: null, avatar: AVATARS[1] },
  ];
  let teams = [];
  let avatarPickerOpenFor = null;

  // Every value here (player names, avatar fallback text, log lines) can
  // originate from another device hitting the API directly - the client's
  // own inputs aren't the only way data gets in. Anything not already known
  // to be safe markup gets run through this before going into innerHTML.
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // ---------- Photo avatars ----------
  // Only ever produced by resizeToAvatarPhoto() below, but validated again
  // here anyway before ever being interpolated into innerHTML - a
  // well-formed base64 data URL can't contain the characters needed to
  // break out of an HTML attribute, so this check is what makes that safe.
  function isPhotoAvatar(avatar) {
    return typeof avatar === 'string' && /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar);
  }
  function avatarInnerHtml(avatar, fallback) {
    if (isPhotoAvatar(avatar)) return `<img class="avatar-img" src="${avatar}" alt="">`;
    return escapeHtml(avatar || fallback || '🎯');
  }

  // Fits the whole photo into a square canvas (letterboxed, not cropped) and
  // downsizes before encoding, since the full game state (including every
  // player's avatar) gets rebroadcast over the WebSocket on every single
  // dart thrown - an uncompressed photo there would multiply that traffic
  // a lot for no visible benefit at avatar size.
  function resizeToAvatarPhoto(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('invalid image'));
        img.onload = () => {
          const size = 160;
          const scale = Math.min(size / img.width, size / img.height);
          const drawW = img.width * scale;
          const drawH = img.height * scale;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(img, 0, 0, img.width, img.height, (size - drawW) / 2, (size - drawH) / 2, drawW, drawH);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  let avatarPhotoTargetId = null;
  const avatarPhotoInput = document.getElementById('avatar-photo-input');
  avatarPhotoInput.addEventListener('change', async () => {
    const file = avatarPhotoInput.files[0];
    avatarPhotoInput.value = ''; // reset so picking the same file again still fires 'change'
    if (!file || !avatarPhotoTargetId) return;
    try {
      const dataUrl = await resizeToAvatarPhoto(file);
      const target = players.find((p) => p.id === avatarPhotoTargetId);
      if (target) {
        target.avatar = dataUrl;
        avatarPickerOpenFor = null;
        renderPlayerRows();
      }
    } catch (e) { /* unreadable/invalid file - leave the picker open so they can retry */ }
  });

  const LEGS_MODES = new Set(['x01', 'cricket', 'tower_collapse']);
  // Tower Collapse reuses X01's rules entirely (see gameEngine.js's
  // X01_LIKE_TYPES) - it needs the same Finish (double/straight out) options.
  const X01_LIKE_MODES = new Set(['x01', 'tower_collapse']);
  const LIVES_MODES = new Set(['killer', 'limit']);

  // ---------- How-to-play tutorials ----------
  const TUTORIAL_TITLES = {
    x01: 'How to play X01', cricket: 'How to play Cricket',
    around_the_clock: 'How to play Around the Clock', killer: 'How to play Killer',
    shanghai: 'How to play Shanghai', halve_it: 'How to play Halve It', limit: 'How to play Limit',
    snakes_and_ladders: 'How to play Snakes & Ladders', tower_collapse: 'How to play Tower Collapse',
    donkey_race: 'How to play Donkey Race',
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
    snakes_and_ladders: [
      { icon: '🎯', text: 'Every dart moves you forward that many squares', example: 'T20 = 60 squares!' },
      { icon: '🪜', text: 'Land exactly on a ladder and climb straight up' },
      { icon: '🐍', text: 'Land exactly on a snake and slide back down' },
      { icon: '🏁', text: 'Land exactly on 100 to win', bad: 'Overshoot and that dart is wasted' },
    ],
    tower_collapse: [
      { icon: '🏯', text: 'Exactly the same rules as 501' },
      { icon: '🎯', text: 'Throw 3 darts a turn', example: 'T20 = -60 points' },
      { icon: '🔢', text: 'Watch your tower shrink toward zero' },
      { icon: '✅', text: 'Your last dart must be a DOUBLE', example: 'D20 finishes 40', bad: 'Go below 0, or land on 1 — BUST' },
    ],
    donkey_race: [
      { icon: '🔢', text: 'Everyone gets their own random number' },
      { icon: '🎯', text: 'Hit YOUR number to move forward', example: 'Single = 1, Double = 2, Treble = 3' },
      { icon: '❌', text: "Hit anyone else's number (or miss) — no movement" },
      { icon: '🏁', text: 'First past the finish line wins!' },
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
      avatarBtn.innerHTML = avatarInnerHtml(p.avatar);
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

        const photoOpt = document.createElement('button');
        photoOpt.type = 'button';
        photoOpt.className = 'avatar-option avatar-option-photo' + (isPhotoAvatar(p.avatar) ? ' active' : '');
        photoOpt.textContent = '📷';
        photoOpt.setAttribute('aria-label', 'Take or choose a photo');
        photoOpt.addEventListener('click', () => {
          avatarPhotoTargetId = p.id;
          avatarPhotoInput.click();
        });
        picker.appendChild(photoOpt);

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

    const showX01 = X01_LIKE_MODES.has(mode.type);
    const showLegs = LEGS_MODES.has(mode.type);
    const showLives = LIVES_MODES.has(mode.type);
    document.getElementById('x01-options').classList.toggle('hidden', !showX01);
    document.getElementById('legs-card').classList.toggle('hidden', !showLegs);
    document.getElementById('lives-card').classList.toggle('hidden', !showLives);
    // Modes with none of the three (Around the Clock, Shanghai, Halve It) would
    // otherwise leave this wrapper card visible but empty - a floating box.
    document.getElementById('rules-card').classList.toggle('hidden', !showX01 && !showLegs && !showLives);
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
    await sendThrow(e.detail.segment, e.detail.multiplier, e.detail.ring);
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

  function sendThrow(segment, multiplier, ring) {
    const throwId = makeThrowId();
    throwQueue = throwQueue
      .then(() => postJSON(`/api/game/${gameId}/throw`, { segment, multiplier, throwId, ring }))
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
    if (state.type === 'snakes_and_ladders') return `${c.score}/${state.snakesAndLaddersBoard ? state.snakesAndLaddersBoard.size : 100}`;
    if (state.type === 'donkey_race') return `${c.score}/${state.donkeyRaceTrackLength || 30}`;
    return c.score;
  }

  function snakesAndLaddersProgressHtml(state, c) {
    if (state.type !== 'snakes_and_ladders' || !state.snakesAndLaddersBoard) return '';
    const pct = Math.min(100, (c.score / state.snakesAndLaddersBoard.size) * 100);
    return `<div class="sl-track"><div class="sl-fill" style="width:${pct}%"></div></div>`;
  }

  // Shield fills from the bottom, proportional to remaining/startScore - as
  // the countdown approaches zero the tower visually shrinks/collapses,
  // matching the mode's name, while the plain number above still shows the
  // exact score for anyone who'd rather just read it.
  function towerCollapseHtml(state, c, idx) {
    if (state.type !== 'tower_collapse') return '';
    const pct = Math.max(0, Math.min(1, state.startScore ? c.score / state.startScore : 0));
    const h = 70;
    const fillH = Math.round(h * pct);
    const fillY = h - fillH;
    const color = PLAYER_TOKEN_COLORS[idx % PLAYER_TOKEN_COLORS.length];
    const clipId = `tower-clip-${escapeHtml(c.id)}`;
    return `<svg class="tower-shield" viewBox="0 0 60 ${h}">
      <defs><clipPath id="${clipId}"><path d="M4 4 L56 4 L56 44 L30 ${h - 2} L4 44 Z" /></clipPath></defs>
      <path d="M4 4 L56 4 L56 44 L30 ${h - 2} L4 44 Z" fill="rgba(255,255,255,0.18)" stroke="#fff" stroke-width="2" />
      <rect x="0" y="${fillY}" width="60" height="${fillH}" fill="${color}" clip-path="url(#${clipId})" />
    </svg>`;
  }

  // ---------- Snakes & Ladders board ----------
  const SL_CELL = 56;

  // Classic boustrophedon (back-and-forth) numbering: square 1 is bottom-left,
  // row 0 runs left-to-right, row 1 right-to-left, alternating up the board -
  // same layout as a real Snakes & Ladders board, so it reads as familiar.
  function slSquareToXY(n) {
    const row = Math.floor((n - 1) / 10);
    const posInRow = (n - 1) % 10;
    const col = row % 2 === 0 ? posInRow : 9 - posInRow;
    const gridY = 9 - row;
    return { x: col * SL_CELL + SL_CELL / 2, y: gridY * SL_CELL + SL_CELL / 2 };
  }

  function renderSnakesAndLaddersBoard(state) {
    const wrap = document.getElementById('sl-board-wrap');
    if (state.type !== 'snakes_and_ladders' || !state.snakesAndLaddersBoard) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    const boardInfo = state.snakesAndLaddersBoard;
    const size = SL_CELL * 10;
    let svg = `<rect x="0" y="0" width="${size}" height="${size}" fill="none" />`;

    for (let n = 1; n <= 100; n += 1) {
      const { x, y } = slSquareToXY(n);
      const row = Math.floor((n - 1) / 10);
      const posInRow = (n - 1) % 10;
      const col = row % 2 === 0 ? posInRow : 9 - posInRow;
      const shaded = (row + col) % 2 === 0;
      svg += `<rect x="${x - SL_CELL / 2}" y="${y - SL_CELL / 2}" width="${SL_CELL}" height="${SL_CELL}" fill="${shaded ? 'rgba(74,47,28,0.06)' : 'transparent'}" stroke="rgba(74,47,28,0.18)" />`;
      svg += `<text x="${x - SL_CELL / 2 + 5}" y="${y - SL_CELL / 2 + 15}" font-size="10" fill="rgba(74,47,28,0.55)">${n}</text>`;
    }

    Object.entries(boardInfo.ladders).forEach(([bottom, top]) => {
      const b = slSquareToXY(Number(bottom));
      const t = slSquareToXY(Number(top));
      svg += `<line x1="${b.x}" y1="${b.y}" x2="${t.x}" y2="${t.y}" stroke="#4a2f1c" stroke-width="6" stroke-linecap="round" opacity="0.85" />`;
      const dx = t.x - b.x;
      const dy = t.y - b.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * 7;
      const ny = (dx / len) * 7;
      for (let i = 1; i < 4; i += 1) {
        const rx = b.x + dx * (i / 4);
        const ry = b.y + dy * (i / 4);
        svg += `<line x1="${rx - nx}" y1="${ry - ny}" x2="${rx + nx}" y2="${ry + ny}" stroke="#4a2f1c" stroke-width="3" />`;
      }
    });

    Object.entries(boardInfo.snakes).forEach(([head, tail]) => {
      const h = slSquareToXY(Number(head));
      const t = slSquareToXY(Number(tail));
      const mx = (h.x + t.x) / 2 + (h.y - t.y) * 0.25;
      const my = (h.y + t.y) / 2 + (t.x - h.x) * 0.25;
      svg += `<path d="M ${h.x} ${h.y} Q ${mx} ${my} ${t.x} ${t.y}" stroke="#8b1e1e" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.85" />`;
      svg += `<circle cx="${h.x}" cy="${h.y}" r="9" fill="#8b1e1e" />`;
    });

    const competitors = state.teams && state.teams.length ? state.teams : state.players;
    const bySquare = {};
    competitors.forEach((c) => {
      const sq = Math.min(boardInfo.size, Math.max(1, c.score || 1));
      (bySquare[sq] = bySquare[sq] || []).push(c);
    });
    Object.entries(bySquare).forEach(([sq, group]) => {
      const { x, y } = slSquareToXY(Number(sq));
      group.forEach((c, i) => {
        const idx = competitors.indexOf(c);
        const angle = (i / group.length) * Math.PI * 2;
        const r = group.length > 1 ? SL_CELL * 0.22 : 0;
        const tx = x + Math.cos(angle) * r;
        const ty = y + Math.sin(angle) * r;
        const initial = escapeHtml((c.name || '?').trim().charAt(0).toUpperCase() || '?');
        svg += `<circle cx="${tx}" cy="${ty}" r="12" fill="${PLAYER_TOKEN_COLORS[idx % PLAYER_TOKEN_COLORS.length]}" stroke="#fff" stroke-width="2" />`;
        svg += `<text x="${tx}" y="${ty + 4}" font-size="12" font-weight="800" text-anchor="middle" fill="#fff">${initial}</text>`;
      });
    });

    const svgEl = document.getElementById('sl-board-svg');
    svgEl.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svgEl.innerHTML = svg;
  }

  // ---------- Donkey Race board ----------
  function renderDonkeyRaceBoard(state) {
    const wrap = document.getElementById('dr-board-wrap');
    if (state.type !== 'donkey_race') {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    const trackLength = state.donkeyRaceTrackLength || 30;
    const competitors = state.teams && state.teams.length ? state.teams : state.players;
    const width = 560;
    const height = Math.max(160, competitors.length * 52);
    const marginLeft = 46;
    const marginRight = 46;
    const trackWidth = width - marginLeft - marginRight;
    const laneH = height / competitors.length;

    let svg = '';
    competitors.forEach((c, idx) => {
      const laneY = idx * laneH;
      svg += `<rect x="0" y="${laneY}" width="${width}" height="${laneH}" fill="${idx % 2 === 0 ? 'rgba(74,47,28,0.04)' : 'transparent'}" />`;
      svg += `<line x1="${marginLeft}" y1="${laneY}" x2="${marginLeft}" y2="${laneY + laneH}" stroke="rgba(74,47,28,0.3)" stroke-width="2" />`;
      svg += `<line x1="${width - marginRight}" y1="${laneY}" x2="${width - marginRight}" y2="${laneY + laneH}" stroke="#8b1e1e" stroke-width="3" stroke-dasharray="4,3" />`;

      const pct = Math.min(1, (c.score || 0) / trackLength);
      const tx = marginLeft + pct * trackWidth;
      const ty = laneY + laneH / 2;
      const color = PLAYER_TOKEN_COLORS[idx % PLAYER_TOKEN_COLORS.length];
      svg += `<circle cx="${tx}" cy="${ty}" r="16" fill="${color}" stroke="#fff" stroke-width="2" />`;
      svg += `<text x="${tx}" y="${ty + 6}" font-size="16" text-anchor="middle">🐴</text>`;
      const nameLabel = escapeHtml((c.name || '?').length > 12 ? `${c.name.slice(0, 11)}…` : (c.name || '?'));
      svg += `<text x="${marginLeft - 8}" y="${ty + 4}" font-size="11" font-weight="800" text-anchor="end" fill="var(--wood-dark)">${nameLabel}</text>`;
    });

    const svgEl = document.getElementById('dr-board-svg');
    svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svgEl.innerHTML = svg;
  }

  function competitorBadges(state, c) {
    const badges = [];
    if (state.type === 'killer') {
      if (c.killerNumber !== undefined) badges.push(`<span class="badge killer">#${c.killerNumber}</span>`);
      if (c.isKiller) badges.push('<span class="badge killer">KILLER</span>');
    }
    if (state.type === 'donkey_race' && c.killerNumber !== undefined) {
      badges.push(`<span class="badge killer">Your number: ${c.killerNumber}</span>`);
    }
    if (state.type === 'around_the_clock') badges.push('<span class="badge target">next</span>');
    return badges.join('');
  }

  function render(state) {
    const board = document.getElementById('scoreboard');
    board.innerHTML = '';
    const competitors = state.teams && state.teams.length ? state.teams : state.players;

    competitors.forEach((c, idx) => {
      const card = document.createElement('div');
      card.dataset.id = c.id;
      const isTurn = c.id === state.currentCompetitorId && state.status === 'in_progress';
      card.className = 'player-card' + (isTurn ? ' turn' : '') + (c.eliminated ? ' eliminated' : '');
      const avatar = c.isTeam
        ? `<div class="avatar-display team-avatars">${(c.memberAvatars || []).map((a) => avatarInnerHtml(a, '🎯')).join('')}</div>`
        : `<div class="avatar-display">${avatarInnerHtml(c.avatar, '🎯')}</div>`;
      const members = c.isTeam && c.memberNames ? `<div class="members">${c.memberNames.map(escapeHtml).join(' · ')}</div>` : '';
      const legsPips = LEGS_MODES.has(state.type) && state.legsToWin > 1
        ? `<div class="legs">${'●'.repeat(c.legsWon)}${'○'.repeat(Math.max(0, state.legsToWin - c.legsWon))}</div>` : '';
      const livesBadge = (state.type === 'killer' || state.type === 'limit') ? `<span class="badge lives">${c.lives} ♥</span>` : '';
      card.innerHTML = `${avatar}
                         <div class="name">${escapeHtml(c.name)}</div>
                         ${members}
                         <div class="score">${competitorStat(state, c)}</div>
                         ${legsPips}
                         <div class="badge-row">${livesBadge}${competitorBadges(state, c)}</div>
                         ${state.type === 'cricket' ? cricketMarksHtml(c.marks) : ''}
                         ${snakesAndLaddersProgressHtml(state, c)}
                         ${towerCollapseHtml(state, c, idx)}`;
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

    renderSnakesAndLaddersBoard(state);
    renderDonkeyRaceBoard(state);

    const logPanel = document.getElementById('log-panel');
    logPanel.innerHTML = state.log.map((l) => `<div>${escapeHtml(l)}</div>`).join('');

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
    } else if (latest.includes('climbs a ladder')) {
      flashCard(card, 'anim-win-pulse', 600);
    } else if (latest.includes('slides down a snake')) {
      flashCard(card, 'anim-bust', 500);
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

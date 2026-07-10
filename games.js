/* ============================================================
   UltraPod — games.js
   Click-wheel arcade. Self-contained: each game draws everything
   (play field + HUD + overlays) onto a single <canvas>, so ui.js
   only has to mount one, feed it wheel/center/touch input, and
   stop() it on the way out.

   Public API (window.Games):
     Games.list                 - [{ id, name, tagline, icon }]  for the menu
     Games.mount(id, canvas, o)  - build + start a game, returns an instance:
         inst.move(dir)          - wheel notch / arrow  (dir = -1 / +1)
         inst.pointerAt(fx, fy)  - touch position, fractions 0..1 of the field
         inst.press()            - center / tap / Enter   (serve · reveal · restart)
         inst.alt?()             - secondary (Minesweeper flag): center-hold / long-press / F
         inst.stop()             - cancel the RAF loop

   opts: { sound }  where sound = UI's Feedback ({ blip, haptic }).
   ============================================================ */
const Games = (() => {
  // The screen is a fixed 360x412 design surface (ui.js scales the whole
  // .screen with a CSS transform), so we render in those logical units and
  // back the canvas at devicePixelRatio for crispness.
  const CSSW = 360, CSSH = 412;

  function fitCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(CSSW * dpr);
    canvas.height = Math.round(CSSH * dpr);
    canvas.style.width = CSSW + 'px';
    canvas.style.height = CSSH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // draw in 360x412 logical space
    return ctx;
  }

  // no-op sound so a game never crashes if opts.sound is missing
  const SILENT = { blip() {}, haptic() {} };

  // ---- shared drawing helpers ----------------------------------------
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawBanner(ctx, title, sub) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const bh = 78, by = (CSSH - bh) / 2 + 10;
    ctx.fillRect(0, by, CSSW, bh);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 22px -apple-system, "SF Pro Display", system-ui, sans-serif';
    ctx.fillText(title, CSSW / 2, by + 30);
    ctx.fillStyle = '#b8b8bf';
    ctx.font = '500 12px -apple-system, "SF Pro Text", system-ui, sans-serif';
    ctx.fillText(sub, CSSW / 2, by + 55);
  }

  // ================================================================
  //  BRICK  (Breakout) — the iPod classic. Wheel slides the paddle.
  // ================================================================
  function makeBrick(canvas, opts) {
    const ctx = fitCanvas(canvas);
    const sound = opts && opts.sound ? opts.sound : SILENT;

    const HUD_H = 30;
    const FIELD_TOP = HUD_H + 6;
    const WALL = 8;
    const COLS = 7, ROWS = 5;
    const B_GAP = 5;
    const B_MARGIN = 14;
    const B_TOP = FIELD_TOP + 14;
    const B_W = (CSSW - 2 * B_MARGIN - (COLS - 1) * B_GAP) / COLS;
    const B_H = 15;
    const PADDLE_W0 = 64, PADDLE_H = 10;
    const PADDLE_Y = CSSH - 34;
    const BALL_R = 5;
    const WHEEL_STEP = 24;            // px per keyboard/step
    const PX_PER_DEG = 1.9;           // smooth wheel: paddle px per degree of rotation

    const ROW_COLOR = ['#ff5d5d', '#ff9f43', '#ffd93d', '#4bd07a', '#4aa3ff'];

    let hi = 0;
    try { hi = parseInt(localStorage.getItem('ultrapod_brick_hi') || '0', 10) || 0; } catch (e) {}

    let bricks = [];
    let paddle = { x: (CSSW - PADDLE_W0) / 2, w: PADDLE_W0 };
    let ball = { x: 0, y: 0, vx: 0, vy: 0 };
    let level = 1, score = 0, lives = 3;
    let phase = 'ready';              // ready | playing | over
    let speed = 210;
    let raf = null, last = 0, alive = true;

    function buildBricks() {
      bricks = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          bricks.push({
            x: B_MARGIN + c * (B_W + B_GAP),
            y: B_TOP + r * (B_H + B_GAP),
            alive: true,
            color: ROW_COLOR[r % ROW_COLOR.length],
            points: (ROWS - r) * 10
          });
        }
      }
    }
    function resetBall() {
      ball.x = paddle.x + paddle.w / 2;
      ball.y = PADDLE_Y - BALL_R - 1;
      ball.vx = 0; ball.vy = 0;
      phase = 'ready';
    }
    function startLevel() {
      buildBricks();
      paddle.w = PADDLE_W0;
      paddle.x = (CSSW - paddle.w) / 2;
      speed = 210 + (level - 1) * 26;
      resetBall();
    }
    function newGame() { level = 1; score = 0; lives = 3; startLevel(); }

    function launch() {
      const dir = (score % 2 === 0) ? -1 : 1;
      ball.vx = dir * speed * 0.5;
      ball.vy = -Math.abs(speed * 0.86);
      phase = 'playing';
      sound.blip(760, 0.06, 0.05, 'sine');
    }
    function press() {
      if (phase === 'ready') { launch(); return; }
      if (phase === 'over') { newGame(); return; }
    }
    function clampPaddle() {
      const min = WALL, max = CSSW - WALL - paddle.w;
      if (paddle.x < min) paddle.x = min;
      if (paddle.x > max) paddle.x = max;
    }
    function move(dir) {
      paddle.x += dir * WHEEL_STEP;
      clampPaddle();
      if (phase === 'ready') ball.x = paddle.x + paddle.w / 2;
    }
    // smooth wheel: continuous angular delta (deg) -> proportional paddle glide
    function spin(deg) {
      paddle.x += deg * PX_PER_DEG;
      clampPaddle();
      if (phase === 'ready') ball.x = paddle.x + paddle.w / 2;
    }
    function pointerAt(fx) {
      paddle.x = fx * CSSW - paddle.w / 2;
      clampPaddle();
      if (phase === 'ready') ball.x = paddle.x + paddle.w / 2;
    }
    function loseLife() {
      lives--;
      sound.blip(180, 0.09, 0.22, 'sawtooth');
      sound.haptic(20);
      if (lives <= 0) { phase = 'over'; saveHi(); }
      else resetBall();
    }
    function saveHi() {
      if (score > hi) { hi = score; try { localStorage.setItem('ultrapod_brick_hi', String(hi)); } catch (e) {} }
    }

    function step(dt) {
      if (phase !== 'playing') return;
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;

      if (ball.x - BALL_R < WALL) { ball.x = WALL + BALL_R; ball.vx = Math.abs(ball.vx); sound.blip(520, 0.04, 0.03); }
      else if (ball.x + BALL_R > CSSW - WALL) { ball.x = CSSW - WALL - BALL_R; ball.vx = -Math.abs(ball.vx); sound.blip(520, 0.04, 0.03); }
      if (ball.y - BALL_R < FIELD_TOP) { ball.y = FIELD_TOP + BALL_R; ball.vy = Math.abs(ball.vy); sound.blip(520, 0.04, 0.03); }

      if (ball.vy > 0 &&
          ball.y + BALL_R >= PADDLE_Y &&
          ball.y + BALL_R <= PADDLE_Y + PADDLE_H + 6 &&
          ball.x >= paddle.x - BALL_R && ball.x <= paddle.x + paddle.w + BALL_R) {
        const hit = (ball.x - (paddle.x + paddle.w / 2)) / (paddle.w / 2);
        const spd = Math.hypot(ball.vx, ball.vy) || speed;
        const ang = hit * (Math.PI / 3);
        ball.vx = Math.sin(ang) * spd;
        ball.vy = -Math.abs(Math.cos(ang) * spd);
        ball.y = PADDLE_Y - BALL_R - 1;
        sound.blip(680, 0.05, 0.04, 'sine');
      }

      for (const b of bricks) {
        if (!b.alive) continue;
        if (ball.x + BALL_R < b.x || ball.x - BALL_R > b.x + B_W ||
            ball.y + BALL_R < b.y || ball.y - BALL_R > b.y + B_H) continue;
        b.alive = false;
        score += b.points;
        sound.blip(900, 0.05, 0.04, 'square');
        sound.haptic(6);
        const overlapX = Math.min(ball.x + BALL_R - b.x, b.x + B_W - (ball.x - BALL_R));
        const overlapY = Math.min(ball.y + BALL_R - b.y, b.y + B_H - (ball.y - BALL_R));
        if (overlapX < overlapY) ball.vx = -ball.vx; else ball.vy = -ball.vy;
        break;
      }

      if (ball.y - BALL_R > CSSH) loseLife();

      if (phase === 'playing' && !bricks.some(b => b.alive)) {
        saveHi(); level++; startLevel(); phase = 'ready';
      }
    }

    function draw() {
      ctx.fillStyle = '#07080b';
      ctx.fillRect(0, 0, CSSW, CSSH);

      ctx.textBaseline = 'middle';
      ctx.font = '600 13px -apple-system, "SF Pro Text", system-ui, sans-serif';
      ctx.fillStyle = '#eaeaea';
      ctx.textAlign = 'left';
      ctx.fillText(String(score).padStart(4, '0'), 12, HUD_H / 2 + 1);
      ctx.fillStyle = '#6a6a70';
      ctx.font = '600 10px -apple-system, "SF Pro Text", system-ui, sans-serif';
      ctx.fillText('HI ' + String(Math.max(hi, score)), 66, HUD_H / 2 + 1);
      for (let i = 0; i < lives; i++) {
        ctx.fillStyle = '#eaeaea';
        ctx.beginPath();
        ctx.arc(CSSW - 14 - i * 15, HUD_H / 2 + 1, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, FIELD_TOP - 0.5); ctx.lineTo(CSSW, FIELD_TOP - 0.5); ctx.stroke();

      for (const b of bricks) {
        if (!b.alive) continue;
        ctx.fillStyle = b.color;
        roundRect(ctx, b.x, b.y, B_W, B_H, 3); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        roundRect(ctx, b.x, b.y, B_W, B_H * 0.42, 3); ctx.fill();
      }

      ctx.fillStyle = '#1ed760';
      roundRect(ctx, paddle.x, PADDLE_Y, paddle.w, PADDLE_H, PADDLE_H / 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      roundRect(ctx, paddle.x + 3, PADDLE_Y + 1.5, paddle.w - 6, PADDLE_H * 0.4, 2); ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2); ctx.fill();

      if (phase === 'ready') drawBanner(ctx, (level > 1 || score > 0) ? ('LEVEL ' + level) : 'BRICK', 'rotate to move · press ● to serve');
      else if (phase === 'over') drawBanner(ctx, 'GAME OVER', 'press ● to play again');
    }

    function frame(now) {
      if (!alive) return;
      if (!last) last = now;
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 1 / 30) dt = 1 / 30;
      step(dt);
      draw();
      raf = requestAnimationFrame(frame);
    }
    function stop() { alive = false; if (raf) { cancelAnimationFrame(raf); raf = null; } }

    newGame();
    raf = requestAnimationFrame(frame);
    return { move, spin, pointerAt, press, stop };
  }

  // ================================================================
  //  SNAKE — the whole wheel is a trackpad: swipe a direction and the
  //  snake heads that way. (Rotary/keyboard turning kept as a fallback.)
  // ================================================================
  function makeSnake(canvas, opts) {
    const ctx = fitCanvas(canvas);
    const sound = opts && opts.sound ? opts.sound : SILENT;

    const HUD_H = 30;
    const CELL = 16;
    const COLS = 22, ROWS = 22;
    const FIELD_W = COLS * CELL, FIELD_H = ROWS * CELL;
    const OX = Math.round((CSSW - FIELD_W) / 2);
    const OY = HUD_H + Math.round((CSSH - HUD_H - FIELD_H) / 2);

    const DIRS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }]; // R,D,L,U (cw)

    let hi = 0;
    try { hi = parseInt(localStorage.getItem('ultrapod_snake_hi') || '0', 10) || 0; } catch (e) {}

    let snake, dir, nextDir, food, score, phase, stepMs, acc;
    let raf = null, last = 0, alive = true;

    function place() {
      const occ = new Set(snake.map(s => s.y * COLS + s.x));
      let cell;
      do { cell = Math.floor(Math.random() * COLS * ROWS); } while (occ.has(cell));
      food = { x: cell % COLS, y: Math.floor(cell / COLS) };
    }
    function newGame() {
      const cy = Math.floor(ROWS / 2);
      snake = [{ x: 6, y: cy }, { x: 5, y: cy }, { x: 4, y: cy }];
      dir = 0; nextDir = 0;
      score = 0; stepMs = 140; acc = 0;
      place();
      phase = 'ready';
    }
    let padAcc = { x: 0, y: 0 };
    function setHeading(d) {                          // d: 0=R 1=D 2=L 3=U (absolute)
      if (phase === 'over') return;
      if (phase === 'ready') phase = 'playing';
      if ((d + 2) % 4 === dir) return;                // ignore 180° reversal into self
      nextDir = d;
    }
    function move(d) {
      if (phase === 'over') return;
      if (phase === 'ready') phase = 'playing';
      nextDir = (dir + (d > 0 ? 1 : -1) + 4) % 4;     // relative turn (wheel-scroll / fallback)
    }
    // trackpad: swipe direction -> absolute heading (dominant axis wins)
    function pad(dx, dy) {
      padAcc.x += dx; padAcc.y += dy;
      const TH = 16;
      if (Math.abs(padAcc.x) < TH && Math.abs(padAcc.y) < TH) return;
      if (Math.abs(padAcc.x) >= Math.abs(padAcc.y)) setHeading(padAcc.x > 0 ? 0 : 2);  // R : L
      else setHeading(padAcc.y > 0 ? 1 : 3);                                           // D : U
      padAcc.x = 0; padAcc.y = 0;
    }
    function pointerAt() {}                           // snake ignores absolute drag position
    function press() {
      if (phase === 'ready') { phase = 'playing'; return; }
      if (phase === 'over') { newGame(); return; }
    }
    function die() {
      phase = 'over';
      sound.blip(160, 0.09, 0.25, 'sawtooth'); sound.haptic(22);
      if (score > hi) { hi = score; try { localStorage.setItem('ultrapod_snake_hi', String(hi)); } catch (e) {} }
    }
    function stepGame() {
      dir = nextDir;
      const head = snake[0];
      const nx = head.x + DIRS[dir].x, ny = head.y + DIRS[dir].y;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) return die();
      for (let i = 0; i < snake.length - 1; i++) { if (snake[i].x === nx && snake[i].y === ny) return die(); }
      snake.unshift({ x: nx, y: ny });
      if (nx === food.x && ny === food.y) {
        score++;
        sound.blip(880, 0.05, 0.05, 'square'); sound.haptic(6);
        if (stepMs > 70) stepMs -= 3;
        place();
      } else {
        snake.pop();
      }
    }

    function draw() {
      ctx.fillStyle = '#07080b'; ctx.fillRect(0, 0, CSSW, CSSH);
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = '600 13px -apple-system, "SF Pro Text", system-ui, sans-serif';
      ctx.fillStyle = '#eaeaea'; ctx.fillText('SCORE ' + score, 12, HUD_H / 2 + 1);
      ctx.textAlign = 'right'; ctx.fillStyle = '#6a6a70';
      ctx.font = '600 10px -apple-system, "SF Pro Text", system-ui, sans-serif';
      ctx.fillText('HI ' + Math.max(hi, score), CSSW - 12, HUD_H / 2 + 1);

      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      ctx.strokeRect(OX - 0.5, OY - 0.5, FIELD_W + 1, FIELD_H + 1);

      ctx.fillStyle = '#ff5d5d';
      ctx.beginPath();
      ctx.arc(OX + food.x * CELL + CELL / 2, OY + food.y * CELL + CELL / 2, CELL / 2 - 2, 0, Math.PI * 2);
      ctx.fill();

      for (let i = 0; i < snake.length; i++) {
        const s = snake[i];
        ctx.fillStyle = i === 0 ? '#1ed760' : '#17b34e';
        const pad = i === 0 ? 1 : 2;
        ctx.fillRect(OX + s.x * CELL + pad, OY + s.y * CELL + pad, CELL - 2 * pad, CELL - 2 * pad);
      }

      if (phase === 'ready') drawBanner(ctx, 'SNAKE', 'rotate to turn · press ● to start');
      else if (phase === 'over') drawBanner(ctx, 'GAME OVER', 'press ● to play again');
    }

    function frame(now) {
      if (!alive) return;
      if (!last) last = now;
      let dt = now - last; last = now;
      if (dt > 200) dt = 200;
      if (phase === 'playing') { acc += dt; while (acc >= stepMs) { acc -= stepMs; stepGame(); if (phase !== 'playing') break; } }
      draw();
      raf = requestAnimationFrame(frame);
    }
    function stop() { alive = false; if (raf) { cancelAnimationFrame(raf); raf = null; } }

    newGame();
    raf = requestAnimationFrame(frame);
    return { move, pad, pointerAt, press, stop };
  }

  // ================================================================
  //  MINESWEEPER — the whole wheel is a trackpad: swipe to move the
  //  cursor, press ● to reveal, press-and-hold to flag.
  //  (Rotary/keyboard cursor stepping kept as a fallback.)
  //  press-and-hold (center-hold / long-press / F) to flag.
  //  9x9, 10 mines, first reveal is always safe.
  // ================================================================
  function makeMinesweeper(canvas, opts) {
    const ctx = fitCanvas(canvas);
    const sound = opts && opts.sound ? opts.sound : SILENT;

    const HUD_H = 34;
    const N = 9, MINES = 10;
    const MARGIN = 18;
    const CELL = Math.floor((CSSW - 2 * MARGIN) / N);
    const BW = CELL * N;
    const OX = Math.round((CSSW - BW) / 2);
    const OY = HUD_H + 10;

    const NUMCOL = [null, '#4aa3ff', '#4bd07a', '#ff6b6b', '#b48cff', '#ff9f43', '#31c7c7', '#e6e6ea', '#9aa0ad'];

    let grid, cur, phase, flags, revealed, firstClick;
    let raf = null, alive = true;

    const I = (x, y) => y * N + x;
    const inb = (x, y) => x >= 0 && y >= 0 && x < N && y < N;

    function newGame() {
      grid = [];
      for (let i = 0; i < N * N; i++) grid.push({ mine: false, rev: false, flag: false, adj: 0 });
      cur = { x: (N / 2) | 0, y: (N / 2) | 0 };
      phase = 'ready'; flags = 0; revealed = 0; firstClick = true;
    }
    function placeMines(sx, sy) {
      const banned = new Set();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = sx + dx, y = sy + dy; if (inb(x, y)) banned.add(I(x, y)); }
      let placed = 0;
      while (placed < MINES) {
        const c = Math.floor(Math.random() * N * N);
        if (grid[c].mine || banned.has(c)) continue;
        grid[c].mine = true; placed++;
      }
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (grid[I(x, y)].mine) continue;
        let a = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (inb(nx, ny) && grid[I(nx, ny)].mine) a++; }
        grid[I(x, y)].adj = a;
      }
    }
    function flood(x, y) {
      const st = [[x, y]];
      while (st.length) {
        const [cx, cy] = st.pop();
        const cell = grid[I(cx, cy)];
        if (cell.rev || cell.flag) continue;
        cell.rev = true; revealed++;
        if (cell.adj === 0) {
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (inb(nx, ny) && !grid[I(nx, ny)].rev && !grid[I(nx, ny)].mine && !grid[I(nx, ny)].flag) st.push([nx, ny]);
          }
        }
      }
    }
    function reveal() {
      if (phase === 'over' || phase === 'won') { newGame(); return; }
      const cell = grid[I(cur.x, cur.y)];
      if (cell.flag || cell.rev) return;
      if (firstClick) { placeMines(cur.x, cur.y); firstClick = false; phase = 'playing'; }
      if (cell.mine) {
        cell.rev = true; phase = 'over';
        for (const c of grid) if (c.mine) c.rev = true;
        sound.blip(150, 0.1, 0.3, 'sawtooth'); sound.haptic(24);
        return;
      }
      flood(cur.x, cur.y);
      sound.blip(700, 0.04, 0.04, 'sine');
      if (revealed === N * N - MINES) { phase = 'won'; sound.blip(1050, 0.06, 0.12, 'square'); sound.haptic(10); }
    }
    function flag() {
      if (phase !== 'playing' && phase !== 'ready') return;
      const cell = grid[I(cur.x, cur.y)];
      if (cell.rev) return;
      cell.flag = !cell.flag; flags += cell.flag ? 1 : -1;
      sound.blip(cell.flag ? 520 : 380, 0.04, 0.04); sound.haptic(5);
    }

    function move(d) { let i = I(cur.x, cur.y); i = (i + (d > 0 ? 1 : -1) + N * N) % (N * N); cur.x = i % N; cur.y = (i / N) | 0; }
    // trackpad: swipe moves the cursor cell-by-cell (both axes)
    let padAcc = { x: 0, y: 0 };
    function pad(dx, dy) {
      padAcc.x += dx; padAcc.y += dy;
      const TH = 20;
      while (padAcc.x >= TH)  { cur.x = Math.min(N - 1, cur.x + 1); padAcc.x -= TH; }
      while (padAcc.x <= -TH) { cur.x = Math.max(0, cur.x - 1);     padAcc.x += TH; }
      while (padAcc.y >= TH)  { cur.y = Math.min(N - 1, cur.y + 1); padAcc.y -= TH; }
      while (padAcc.y <= -TH) { cur.y = Math.max(0, cur.y - 1);     padAcc.y += TH; }
    }
    function pointerAt(fx, fy) {
      const x = Math.floor((fx * CSSW - OX) / CELL), y = Math.floor((fy * CSSH - OY) / CELL);
      if (inb(x, y)) { cur.x = x; cur.y = y; }
    }
    function press() { reveal(); }
    function alt() { flag(); }

    function draw() {
      ctx.fillStyle = '#07080b'; ctx.fillRect(0, 0, CSSW, CSSH);

      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = '600 14px -apple-system, "SF Pro Text", system-ui, sans-serif';
      ctx.fillStyle = '#ff6b6b';
      ctx.fillText('⚑ ' + (MINES - flags), 16, HUD_H / 2 + 1);
      ctx.textAlign = 'right'; ctx.fillStyle = '#8e8e94';
      ctx.font = '600 10px -apple-system, "SF Pro Text", system-ui, sans-serif';
      ctx.fillText(phase === 'won' ? 'CLEARED' : phase === 'over' ? 'BOOM' : 'MINESWEEPER', CSSW - 16, HUD_H / 2 + 1);

      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const cell = grid[I(x, y)];
        const px = OX + x * CELL, py = OY + y * CELL;
        if (cell.rev) {
          ctx.fillStyle = cell.mine ? '#7a1f1f' : '#181a20';
          ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
          if (cell.mine) {
            ctx.fillStyle = '#ffffff';
            ctx.beginPath(); ctx.arc(px + CELL / 2, py + CELL / 2, CELL * 0.2, 0, Math.PI * 2); ctx.fill();
          } else if (cell.adj > 0) {
            ctx.fillStyle = NUMCOL[cell.adj] || '#eaeaea';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.font = '700 16px -apple-system, system-ui, sans-serif';
            ctx.fillText(String(cell.adj), px + CELL / 2, py + CELL / 2 + 1);
          }
        } else {
          ctx.fillStyle = '#2b2e37';
          ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
          ctx.fillStyle = 'rgba(255,255,255,0.10)';
          ctx.fillRect(px + 1, py + 1, CELL - 2, 3);
          if (cell.flag) {
            ctx.fillStyle = '#ff6b6b';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.font = '700 15px -apple-system, system-ui, sans-serif';
            ctx.fillText('⚑', px + CELL / 2, py + CELL / 2 + 1);
          }
        }
      }

      ctx.strokeStyle = '#1ed760'; ctx.lineWidth = 2;
      ctx.strokeRect(OX + cur.x * CELL + 1, OY + cur.y * CELL + 1, CELL - 2, CELL - 2);

      if (phase === 'over') drawBanner(ctx, 'BOOM', 'press ● to try again');
      else if (phase === 'won') drawBanner(ctx, 'CLEARED!', 'press ● to play again');
    }

    function frame() { if (!alive) return; draw(); raf = requestAnimationFrame(frame); }
    function stop() { alive = false; if (raf) { cancelAnimationFrame(raf); raf = null; } }

    newGame();
    raf = requestAnimationFrame(frame);
    return { move, pad, pointerAt, press, alt, stop };
  }

  // ---- registry -------------------------------------------------------
  const REGISTRY = [
    {
      id: 'brick', name: 'Brick', tagline: 'Bounce · break every block', make: makeBrick,
      icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="6" height="4" rx="1"></rect><rect x="10.5" y="4" width="6" height="4" rx="1"></rect><rect x="18" y="4" width="3" height="4" rx="1"></rect><circle cx="15" cy="13.5" r="1.7" fill="currentColor" stroke="none"></circle><rect x="7" y="19" width="10" height="2.4" rx="1.2" fill="currentColor" stroke="none"></rect></svg>'
    },
    {
      id: 'snake', name: 'Snake', tagline: 'Eat · grow · don’t bite yourself', make: makeSnake,
      icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h9a3 3 0 0 1 0 6H8a3 3 0 0 0 0 6h8"></path><circle cx="18.5" cy="17" r="1.4" fill="currentColor" stroke="none"></circle></svg>'
    },
    {
      id: 'mines', name: 'Minesweeper', tagline: 'Clear the field · flag the mines', make: makeMinesweeper,
      icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="3" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="21"></line><line x1="3" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="21" y2="12"></line><line x1="5.6" y1="5.6" x2="7.7" y2="7.7"></line><line x1="16.3" y1="16.3" x2="18.4" y2="18.4"></line><line x1="5.6" y1="18.4" x2="7.7" y2="16.3"></line><line x1="16.3" y1="7.7" x2="18.4" y2="5.6"></line></svg>'
    }
  ];

  function mount(id, canvas, opts) {
    const g = REGISTRY.find(x => x.id === id);
    if (!g || !canvas) return null;
    return g.make(canvas, opts || {});
  }

  return { list: REGISTRY, mount };
})();

window.Games = Games;

/* ============================================================
   UltraPod — ui.js
   View state machine + DOM rendering + live Spotify data.
   Exposes window.UI:
     UI.goMenu()        - MENU button
     UI.onCenter()      - center button
     UI.onScroll(d)     - scroll ring (d = +1 down / -1 up)
     UI.toast(msg)      - small overlay message
     UI.onPlayerState() - Web Playback SDK state push
   ============================================================ */
const UI = (() => {
  const el = (id) => document.getElementById(id);

  // ---- app state -----------------------------------------------------
  const state = {
    view: 'menu',
    mi: 3,                  // highlighted menu item
    sel: {},                // per-view selection index
    rows: {},               // per-view item arrays (for wheel/center/click)
    coverflow: null,        // recently-played items
    cf: { pos: 0, target: 0, raf: null },   // Cover Flow scroll position
    playlists: null,
    artists: null,
    albums: null,
    detailUris: [],
    currentUri: null,
    np: { progress_ms: 0, duration_ms: 0, is_playing: false, baseTime: 0 }
  };

  // menu item index -> action
  const VIEW_ID = {
    menu: 'view-menu', nowplaying: 'view-nowplaying', coverflow: 'view-coverflow',
    playlists: 'view-playlists', artists: 'view-artists', albums: 'view-albums',
    search: 'view-search', albumdetail: 'view-albumdetail', devices: 'view-devices'
  };

  // ---- small helpers -------------------------------------------------
  function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(ms) {
    if (!ms || ms < 0) return '0:00';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  const loadingHTML = () => '<div class="empty">Loading…</div>';
  const emptyHTML = (msg) => '<div class="empty">' + esc(msg) + '</div>';

  const EQ_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><line x1="6" y1="14" x2="6" y2="18"></line><line x1="12" y1="8" x2="12" y2="18"></line><line x1="18" y1="11" x2="18" y2="18"></line></svg>';

  // ---- deterministic gradient fallbacks (when art is null) -----------
  const GRADS = [
    'linear-gradient(158deg,#3a2566,#5d2c7e 44%,#180f26)',
    'linear-gradient(158deg,#1c4750,#0a1a1f)',
    'linear-gradient(158deg,#6e2238,#2a0e16)',
    'linear-gradient(158deg,#26356e,#0c1230)',
    'linear-gradient(158deg,#7a4a16,#2e1c0a)',
    'linear-gradient(158deg,#1f7a55,#0a2e20)',
    'linear-gradient(135deg,#2b6cb0,#1a3a5c)',
    'linear-gradient(135deg,#3a2566,#160f26)'
  ];
  const ARTIST_GRADS = [
    'radial-gradient(circle at 38% 30%, #8fb4ff, #2b4a7a)',
    'radial-gradient(circle at 38% 30%, #ffb27a, #7a3f1f)',
    'radial-gradient(circle at 38% 30%, #d7a6ff, #5d2c7e)',
    'radial-gradient(circle at 38% 30%, #9fe6c8, #1f7a55)',
    'radial-gradient(circle at 38% 30%, #c2c8d6, #444b5c)',
    'radial-gradient(circle at 38% 30%, #ff9ec4, #a14d7a)'
  ];
  // Spotify renders the Liked Songs cover as a violet gradient (kept authentic).
  const LIKED_GRAD = 'linear-gradient(135deg,#4a1fd0 0%,#7b46ef 55%,#bda1f5 100%)';

  function hash(str) {
    let h = 0; str = String(str || '');
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function gradientFor(seed, kind) {
    const arr = kind === 'artist' ? ARTIST_GRADS : GRADS;
    return arr[hash(seed) % arr.length];
  }

  // Paint an .art container: gradient fallback + optional <img> on top.
  function setArt(node, url, seed, kind) {
    if (!node) return;
    node.style.background = gradientFor(seed, kind);
    node.innerHTML = '';
    if (url) {
      const img = document.createElement('img');
      img.className = 'art-img';
      img.src = url;
      img.alt = '';
      img.onerror = function () { this.remove(); };   // reveal gradient
      node.appendChild(img);
    }
  }
  function setArtGradient(node, grad) {
    if (!node) return;
    node.style.background = grad;
    node.innerHTML = '';
  }
  // The iconic Spotify "Liked Songs" cover: purple gradient + a white heart.
  function setLikedArt(node) {
    if (!node) return;
    node.style.background = LIKED_GRAD;
    node.innerHTML = '<svg class="liked-heart" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">' +
      '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"></path></svg>';
  }

  // ===================================================================
  //  Click-wheel feedback: audio tick + haptics + on-screen pulse
  //  (the classic iPod "tick" as the highlight moves)
  // ===================================================================
  const Feedback = (() => {
    let ctx = null;

    // Lazily create / resume the AudioContext — only ever called from
    // within a user gesture (pointerdown / click) to satisfy autoplay rules.
    function resume() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { ctx = new AC(); } catch (e) { ctx = null; }
      }
      if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
      return ctx;
    }

    // iOS keeps a fresh AudioContext silent until real audio has played inside
    // a user gesture. In a standalone PWA the WebAudio click can stay silent
    // even after resume() — until an actual MEDIA ELEMENT has played and woken
    // the audio session (the "no click until music plays" bug). So on first
    // touch we (1) play a short silent <audio> element once to activate the iOS
    // audio session, and (2) play a 1-frame silent WebAudio buffer. After that
    // the oscillator ticks below are audible.
    let htmlKicked = false;
    function htmlAudioKick() {
      if (htmlKicked) return;
      htmlKicked = true;
      try {
        // ~0.2s of 8-bit mono silence at 8 kHz, as a WAV blob.
        const rate = 8000, len = Math.floor(rate * 0.2);
        const buf = new ArrayBuffer(44 + len);
        const dv = new DataView(buf);
        const s = (o, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(o + i, str.charCodeAt(i)); };
        s(0, 'RIFF'); dv.setUint32(4, 36 + len, true); s(8, 'WAVE');
        s(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
        dv.setUint16(22, 1, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate, true);
        dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
        s(36, 'data'); dv.setUint32(40, len, true);
        for (let i = 0; i < len; i++) dv.setUint8(44 + i, 128);   // 8-bit silence = 128
        const a = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
        a.setAttribute('playsinline', '');
        a.volume = 1;                 // samples are silent, so nothing is heard
        const p = a.play();
        if (p && p.catch) p.catch(() => {});
      } catch (e) {}
    }

    function unlock() {
      const c = resume();
      htmlAudioKick();                // wake the iOS media session (needed in a PWA)
      if (!c) return;
      // Replay the 1-frame silent buffer whenever the context isn't 'running'
      // (first gesture, or after iOS re-suspends it when the PWA is
      // backgrounded) to force it back to running. Guarding on state (not a
      // one-shot latch) is what makes recovery actually work.
      if (c.state !== 'running') {
        try {
          const buf = c.createBuffer(1, 1, 22050);
          const src = c.createBufferSource();
          src.buffer = buf;
          src.connect(c.destination);
          src.start(0);
        } catch (e) {}
      }
    }

    function blip(freq, peak, dur, type) {
      const c = resume();
      if (!c) return;
      const fire = () => {
        const t = c.currentTime;
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = type || 'square';
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(peak, t + 0.0012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(gain).connect(c.destination);
        osc.start(t);
        osc.stop(t + dur + 0.01);
      };
      // A blip scheduled while the context is still 'suspended' is LOST: the
      // clock is frozen at t, so by the time the async resume() lands the play
      // window is already in the past. That's the real "no click until music
      // plays" bug. Schedule only once the context is genuinely running — for
      // the first click that means firing on the resume() promise.
      if (c.state === 'running') fire();
      else { try { c.resume().then(fire).catch(() => {}); } catch (e) {} }
    }

    // --- physical haptics ----------------------------------------------
    // iOS Safari has no navigator.vibrate. The one web technique that drives
    // the Taptic Engine: toggle a hidden <input type="checkbox" switch> via
    // its <label> (iOS 17.4+). We pulse that label. navigator.vibrate covers
    // Android; older iOS just gets the audio click (graceful fallback).
    let hapticLabel = null;
    function ensureHaptic() {
      if (hapticLabel !== null) return hapticLabel;
      try {
        // Canonical iOS web-haptics form (ios-haptics): a display:none switch
        // in <head>, toggled via its label, fires the Taptic Engine on 17.4+.
        const label = document.createElement('label');
        label.setAttribute('aria-hidden', 'true');
        label.style.display = 'none';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('switch', '');
        label.appendChild(input);
        (document.head || document.documentElement).appendChild(label);
        hapticLabel = label;
      } catch (e) { hapticLabel = false; }
      return hapticLabel;
    }
    function haptic(ms) {
      if (navigator.vibrate) { try { navigator.vibrate(ms || 8); } catch (e) {} }  // Android
      const l = ensureHaptic();                                                    // iOS 17.4+
      if (l) { try { l.click(); } catch (e) {} }
    }

    // short, dry "tick" as the selection advances one step
    function tick() {
      resume();
      blip(2300, 0.05, 0.018, 'square');
      haptic(5);
    }
    // softer, lower "clunk" for a button / center press / tap
    function press() {
      resume();
      blip(820, 0.08, 0.05, 'sine');
      haptic(12);
    }

    // Prime/unlock audio on the first interactions anywhere — capture phase so
    // it runs before the wheel/button handlers fire their first blip. iOS only
    // honours certain gestures for audio unlock, so cover pointer, touch AND
    // click (the wheel scroll never fires a click; taps fire touchend/click).
    const prime = () => unlock();
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click'].forEach(ev =>
      document.addEventListener(ev, prime, { capture: true, passive: true }));

    return { resume, unlock, tick, press, haptic };
  })();

  // brief scale "pop" on a node to make the highlight feel tactile.
  // (targets carry no CSS transform of their own, so animating transform is safe)
  function pulse(node) {
    if (!node) return;
    node.classList.remove('pop');
    void node.offsetWidth;        // force reflow so the animation restarts
    node.classList.add('pop');
  }
  function activeMenuItem() {
    return document.querySelector('#menu-sidebar .menu-item.active');
  }

  // ===================================================================
  //  View routing
  // ===================================================================
  function go(view) {
    if (view !== 'search') closeKeyboard();   // leaving search restores the wheel
    state.view = view;
    Object.values(VIEW_ID).forEach(id => { const n = el(id); if (n) n.classList.remove('active'); });
    const node = el(VIEW_ID[view]);
    if (node) node.classList.add('active');

    if (view === 'nowplaying') startNpPoll(); else stopNpPoll();

    switch (view) {
      case 'menu':       loadCoverflow(); break;
      case 'coverflow':  loadCoverflow(); break;
      case 'playlists':  loadPlaylists(); break;
      case 'artists':    loadArtists();   break;
      case 'albums':     loadAlbums();    break;
      case 'search':     enterSearch();   break;
      case 'devices':    loadDevices();   break;
      // nowplaying: startNpPoll() above already does the first refresh.
    }
  }

  // MENU steps back to the sidebar from any sub-view. If we're ALREADY on the
  // sidebar, a second MENU press jumps to Now Playing (iPod-style shortcut).
  function goMenu() {
    if (menuOpen()) {                       // MENU backs out of the context menu
      if (state.menu.prev) { state.menu = Object.assign({ open: true }, state.menu.prev); renderActionMenu(); }
      else closeActionMenu();
      return;
    }
    if (state.view === 'menu') go('nowplaying');
    else go('menu');
  }

  // menu item activation
  function setMi(i) {
    state.mi = clamp(i, 0, 5);
    document.querySelectorAll('#menu-sidebar .menu-item').forEach(node => {
      node.classList.toggle('active', +node.dataset.idx === state.mi);
    });
  }

  function selMenu(i) {
    setMi(i);
    switch (i) {
      case 0: go('nowplaying'); break;
      case 1: go('coverflow');  break;   // Cover Flow (recently played)
      case 2: go('playlists');  break;
      case 3: openAllMusic();   break;   // Songs = Liked Songs as a tracklist
      case 4: go('search');     break;
      case 5: go('devices');    break;
    }
  }

  // ===================================================================
  //  Cover flow (menu mini + full)
  // ===================================================================
  function cfState() { return state.cf || (state.cf = { pos: 0, target: 0, raf: null }); }

  async function loadCoverflow() {
    if (!state.coverflow) {
      try { state.coverflow = await SpotifyAPI.getRecentlyPlayed(); }
      catch (e) { state.coverflow = []; }
      state.cf = { pos: 0, target: 0, raf: null };
    }
    renderMenuCoverflow();
    if (state.view === 'coverflow') {
      buildCoverFlow();
      positionCovers(cfState().pos);
      updateCfLabel();
    }
  }

  // The menu sidebar's small static preview (3 most-recent covers).
  function renderMenuCoverflow() {
    const items = state.coverflow || [];
    const c = items[0], l = items[1], r = items[2];
    setArt(el('menu-cf-center'), c && c.image, c ? c.albumId : 'c', 'album');
    setArt(el('menu-cf-left'),   l && l.image, l ? l.albumId : 'l', 'album');
    setArt(el('menu-cf-right'),  r && r.image, r ? r.albumId : 'r', 'album');
    el('menu-cf-title').textContent = c ? c.title : 'No recent plays';
    el('menu-cf-sub').textContent = c ? (c.artist + ' · ' + items.length + ' recent') : 'Spotify';
  }

  // Build the full 3D Cover Flow stage (one card per recently-played album).
  function buildCoverFlow() {
    const stage = el('cf-stage');
    const items = state.coverflow || [];
    if (!items.length) { stage.innerHTML = ''; return; }
    stage.innerHTML = items.map((it, i) =>
      '<div class="cf-cover" data-i="' + i + '"><div class="art cf-cover-art" data-cfart="' + i + '"></div></div>'
    ).join('');
    items.forEach((it, i) => setArt(stage.querySelector('[data-cfart="' + i + '"]'), it.image, it.albumId, 'album'));
  }

  // Continuous Cover Flow transform for a card at offset `o` from the focus.
  function coverTransform(o) {
    const A = Math.abs(o), s = o < 0 ? -1 : 1;
    const e = Math.min(A, 1);                 // ease 0..1 over the first unit of offset
    const rot = -s * e * 62;                  // center flat; right tilts -62°, left +62°
    const z = -e * 190;                       // center forward, sides pushed back in Z
    const centerGap = 109, stack = 48;        // gap to first neighbour, then tight stacking (scaled with the bigger covers)
    const x = A <= 1 ? o * centerGap : s * (centerGap + (A - 1) * stack);
    const scale = 1 - e * 0.18;               // center largest
    return { x, z, rot, scale };
  }

  function positionCovers(pos) {
    const stage = el('cf-stage');
    if (!stage) return;
    const covers = stage.children;
    for (let i = 0; i < covers.length; i++) {
      const o = i - pos, A = Math.abs(o), t = coverTransform(o);
      const c = covers[i];
      c.style.transform = 'translate(-50%,-50%) translateX(' + t.x + 'px) translateZ(' + t.z + 'px) rotateY(' + t.rot + 'deg) scale(' + t.scale + ')';
      c.style.zIndex = String(1000 - Math.round(A * 10));
      c.style.opacity = A > 4.2 ? '0' : '1';
      c.style.filter = 'brightness(' + (1 - Math.min(A, 1) * 0.5) + ')';
    }
  }

  function updateCfLabel() {
    const items = state.coverflow || [];
    const i = clamp(Math.round(cfState().pos), 0, Math.max(0, items.length - 1));
    const it = items[i];
    el('cf-title').textContent = it ? it.title : 'No recent plays';
    el('cf-sub').textContent = it ? (it.artist + ' · ' + (i + 1) + '/' + items.length) : '—';
  }

  // Inertial glide toward the snapped target index, then settle.
  function animateCoverFlow() {
    const st = cfState();
    if (st.raf) cancelAnimationFrame(st.raf);
    const step = () => {
      st.pos += (st.target - st.pos) * 0.22;
      if (Math.abs(st.target - st.pos) < 0.003) {
        st.pos = st.target; positionCovers(st.pos); updateCfLabel(); st.raf = null; return;
      }
      positionCovers(st.pos); updateCfLabel();
      st.raf = requestAnimationFrame(step);
    };
    st.raf = requestAnimationFrame(step);
  }

  function cfCurrentAlbum() {
    const items = state.coverflow || [];
    const it = items[clamp(Math.round(cfState().pos), 0, Math.max(0, items.length - 1))];
    return it ? { id: it.albumId, name: it.title, artist: it.artist, image: it.image } : null;
  }

  // ===================================================================
  //  Lists: playlists / artists / albums
  // ===================================================================
  async function loadPlaylists() {
    const cont = el('list-playlists');
    if (!state.playlists) {
      cont.innerHTML = loadingHTML();
      try { state.playlists = await SpotifyAPI.getPlaylists(); }
      catch (e) { state.playlists = []; }
    }
    state.rows.playlists = state.playlists;
    if (!state.playlists.length) { cont.innerHTML = emptyHTML('No playlists found'); return; }
    cont.innerHTML = state.playlists.map((p, idx) =>
      '<div class="list-row" data-idx="' + idx + '">' +
        '<div class="art list-art" data-art="' + idx + '"></div>' +
        '<span class="list-name">' + esc(p.name) + '</span>' +
        '<span class="list-chev"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg></span>' +
      '</div>'
    ).join('');
    state.playlists.forEach((p, idx) => setArt(cont.querySelector('[data-art="' + idx + '"]'), p.image, p.id, 'album'));
    if (state.sel.playlists == null) state.sel.playlists = 0;
    applySel('playlists');
  }

  async function loadArtists() {
    const cont = el('list-artists');
    if (!state.artists) {
      cont.innerHTML = loadingHTML();
      try { state.artists = await SpotifyAPI.getFollowedArtists(); }
      catch (e) { state.artists = []; }
    }
    state.rows.artists = state.artists;
    if (!state.artists.length) { cont.innerHTML = emptyHTML('No artists found'); return; }
    cont.innerHTML = state.artists.map((a, idx) =>
      '<div class="list-row" data-idx="' + idx + '">' +
        '<div class="art list-art" data-art="' + idx + '"></div>' +
        '<span class="list-name">' + esc(a.name) + '</span>' +
      '</div>'
    ).join('');
    state.artists.forEach((a, idx) => setArt(cont.querySelector('[data-art="' + idx + '"]'), a.image, a.id, 'artist'));
    if (state.sel.artists == null) state.sel.artists = 0;
    applySel('artists');
  }

  async function loadAlbums() {
    // The albums grid is shared with the artist page (openArtist). When showing
    // an artist, openArtist owns the fetch/render — don't refetch saved albums.
    if (state.albumsSource === 'artist') { if (state.albums) renderAlbumGrid(state.albums); return; }
    if (!state.albums || state.albumsSource !== 'saved') {
      el('grid-albums').innerHTML = loadingHTML();
      try { state.albums = await SpotifyAPI.getSavedAlbums(); }
      catch (e) { state.albums = []; }
      state.albumsSource = 'saved';
    }
    if (state.sel.albums == null) state.sel.albums = 0;
    renderAlbumGrid(state.albums);
  }

  // ===================================================================
  //  Devices (Spotify Connect picker) — pick where playback happens.
  //  On iPhone the iPod can't stream itself, so it drives a real device.
  // ===================================================================
  function deviceIcon(type) {
    const t = (type || '').toLowerCase();
    const wrap = (inner) => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
    if (t === 'smartphone') return wrap('<rect x="7" y="2.5" width="10" height="19" rx="2.5"></rect><line x1="11" y1="18.5" x2="13" y2="18.5"></line>');
    if (t === 'computer')   return wrap('<rect x="3" y="4" width="18" height="12" rx="2"></rect><line x1="8" y1="20" x2="16" y2="20"></line><line x1="12" y1="16" x2="12" y2="20"></line>');
    if (['tv', 'castvideo', 'stb', 'gameconsole'].indexOf(t) >= 0) return wrap('<rect x="2.5" y="5" width="19" height="12" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line>');
    if (['speaker', 'castaudio', 'audiodongle', 'avr', 'automobile'].indexOf(t) >= 0) return wrap('<rect x="6" y="2.5" width="12" height="19" rx="2.5"></rect><circle cx="12" cy="15" r="3.2"></circle><circle cx="12" cy="6.5" r="0.8"></circle>');
    return wrap('<rect x="3" y="4" width="18" height="12" rx="2"></rect><path d="M8 20l4-4 4 4"></path>');
  }

  async function loadDevices() {
    const cont = el('list-devices');
    cont.innerHTML = loadingHTML();
    let devices = [];
    try { devices = await SpotifyAPI.getDevices(); } catch (e) {}
    // Hide our own phantom SDK device (current + legacy name) — it can't stream.
    devices = (devices || []).filter(d => d && d.id && d.name !== 'iPod' && d.name !== 'UltraPod');
    state.rows.devices = devices;
    if (!devices.length) {
      cont.innerHTML = emptyHTML('No Spotify devices found. Open Spotify on a computer, phone or speaker and start any song, then reopen Devices.');
      return;
    }
    cont.innerHTML = devices.map((d, idx) =>
      '<div class="list-row' + (d.is_active ? ' dev-active' : '') + '" data-idx="' + idx + '">' +
        '<div class="dev-ico">' + deviceIcon(d.type) + '</div>' +
        '<div class="dev-meta">' +
          '<span class="dev-name">' + esc(d.name) + '</span>' +
          '<span class="dev-sub">' + esc(d.type || 'Device') + (d.is_restricted ? ' · limited' : '') + '</span>' +
        '</div>' +
        (d.is_active
          ? '<span class="dev-dot"></span>'
          : '<span class="list-chev"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg></span>') +
      '</div>'
    ).join('');
    // Default the highlight to the active device if there is one.
    const ai = devices.findIndex(d => d.is_active);
    state.sel.devices = ai >= 0 ? ai : 0;
    applySel('devices');
  }

  function selectDevice(d) {
    if (!d) return;
    if (d.is_restricted) { toast("Can't control " + d.name + ' from here'); return; }
    SpotifyAPI.setPreferredDevice(d.id);     // future plays target this device
    toast('Playing on ' + d.name);
    // Transfer + start (resumes a paused device), then show Now Playing.
    SpotifyAPI.transferPlayback(d.id, true).then(ok => {
      if (ok) { go('nowplaying'); }
      else toast('Could not switch to ' + d.name);
    }).catch(() => {});
  }

  // ===================================================================
  //  Album / tracklist detail
  // ===================================================================
  async function openAlbumDetail(album) {
    state.detailAlbum = album;            // reused for optimistic Now Playing art/artist
    state.detailContextUri = null;        // albums play via the track-uri list
    state.detailPlaylist = null;          // not a playlist context
    setArt(el('detail-art'), album.image, album.id || album.name, 'album');
    el('detail-title').textContent = album.name;
    el('detail-sub').textContent = album.artist + (album.year ? ' · ' + album.year : '');
    el('detail-tracks').innerHTML = loadingHTML();
    go('albumdetail');

    let tracks = [];
    try { tracks = await SpotifyAPI.getAlbumTracks(album.id); } catch (e) {}
    state.rows.albumdetail = tracks;
    state.detailUris = tracks.map(t => t.uri);
    state.sel.albumdetail = 0;
    renderTracks();
  }

  async function openAllMusic() {
    state.detailAlbum = null;             // Liked Songs: per-track art/artist comes from the rows
    state.detailContextUri = null;        // Liked Songs play via the track-uri list
    state.detailPlaylist = null;          // not a playlist context
    setLikedArt(el('detail-art'));
    el('detail-title').textContent = 'Songs';
    el('detail-sub').textContent = 'Liked Songs';
    el('detail-tracks').innerHTML = loadingHTML();
    go('albumdetail');

    let tracks = [];
    try { tracks = await SpotifyAPI.getSavedTracks(); } catch (e) {}
    el('detail-sub').textContent = tracks.length ? tracks.length + ' songs' : 'Liked Songs';
    state.rows.albumdetail = tracks;
    state.detailUris = tracks.map(t => t.uri);
    state.sel.albumdetail = 0;
    renderTracks();
  }

  // Open a playlist into the same tracklist view as albums/songs. Playback uses
  // the playlist CONTEXT (proper queue/shuffle) rather than a loose uri list.
  async function openPlaylist(pl) {
    state.detailAlbum = null;             // per-track art/artist comes from the rows
    state.detailContextUri = pl.uri;      // play in the playlist's context
    state.detailPlaylist = pl;            // enables "Remove from this Playlist"
    if (pl.image) setArt(el('detail-art'), pl.image, pl.id || pl.name, 'album');
    else setArtGradient(el('detail-art'), gradientFor(pl.id || pl.name || 'pl', 'album'));
    el('detail-title').textContent = pl.name;
    el('detail-sub').textContent = 'Playlist';
    el('detail-tracks').innerHTML = loadingHTML();
    go('albumdetail');

    let tracks = [];
    try { tracks = await SpotifyAPI.getPlaylistTracks(pl.id); } catch (e) {}
    state.rows.albumdetail = tracks;
    state.detailUris = tracks.map(t => t.uri);
    state.sel.albumdetail = 0;
    if (!tracks.length) {
      // Spotify's Feb-2026 change returns track contents only for the user's OWN
      // playlists; others come back as metadata only. We can't list them, but we
      // can still play the playlist in its context.
      el('detail-sub').textContent = 'Playlist';
      el('detail-tracks').innerHTML = emptyHTML('Spotify only lets this app list your own playlists. Press the center button to play this one.');
      return;
    }
    el('detail-sub').textContent = tracks.length + ' songs';
    renderTracks();
  }

  function renderTracks() {
    const cont = el('detail-tracks');
    const tracks = state.rows.albumdetail || [];
    if (!tracks.length) { cont.innerHTML = emptyHTML('No tracks found'); return; }
    cont.innerHTML = tracks.map((t, idx) => {
      const playing = state.currentUri && t.uri === state.currentUri;
      const selCls = state.sel.albumdetail === idx ? ' sel' : '';
      const num = playing ? EQ_ICON : (t.track_number || idx + 1);
      return '<div class="track-row' + (playing ? ' playing' : '') + selCls + '" data-idx="' + idx + '">' +
        '<span class="track-num">' + num + '</span>' +
        '<span class="track-name">' + esc(t.name) + '</span>' +
        '<span class="track-dur">' + fmtTime(t.duration_ms) + '</span>' +
      '</div>';
    }).join('');
  }

  // ===================================================================
  //  Now Playing
  // ===================================================================
  let npPoll = null;
  function startNpPoll() {
    refreshNowPlaying();
    if (npPoll) clearInterval(npPoll);
    npPoll = setInterval(refreshNowPlaying, 2000);
  }
  function stopNpPoll() {
    if (npPoll) { clearInterval(npPoll); npPoll = null; }
  }

  // Track the album/artist of the current song so "go to album / go to artist"
  // and the context menu have something to act on. SDK track objects expose
  // spotify:album:ID / spotify:artist:ID uris (no bare id) — derive id from uri.
  function uriId(uri) { const p = String(uri || '').split(':'); return p.length === 3 ? p[2] : null; }
  function setNpMeta(album, artists, trackUri, trackName) {
    const a0 = (artists && artists[0]) || null;
    state.npMeta = {
      trackUri: trackUri || null,
      trackName: trackName || '',
      album: album ? {
        id: album.id || uriId(album.uri), uri: album.uri, name: album.name,
        image: album.image || (album.images && album.images[0] && album.images[0].url) || null
      } : null,
      artist: a0 ? { id: a0.id || uriId(a0.uri), uri: a0.uri, name: a0.name } : null
    };
  }
  // npMeta is trustworthy only when it describes the track that's actually
  // current — during the optimistic window currentUri jumps ahead of npMeta.
  function npMetaFresh() { return !!(state.npMeta && state.npMeta.trackUri && state.npMeta.trackUri === state.currentUri); }

  async function refreshNowPlaying() {
    let cur = null;
    try { cur = await SpotifyAPI.getCurrentlyPlaying(); } catch (e) {}
    // After the user picks a song we optimistically paint it (showNowPlaying-
    // Optimistic); during that window we ignore a null / still-the-old-track
    // poll so the chosen song stays on screen until Spotify catches up.
    const optimistic = Date.now() < (state.npOptimisticUntil || 0);
    if (cur) {
      if (optimistic && cur.uri && state.currentUri && cur.uri !== state.currentUri) {
        if (state.view === 'albumdetail') renderTracks();
        return;                                   // stale "previous track" — wait for the new one
      }
      state.npOptimisticUntil = 0;                // real data for the new track arrived
      state.currentUri = cur.uri;
      setNpMeta(cur.album, cur.artists, cur.uri, cur.name);
      state.np = { progress_ms: cur.progress_ms, duration_ms: cur.duration_ms, is_playing: cur.is_playing, baseTime: Date.now() };
      // Only touch the Now Playing DOM if it's still the active view (a slow
      // fetch can resolve after the user navigated away).
      if (state.view === 'nowplaying') {
        el('np-title').textContent = cur.name;
        el('np-artist').textContent = cur.artist || '';
        setArt(el('np-art'), cur.image, cur.uri || cur.name, 'album');
        el('np-dur').textContent = fmtTime(cur.duration_ms);
        paintProgress();
      }
    } else if (state.view === 'nowplaying' && !optimistic) {
      // Reset the tracked state too, else the 500ms ticker keeps painting the
      // stale optimistic position on top (the "Nothing playing / 0:17" glitch).
      state.np = { progress_ms: 0, duration_ms: 0, is_playing: false, baseTime: Date.now() };
      el('np-title').textContent = 'Nothing playing';
      el('np-artist').textContent = 'Open a playlist or album to start';
      setArtGradient(el('np-art'), GRADS[0]);
      el('np-cur').textContent = '0:00';
      el('np-dur').textContent = '0:00';
      el('np-fill').style.width = '0%';
      el('np-knob').style.left = '0%';
    }
    if (state.view === 'albumdetail') renderTracks();
  }

  // Paint Now Playing immediately from known metadata when the user picks a
  // song, so it shows that track at once instead of "Nothing playing" until the
  // poll catches up. refreshNowPlaying() reconciles once Spotify reports it.
  function showNowPlayingOptimistic(meta) {
    if (!meta) return;
    if (meta.uri) state.currentUri = meta.uri;
    // Keep npMeta in step with the optimistic track (so go-to-album/artist
    // doesn't point at the PREVIOUS song); refs are filled when the picked
    // item carries them, else reconciled by the next poll.
    setNpMeta(meta.album || null, meta.artistRef ? [meta.artistRef] : (meta.artists || null), meta.uri, meta.name);
    state.np = { progress_ms: 0, duration_ms: meta.duration_ms || 0, is_playing: true, baseTime: Date.now() };
    state.npOptimisticUntil = Date.now() + 5000;
    el('np-title').textContent = meta.name || '—';
    el('np-artist').textContent = meta.artist || '';
    if (meta.image) setArt(el('np-art'), meta.image, meta.uri || meta.name, 'album');
    else setArtGradient(el('np-art'), gradientFor(meta.uri || meta.name || 'np', 'album'));
    el('np-cur').textContent = '0:00';
    el('np-dur').textContent = fmtTime(meta.duration_ms || 0);
    el('np-fill').style.width = '0%';
    el('np-knob').style.left = '0%';
  }

  function paintProgress() {
    const np = state.np;
    if (!np.duration_ms) {
      el('np-fill').style.width = '0%';
      el('np-knob').style.left = '0%';
      el('np-cur').textContent = '0:00';
      return;
    }
    let p = np.progress_ms;
    if (np.is_playing) p += (Date.now() - np.baseTime);
    if (p > np.duration_ms) p = np.duration_ms;
    const pct = (p / np.duration_ms) * 100;
    el('np-fill').style.width = pct + '%';
    el('np-knob').style.left = pct + '%';
    el('np-cur').textContent = fmtTime(p);
  }

  // SDK push -> immediate now-playing update
  function onPlayerState(s) {
    if (!s) return;
    const cur = s.track_window && s.track_window.current_track;
    if (!cur) return;
    state.currentUri = cur.uri;
    setNpMeta(cur.album, cur.artists, cur.uri, cur.name);
    state.np = { progress_ms: s.position, duration_ms: s.duration, is_playing: !s.paused, baseTime: Date.now() };
    if (state.view === 'nowplaying') {
      el('np-title').textContent = cur.name;
      el('np-artist').textContent = (cur.artists || []).map(a => a.name).join(', ');
      const img = cur.album && cur.album.images && cur.album.images[0] ? cur.album.images[0].url : null;
      setArt(el('np-art'), img, cur.uri, 'album');
      el('np-dur').textContent = fmtTime(s.duration);
      paintProgress();
    }
    if (state.view === 'albumdetail') renderTracks();
  }

  // ===================================================================
  //  Search
  // ===================================================================
  let searchTimer = null;
  let searchSeq = 0;            // guards against out-of-order search responses

  function enterSearch() {
    closeKeyboard();                 // wheel-first: land on the box + recent searches
    renderChips();
    if (!el('search-input').value.trim()) showRecent();
    state.searchFocus = 0;           // highlight the search box; the wheel can move to chips
    applySearchFocus();
    // The keyboard only appears when the user centers the search box (searchCenter),
    // animating the wheel -> keyboard morph.
  }

  function getRecent() {
    try { return JSON.parse(localStorage.getItem('spotify_recent') || '[]'); }
    catch (e) { return []; }
  }
  function addRecent(q) {
    q = (q || '').trim(); if (!q) return;
    let r = getRecent().filter(x => x.toLowerCase() !== q.toLowerCase());
    r.unshift(q); r = r.slice(0, 6);
    localStorage.setItem('spotify_recent', JSON.stringify(r));
  }
  function renderChips() {
    let r = getRecent();
    if (!r.length) r = ['lo-fi', 'ambient', 'jazz', 'focus'];
    el('search-chips').innerHTML = r.map(q => '<div class="chip" data-q="' + esc(q) + '">' + esc(q) + '</div>').join('');
    if (state.view === 'search') applySearchFocus();   // re-paint focus ring on rebuilt chips
  }
  function showRecent() {
    el('search-results').style.display = 'none';
    el('search-recent').style.display = 'block';
  }

  async function runSearch(q) {
    const myReq = ++searchSeq;
    el('search-recent').style.display = 'none';
    const cont = el('search-results');
    cont.style.display = 'block';
    cont.innerHTML = loadingHTML();

    let res;
    try { res = await SpotifyAPI.search(q); }
    catch (e) { res = { tracks: [], albums: [], artists: [] }; }
    if (myReq !== searchSeq) return;   // a newer search superseded this one
    addRecent(q);

    const flat = [];
    let html = '';
    const section = (label, items, render) => {
      if (!items.length) return;
      html += '<div class="section-label">' + label + '</div>';
      items.forEach(it => { const idx = flat.length; flat.push(it); html += render(it, idx); });
    };
    section('TRACKS', res.tracks, (it, idx) =>
      '<div class="result-row" data-idx="' + idx + '">' +
        '<div class="art result-art" data-art="' + idx + '"></div>' +
        '<span class="result-name">' + esc(it.name) + '</span>' +
        '<span class="result-sub">' + esc(it.artist) + '</span>' +
      '</div>');
    section('ARTISTS', res.artists, (it, idx) =>
      '<div class="result-row" data-idx="' + idx + '">' +
        '<div class="art result-art artist" data-art="' + idx + '"></div>' +
        '<span class="result-name">' + esc(it.name) + '</span>' +
        '<span class="result-sub">Artist</span>' +
      '</div>');
    section('ALBUMS', res.albums, (it, idx) =>
      '<div class="result-row" data-idx="' + idx + '">' +
        '<div class="art result-art" data-art="' + idx + '"></div>' +
        '<span class="result-name">' + esc(it.name) + '</span>' +
        '<span class="result-sub">' + esc(it.artist) + '</span>' +
      '</div>');

    state.rows.search = flat;
    if (!flat.length) { cont.innerHTML = emptyHTML('No results'); state.searchFocus = 0; applySearchFocus(); return; }
    cont.innerHTML = html;
    flat.forEach((it, idx) => setArt(cont.querySelector('[data-art="' + idx + '"]'), it.image, it.id, it.type === 'artist' ? 'artist' : 'album'));
    state.searchFocus = 1;             // land on the first result; scroll up reaches the box
    applySearchFocus();
  }

  // ===================================================================
  //  Search wheel-navigation + on-screen keyboard
  //  Focus model: index 0 = the search box; 1..N = the items currently shown
  //  (the RECENT chips when idle, or the result rows once a query has run).
  //  Center on the box opens the keyboard; center on an item activates it.
  // ===================================================================
  function searchFocusList() {
    const resultsShown = el('search-results').style.display !== 'none';
    const host = resultsShown ? el('search-results') : el('search-chips');
    const sel = resultsShown ? '.result-row' : '.chip';
    return { resultsShown, nodes: Array.prototype.slice.call(host.querySelectorAll(sel)) };
  }
  function applySearchFocus() {
    const { nodes } = searchFocusList();
    const f = clamp(state.searchFocus || 0, 0, nodes.length);
    state.searchFocus = f;
    const box = el('search-box');
    if (box) box.classList.toggle('sel', f === 0);
    nodes.forEach((node, i) => node.classList.toggle('sel', i === f - 1));
  }
  function searchScroll(delta) {
    const { nodes } = searchFocusList();
    const before = clamp(state.searchFocus || 0, 0, nodes.length);
    state.searchFocus = clamp(before + delta, 0, nodes.length);
    if (state.searchFocus === before) return null;       // no movement
    applySearchFocus();
    const node = state.searchFocus === 0 ? el('search-box') : nodes[state.searchFocus - 1];
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    return node;
  }
  function searchCenter() {
    if (kbdOpen()) return;                               // keyboard taps handle themselves
    const { resultsShown, nodes } = searchFocusList();
    const f = state.searchFocus || 0;
    if (f === 0) { openKeyboard(); return; }             // center on the box -> keyboard
    const node = nodes[f - 1];
    if (!node) return;
    if (resultsShown) { activate('search', +node.dataset.idx); }
    else {                                               // a RECENT chip
      clearTimeout(searchTimer);
      el('search-input').value = node.dataset.q;
      runSearch(node.dataset.q);
    }
  }

  // ---- the click-wheel keyboard (swapped in for the wheel while typing) ----
  const KBD_ALPHA = [
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l'],
    ['z','x','c','v','b','n','m']
  ];
  const KBD_NUM = [
    ['1','2','3','4','5','6','7','8','9','0'],
    ['-','/',':',';','(',')','$','&','@'],
    ['.',',','?','!','\'']
  ];
  let _kbdBuilt = false, _kbdNumeric = false;
  function kbdOpen() { const k = el('keyboard'); return !!k && k.classList.contains('kbd-open'); }

  function renderKbdRows() {
    const rows = _kbdNumeric ? KBD_NUM : KBD_ALPHA;
    const host = el('kbd-rows');
    if (!host) return;
    host.innerHTML = rows.map((row, ri) =>
      '<div class="kbd-row">' +
        row.map(ch => '<div class="kbd-key" data-ch="' + esc(ch) + '">' + esc(ch) + '</div>').join('') +
        (ri === rows.length - 1 ? '<div class="kbd-key kbd-del" data-act="del" aria-label="Delete">&#9003;</div>' : '') +
      '</div>'
    ).join('');
    const mode = el('keyboard').querySelector('.kbd-mode');
    if (mode) mode.textContent = _kbdNumeric ? 'ABC' : '123';
  }
  function buildKeyboard() {
    if (_kbdBuilt) return;
    const k = el('keyboard');
    if (!k) return;
    k.innerHTML =
      '<div class="kbd-panel">' +
        '<div class="kbd-rows" id="kbd-rows"></div>' +
        '<div class="kbd-row kbd-bottom">' +
          '<div class="kbd-key kbd-mode" data-act="mode">123</div>' +
          '<div class="kbd-key kbd-space" data-act="space">space</div>' +
          '<div class="kbd-key kbd-go" data-act="go">Search</div>' +
          '<div class="kbd-key kbd-close" data-act="close" aria-label="Close keyboard">&#10005;</div>' +
        '</div>' +
      '</div>';
    renderKbdRows();
    // pointerdown (not click): registers at the exact touch point the instant
    // the finger lands, so a tap can't be mis-hit-tested against the panel's
    // settling scale-in animation (which made keys read "one row too low").
    k.addEventListener('pointerdown', onKbdTap);
    _kbdBuilt = true;
  }
  function onKbdTap(e) {
    const key = e.target.closest('.kbd-key');
    if (!key) return;
    e.preventDefault();              // keep the search caret focused; no text-select
    Feedback.press();
    const act = key.dataset.act;
    if (act === 'del')   return kbdDelete();
    if (act === 'space') return kbdType(' ');
    if (act === 'go')    return kbdGo();
    if (act === 'close') return closeKeyboard();
    if (act === 'mode')  { _kbdNumeric = !_kbdNumeric; renderKbdRows(); return; }
    if (key.dataset.ch != null) kbdType(key.dataset.ch);
  }
  function kbdType(ch) { const i = el('search-input'); i.value += ch; afterType(); }
  function kbdDelete() { const i = el('search-input'); i.value = i.value.slice(0, -1); afterType(); }
  // Mirror the live-search behaviour of the real <input> "input" listener.
  function afterType() {
    clearTimeout(searchTimer);
    const q = el('search-input').value;
    if (!q.trim()) { showRecent(); renderChips(); state.searchFocus = 0; applySearchFocus(); return; }
    searchTimer = setTimeout(() => runSearch(q), 350);
  }
  function kbdGo() {
    const q = el('search-input').value.trim();
    clearTimeout(searchTimer);
    if (q) runSearch(q);
    closeKeyboard();
  }
  function openKeyboard() {
    buildKeyboard();
    const wheel = el('wheel'), k = el('keyboard');
    if (wheel) wheel.classList.add('kbd-hidden');   // fade the wheel out
    if (k) k.classList.add('kbd-open');             // scale + fade the keyboard in (CSS morph)
    state.searchFocus = 0; applySearchFocus();
    // focus shows a caret; inputmode=none keeps the native keyboard away on iOS.
    try { el('search-input').focus({ preventScroll: true }); } catch (e) { try { el('search-input').focus(); } catch (_) {} }
  }
  function closeKeyboard() {
    const wheel = el('wheel'), k = el('keyboard');
    if (k) k.classList.remove('kbd-open');          // keyboard scales/fades back out
    if (wheel) wheel.classList.remove('kbd-hidden');// wheel fades back in
    try { el('search-input').blur(); } catch (e) {}
  }

  // ===================================================================
  //  Selection helpers (wheel navigation through lists)
  // ===================================================================
  function containerFor(view) {
    return ({
      playlists: el('list-playlists'),
      artists: el('list-artists'),
      albums: el('grid-albums'),
      albumdetail: el('detail-tracks'),
      search: el('search-results'),
      devices: el('list-devices')
    })[view];
  }
  function applySel(view) {
    const cont = containerFor(view);
    if (!cont) return;
    const sel = state.sel[view];
    cont.querySelectorAll('[data-idx]').forEach(node => {
      node.classList.toggle('sel', +node.dataset.idx === sel);
    });
  }
  function selNode(view) {
    const cont = containerFor(view);
    return cont && cont.querySelector('[data-idx="' + state.sel[view] + '"]');
  }
  function scrollSelIntoView(view) {
    const node = selNode(view);
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  }

  function activate(view, idx) {
    const rows = state.rows[view] || [];
    const item = rows[idx];
    if (!item) return;
    const al = state.detailAlbum;
    if (view === 'playlists')      { openPlaylist(item); }
    else if (view === 'artists')   { afterPlay(SpotifyAPI.playContext(item.uri)); go('nowplaying'); }
    else if (view === 'albums')    { openAlbumDetail(item); }
    else if (view === 'devices')   { selectDevice(item); }
    else if (view === 'albumdetail') {
      // A playlist plays in its own context (queue/shuffle), offset by the
      // track's uri (robust to filtered items); albums & Liked Songs play from
      // the plain track-uri list.
      afterPlay(state.detailContextUri
        ? SpotifyAPI.playContext(state.detailContextUri, item.uri)
        : SpotifyAPI.playTracks(state.detailUris, idx));
      go('nowplaying');
      showNowPlayingOptimistic({
        name: item.name, uri: item.uri, duration_ms: item.duration_ms,
        artist: item.artist || (al && al.artist), image: item.image || (al && al.image),
        album: item.album || (al && al.id ? { id: al.id, uri: 'spotify:album:' + al.id, name: al.name, image: al.image } : null),
        artistRef: item.artistRef || null
      });
    }
    else if (view === 'search') {
      if (item.type === 'track')      { afterPlay(SpotifyAPI.playTracks([item.uri], 0)); go('nowplaying'); showNowPlayingOptimistic(item); }
      else if (item.type === 'album') { openAlbumDetail(item); }
      else if (item.type === 'artist') { afterPlay(SpotifyAPI.playContext(item.uri)); go('nowplaying'); }
    }
  }
  function noop() {}
  // play() resolves false when it could not start (no device / Premium — it has
  // already toasted). Clear the optimistic Now Playing so we don't keep showing
  // a ghost track ticking forward; snap back to the real "Nothing playing".
  function afterPlay(p) {
    Promise.resolve(p).then(ok => {
      if (ok === false) {
        state.npOptimisticUntil = 0;
        state.np = { progress_ms: 0, duration_ms: 0, is_playing: false, baseTime: Date.now() };
        if (state.view === 'nowplaying') refreshNowPlaying();
      }
    }).catch(() => {});
  }

  // ===================================================================
  //  Context action menu (center-hold) + Now-Playing navigation
  //  Like/save, add to playlist, follow, remove, go to album/artist — for the
  //  highlighted item or the current song. Wheel-navigable; MENU backs out.
  // ===================================================================
  function menuOpen() { return !!(state.menu && state.menu.open); }

  // Resolve the item the menu acts on, from the current view + selection.
  function currentContextItem() {
    const v = state.view;
    if (v === 'nowplaying') {
      const fresh = npMetaFresh();              // album/artist only when they match the live track
      const m = state.npMeta;
      const uri = state.currentUri || (m && m.trackUri);
      if (!uri) return null;
      return { type: 'track', uri, name: el('np-title').textContent,
               album: fresh ? m.album : null, artist: fresh ? m.artist : null,
               inPlaylist: null };
    }
    if (v === 'albumdetail') {
      const t = (state.rows.albumdetail || [])[state.sel.albumdetail || 0];
      if (!t) return null;
      // Use the track's OWN album/artist (playlist & Liked Songs mix many);
      // album-view tracks fall back to the album being viewed.
      return { type: 'track', uri: t.uri, name: t.name,
               album: t.album || (state.detailAlbum ? { id: state.detailAlbum.id, name: state.detailAlbum.name, image: state.detailAlbum.image } : null),
               artist: t.artistRef || null,
               inPlaylist: state.detailPlaylist ? state.detailPlaylist.id : null };
    }
    if (v === 'coverflow') { const al = cfCurrentAlbum(); return (al && al.id) ? { type: 'album', uri: 'spotify:album:' + al.id, id: al.id, name: al.name } : null; }
    const rows = state.rows[v] || [];
    const it = rows[state.sel[v] || 0];
    if (!it) return null;
    if (v === 'playlists') return { type: 'playlist', uri: it.uri, id: it.id, name: it.name };
    if (v === 'albums')    return { type: 'album', uri: it.uri, id: it.id, name: it.name };
    if (v === 'artists')   return { type: 'artist', uri: it.uri, id: it.id, name: it.name };
    if (v === 'search')    return { type: it.type, uri: it.uri, id: it.id, name: it.name };
    return null;
  }

  // run a write promise, close the menu, toast the outcome
  function menuRun(p, okMsg, failMsg) {
    closeActionMenu();
    Promise.resolve(p).then(okk => toast(okk ? okMsg : (failMsg || 'Couldn’t do that')))
                      .catch(() => toast(failMsg || 'Couldn’t do that'));
  }

  // saved is a { uri: bool } map from libraryContains. Toggle logic by state:
  //   saved===true  -> show only the REMOVE/UNFOLLOW action
  //   saved===false -> show only the SAVE/FOLLOW action
  //   unknown (check failed) -> show BOTH, so nothing is ever unreachable.
  function buildMenuItems(item, saved) {
    const items = [];
    saved = saved || {};
    const inLib = (uri) => Object.prototype.hasOwnProperty.call(saved, uri) ? saved[uri] : null;
    const toggle = (uri, addLabel, addMsg, delLabel, delMsg) => {
      const s = inLib(uri);
      if (s !== true)  items.push({ label: addLabel, run: () => menuRun(SpotifyAPI.saveToLibrary(uri), addMsg) });
      if (s !== false) items.push({ label: delLabel, run: () => menuRun(SpotifyAPI.removeFromLibrary(uri), delMsg) });
    };

    if (item.type === 'track') {
      toggle(item.uri, '♡  Save to Liked Songs', 'Saved to Liked Songs', '♥  Remove from Liked Songs', 'Removed from Liked Songs');
      items.push({ label: '＋  Add to Playlist…', run: () => openPlaylistPicker(item.uri) });
      if (item.inPlaylist) items.push({ label: '⊟  Remove from this Playlist', run: () => { const pid = item.inPlaylist, uri = item.uri; closeActionMenu(); Promise.resolve(SpotifyAPI.removeFromPlaylist(pid, uri)).then(okk => { toast(okk ? 'Removed from playlist' : 'Couldn’t remove'); if (okk) reloadPlaylistDetail(pid); }).catch(() => toast('Couldn’t remove')); } });
      if (item.album && item.album.id) items.push({ label: '💿  Go to Album', run: () => { closeActionMenu(); openAlbumDetail({ id: item.album.id, name: item.album.name, artist: (item.artist && item.artist.name) || '', image: item.album.image }); } });
      if (item.artist && item.artist.id && item.artist.uri) {
        const a = item.artist;
        toggle(a.uri, '☆  Follow ' + (a.name || 'Artist'), 'Following ' + (a.name || 'artist'), '★  Unfollow ' + (a.name || 'Artist'), 'Unfollowed');
      }
    } else if (item.type === 'album') {
      toggle(item.uri, '♡  Save Album', 'Album saved', '♥  Remove Album', 'Album removed');
    } else if (item.type === 'artist') {
      toggle(item.uri, '☆  Follow ' + (item.name || 'Artist'), 'Following ' + (item.name || 'artist'), '★  Unfollow ' + (item.name || 'Artist'), 'Unfollowed');
    } else if (item.type === 'playlist') {
      items.push({ label: '🗑  Delete Playlist', run: () => { const uri = item.uri; closeActionMenu(); Promise.resolve(SpotifyAPI.removeFromLibrary(uri)).then(okk => { toast(okk ? 'Deleted playlist' : 'Couldn’t delete'); if (okk) dropPlaylistFromList(uri); }).catch(() => toast('Couldn’t delete')); } });
    }
    return items;
  }

  async function openActionMenu() {
    const item = currentContextItem();
    if (!item || !item.uri) { toast('Nothing selected'); return; }
    // Look up current saved/followed state so toggles show the right action.
    const uris = [];
    if (item.type === 'track' || item.type === 'album' || item.type === 'artist') uris.push(item.uri);
    if (item.type === 'track' && item.artist && item.artist.uri) uris.push(item.artist.uri);
    const saved = {};
    if (uris.length) {
      try { const res = await SpotifyAPI.libraryContains(uris); uris.forEach((u, i) => { if (typeof res[i] === 'boolean') saved[u] = res[i]; }); } catch (e) {}
    }
    const items = buildMenuItems(item, saved);
    if (!items.length) { toast('No actions here'); return; }
    state.menu = { open: true, title: item.name || 'Actions', items, sel: 0, prev: null };
    renderActionMenu();
  }

  async function openPlaylistPicker(trackUri) {
    // Capture the back-target + show a loading picker SYNCHRONOUSLY so the
    // track menu can't be re-navigated during the fetch (reentrancy). A token
    // discards a stale fetch if the user backed out / opened another picker.
    const prev = menuOpen() ? { title: state.menu.title, items: state.menu.items, sel: state.menu.sel, prev: state.menu.prev } : null;
    const token = (state.menuReq = (state.menuReq || 0) + 1);
    state.menu = { open: true, title: 'Add to Playlist', items: [{ label: 'Loading…', run: () => {} }], sel: 0, prev };
    renderActionMenu();

    let lists = state.playlists;
    if (!lists) { try { lists = state.playlists = await SpotifyAPI.getPlaylists(); } catch (e) { lists = []; } }
    let meId = null; try { meId = (await SpotifyAPI.getMe()).id; } catch (e) {}
    if (state.menuReq !== token || !menuOpen()) return;     // superseded or dismissed
    const owned = (lists || []).filter(p => (meId && p.owner === meId) || p.collaborative);
    if (!owned.length) { closeActionMenu(); toast('No editable playlists'); return; }
    const items = owned.map(p => ({ label: p.name, run: () => { closeActionMenu(); Promise.resolve(SpotifyAPI.addToPlaylist(p.id, trackUri)).then(okk => toast(okk ? 'Added to ' + p.name : 'Couldn’t add')).catch(() => toast('Couldn’t add')); } }));
    state.menu = { open: true, title: 'Add to Playlist', items, sel: 0, prev };
    renderActionMenu();
  }

  function renderActionMenu() {
    const o = el('action-menu');
    if (!o || !state.menu) return;
    const m = state.menu;
    o.innerHTML =
      '<div class="am-card">' +
        '<div class="am-title">' + esc(m.title) + '</div>' +
        '<div class="am-list">' +
          m.items.map((it, i) => '<div class="am-item' + (i === m.sel ? ' sel' : '') + '" data-i="' + i + '">' + esc(it.label) + '</div>').join('') +
        '</div>' +
      '</div>';
    o.classList.add('show');
    const sel = o.querySelector('.am-item.sel');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }
  function menuScroll(delta) {
    const m = state.menu; if (!m) return;
    const before = m.sel;
    m.sel = clamp(m.sel + delta, 0, m.items.length - 1);
    if (m.sel !== before) { renderActionMenu(); Feedback.tick(); }
  }
  function menuActivate() {                  // caller owns the click feedback
    const m = state.menu; if (!m) return;
    const it = m.items[m.sel];
    if (it && it.run) it.run();
  }
  function closeActionMenu() {
    if (state.menu) state.menu.open = false;
    const o = el('action-menu'); if (o) o.classList.remove('show');
  }
  // After deleting a playlist on Spotify, drop it from the iPod's list too.
  function dropPlaylistFromList(uri) {
    if (!state.playlists) return;
    state.playlists = state.playlists.filter(p => p.uri !== uri);
    if (state.sel.playlists != null) state.sel.playlists = clamp(state.sel.playlists, 0, Math.max(0, state.playlists.length - 1));
    if (state.view === 'playlists') loadPlaylists();   // state.playlists is set -> re-renders, no refetch
  }

  // ---- Now Playing -> album / artist navigation ----------------------
  function goToCurrentAlbum() {
    const m = state.npMeta;
    if (npMetaFresh() && m.album && m.album.id) openAlbumDetail({ id: m.album.id, name: m.album.name, artist: (m.artist && m.artist.name) || '', image: m.album.image });
    else toast('No album info yet');
  }
  function goToCurrentArtist() {
    const m = state.npMeta;
    if (npMetaFresh() && m.artist && m.artist.id) openArtist(m.artist);
    else toast('No artist info yet');
  }
  function reloadPlaylistDetail(pid) {
    const pl = state.detailPlaylist;
    if (pl && pl.id === pid) openPlaylist(pl);
  }

  // ---- artist page: the artist's albums, reusing the albums grid -----
  function renderAlbumGrid(albums) {
    const cont = el('grid-albums');
    state.rows.albums = albums;
    if (state.sel.albums == null) state.sel.albums = 0;
    if (!albums.length) { cont.innerHTML = emptyHTML('No albums'); return; }
    cont.innerHTML = albums.map((al, idx) =>
      '<div class="album-cell" data-idx="' + idx + '">' +
        '<div class="art album-art" data-art="' + idx + '"></div>' +
        '<div class="album-name">' + esc(al.name) + '</div>' +
        '<div class="album-artist">' + esc(al.artist) + '</div>' +
      '</div>'
    ).join('');
    albums.forEach((al, idx) => setArt(cont.querySelector('[data-art="' + idx + '"]'), al.image, al.id, 'album'));
    applySel('albums');
  }
  async function openArtist(artist) {
    if (!artist || !artist.id) { toast('No artist info'); return; }
    const tok = (state.artistReq = (state.artistReq || 0) + 1);   // discard out-of-order results
    let albums = [];
    try { albums = await SpotifyAPI.getArtistAlbums(artist.id); } catch (e) {}
    if (state.artistReq !== tok) return;                            // superseded
    if (albums.length) {
      // Browseable artist page (their albums).
      state.albumsSource = 'artist';
      state.albums = albums;
      state.sel.albums = 0;
      go('albums');
      renderAlbumGrid(albums);
    } else if (artist.uri) {
      // The artist-albums catalog endpoint is restricted for dev-mode apps, so a
      // browseable page isn't possible — fall back to PLAYING the artist.
      afterPlay(SpotifyAPI.playContext(artist.uri));
      go('nowplaying');
      toast('Playing ' + (artist.name || 'artist'));
    } else {
      toast('Artist unavailable');
    }
  }

  // ===================================================================
  //  Click wheel: center + scroll dispatch
  // ===================================================================
  function onCenter() {
    if (menuOpen()) { menuActivate(); return; }   // context menu takes the wheel
    const v = state.view;
    if (v === 'menu') { selMenu(state.mi); return; }
    if (v === 'coverflow') {
      // Center = drill into the focused album's tracklist (iPod Cover Flow).
      const al = cfCurrentAlbum();
      if (al) openAlbumDetail(al);
      return;
    }
    if (v === 'nowplaying') { Player.togglePlay(); return; }
    if (v === 'search') { searchCenter(); return; }
    // An un-listable (non-owned) playlist has no rows but a context — play it.
    if (v === 'albumdetail' && !(state.rows.albumdetail || []).length && state.detailContextUri) {
      afterPlay(SpotifyAPI.playContext(state.detailContextUri)); go('nowplaying'); return;
    }
    if (['playlists', 'artists', 'albums', 'albumdetail', 'devices'].indexOf(v) >= 0) {
      activate(v, state.sel[v] || 0);
    }
  }

  // Advance the selection by one step; fire the click-wheel "tick" (audio +
  // haptic) and a brief on-screen pulse only when the highlight actually moves.
  function onScroll(delta) {
    if (menuOpen()) { menuScroll(delta); return; }   // context menu takes the wheel
    const v = state.view;
    let changed = false, node = null;

    if (v === 'menu') {
      const before = state.mi;
      setMi(state.mi + delta);
      changed = state.mi !== before;
      node = activeMenuItem();
    } else if (v === 'coverflow') {
      const len = (state.coverflow || []).length;
      if (len) {
        const st = cfState();
        const before = st.target;
        st.target = clamp(st.target + delta, 0, len - 1);
        changed = st.target !== before;
        if (changed) animateCoverFlow();   // glide + snap; no scale-pop (the slide is the feedback)
      }
    } else if (v === 'search') {
      if (kbdOpen()) return;            // typing: the wheel is hidden, ignore stray scrolls
      node = searchScroll(delta);
      changed = node != null;
    } else if (['playlists', 'artists', 'albums', 'albumdetail', 'devices'].indexOf(v) >= 0) {
      const rows = state.rows[v] || [];
      if (rows.length) {
        const before = state.sel[v] || 0;
        state.sel[v] = clamp(before + delta, 0, rows.length - 1);
        changed = state.sel[v] !== before;
        if (changed) { applySel(v); scrollSelIntoView(v); }
        node = selNode(v);
      }
    }

    if (changed) { Feedback.tick(); pulse(node); }
  }

  // ===================================================================
  //  Toast
  // ===================================================================
  let toastTimer = null;
  function toast(msg) {
    const t = el('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ===================================================================
  //  Wiring: scaling, clock, wheel gestures, buttons, inputs
  // ===================================================================
  // Scale the fixed-design screen (360x412) and wheel (236) to fill their
  // flex regions, so the whole UI fills any viewport top-to-bottom.
  function fitStage() {
    // #app is position:absolute inset:0, so it already fills the exact screen
    // (no innerHeight juggling needed). We only scale the screen + wheel here.
    const screen = el('screen'), wheel = el('wheel');
    const sr = el('screen-region'), wr = el('wheel-region');
    if (sr && screen) {
      const s = Math.min(sr.clientWidth / 360, sr.clientHeight / 412);
      screen.style.transform = 'scale(' + s + ')';
    }
    if (wr && wheel) {
      // Don't let the wheel grow to fill its whole region — reserve some
      // height so a clear gap opens above it (detached from the screen), then
      // bias it toward the bottom so it sits a touch lower.
      const s = Math.min(wr.clientWidth / 236, (wr.clientHeight * 0.9) / 236);
      const slack = wr.clientHeight - 236 * s;   // leftover vertical space
      const drop = slack * 0.52;                 // push down a touch more (lower wheel)
      wheel.style.transform = 'translateY(' + drop + 'px) scale(' + s + ')';
    }
  }

  // smooth progress ticker
  function startTicker() {
    setInterval(() => { if (state.view === 'nowplaying') paintProgress(); }, 500);
  }

  // ===================================================================
  //  Volume: press-and-hold the wheel, then circle to change volume.
  //  Holding still (no rotation) for HOLD_MS arms volume mode; rotating
  //  before that is a normal scroll. Clockwise = louder.
  // ===================================================================
  const HOLD_MS = 450;          // press duration to arm volume mode
  const VOL_STEP_DEG = 13;      // wheel degrees per volume step
  const VOL_STEP = 4;           // volume % per step
  let volMode = false, volLevel = 50, volAccum = 0;
  let holdTimer = null, holdMoved = 0, volApplyTimer = null, volFailNoticed = false;
  let wheelDown = false;        // pointer currently held on the wheel
  const CENTER_HOLD_MS = 450;   // hold the CENTER button this long -> context menu
  let centerHoldTimer = null;

  function showVolHud()   { const h = el('vol-hud'); if (h) h.classList.add('show'); updateVolHud(); }
  function hideVolHud()   { const h = el('vol-hud'); if (h) h.classList.remove('show'); }
  function updateVolHud() { const f = el('vol-fill'); if (f) f.style.width = clamp(volLevel, 0, 100) + '%'; }
  function applyVol() {
    Player.setVolume(volLevel).then(reason => {
      if (reason === 'ok' || volFailNoticed) return;
      volFailNoticed = true;
      toast(reason === 'no-device'   ? 'No active device — open Menu ▸ Devices'
          : reason === 'premium'     ? 'Volume needs Spotify Premium'
          : reason === 'unsupported' ? 'This device sets its own volume'
          : 'Couldn’t change the volume');
      volMode = false; hideVolHud();        // circling won't help — close volume mode
    }).catch(() => {});
  }
  function scheduleVolApply() {
    if (volApplyTimer) return;            // throttle: at most one PUT per ~110ms
    volApplyTimer = setTimeout(() => { volApplyTimer = null; applyVol(); }, 110);
  }
  function volStep(dir) {
    volLevel = clamp(volLevel + dir * VOL_STEP, 0, 100);
    updateVolHud();
    Feedback.tick();
    scheduleVolApply();
  }
  function enterVolumeMode() {
    holdTimer = null;
    if (!wheelDown) return;               // finger already lifted
    // Only engage if the ACTIVE device can actually be volume-controlled, so we
    // don't trap the user in a gesture that can never apply (e.g. the phone's
    // own Spotify, whose volume is hardware-only, or nothing playing at all).
    Player.getVolumeTarget().then(t => {
      if (!wheelDown) return;             // released while we were checking
      if (!t || !t.hasDevice) { toast('No active device — open Menu ▸ Devices'); return; }
      if (!t.supported)        { toast((t.name || 'This device') + ' sets its own volume'); return; }
      volMode = true; volAccum = 0; volFailNoticed = false;
      wheelMoved = true;                  // swallow the click that follows pointerup
      Feedback.haptic(18);
      if (typeof t.volume === 'number') volLevel = t.volume;
      showVolHud();
    }).catch(() => { toast('Volume unavailable'); });
  }
  function exitVolumeMode() {
    volMode = false;
    if (volApplyTimer) { clearTimeout(volApplyTimer); volApplyTimer = null; }
    applyVol();                           // make sure the final level sticks
    setTimeout(hideVolHud, 650);
  }

  let wheelMoved = false;
  function bindWheel() {
    const wheel = el('wheel');
    const STEP = 22;                       // degrees per scroll tick
    const drag = { active: false, last: 0, acc: 0 };

    // Re-read the rect each event: the wheel is transform-scaled by fitStage,
    // and an iOS URL-bar collapse mid-drag changes its on-screen center.
    const angleAt = (e) => {
      const rect = wheel.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      return Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
    };

    wheel.addEventListener('pointerdown', (e) => {
      Feedback.resume();                   // unlock audio within the gesture
      drag.active = true; drag.acc = 0; wheelMoved = false; wheelDown = true;
      drag.last = angleAt(e);
      holdMoved = 0;
      if (holdTimer) clearTimeout(holdTimer);
      if (centerHoldTimer) { clearTimeout(centerHoldTimer); centerHoldTimer = null; }
      if (menuOpen()) {
        // Context menu is open: the wheel only navigates it (rotation -> onScroll
        // -> menuScroll). Arm neither volume nor the menu-open hold.
      } else if (e.target.closest('.wheel-center')) {
        // Long-press the CENTER -> context action menu. Don't arm volume (that's
        // a ring gesture); mark wheelMoved so the trailing click is swallowed.
        centerHoldTimer = setTimeout(() => {
          centerHoldTimer = null; wheelMoved = true;
          Feedback.press(); openActionMenu();
        }, CENTER_HOLD_MS);
      } else {
        holdTimer = setTimeout(enterVolumeMode, HOLD_MS);   // hold still to arm volume
      }
      try { wheel.setPointerCapture(e.pointerId); } catch (_) {}
    });
    wheel.addEventListener('pointermove', (e) => {
      if (!drag.active) return;
      const a = angleAt(e);
      let d = a - drag.last;
      if (d > 180) d -= 360; if (d < -180) d += 360;
      drag.last = a;

      // Volume mode: circling adjusts volume instead of scrolling.
      if (volMode) {
        volAccum += d;
        while (Math.abs(volAccum) >= VOL_STEP_DEG) {
          const dir = volAccum > 0 ? 1 : -1;
          volAccum -= dir * VOL_STEP_DEG;
          volStep(dir);
        }
        e.preventDefault();
        return;
      }

      // Rotating before the hold fires means it's a scroll, not a hold — cancel.
      holdMoved += Math.abs(d);
      if (holdMoved > 16) {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (centerHoldTimer) { clearTimeout(centerHoldTimer); centerHoldTimer = null; }   // became a scroll, not a hold
      }

      drag.acc += d;
      while (Math.abs(drag.acc) >= STEP) {
        const dir = drag.acc > 0 ? 1 : -1;
        drag.acc -= dir * STEP;
        wheelMoved = true;
        onScroll(dir);
      }
      if (wheelMoved) e.preventDefault();
    });
    const end = () => {
      drag.active = false; wheelDown = false;
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (centerHoldTimer) { clearTimeout(centerHoldTimer); centerHoldTimer = null; }
      if (volMode) exitVolumeMode();
    };
    wheel.addEventListener('pointerup', end);
    wheel.addEventListener('pointercancel', end);

    // trackpad / mouse wheel
    wheel.addEventListener('wheel', (e) => {
      e.preventDefault();
      onScroll(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1);
    }, { passive: false });
  }

  function bindButtons() {
    const tap = (id, fn) => {
      el(id).addEventListener('click', () => {
        if (wheelMoved) { wheelMoved = false; return; }   // ignore drag-end clicks
        Feedback.press();                                 // tactile press feedback
        fn();
      });
    };
    tap('btn-menu', goMenu);
    tap('btn-prev', () => Player.previousTrack());
    tap('btn-next', () => Player.nextTrack());
    tap('btn-play', () => Player.togglePlay());
    tap('btn-center', onCenter);
  }

  function bindLists() {
    const rowClick = (view) => (e) => {
      const row = e.target.closest('[data-idx]');
      if (!row) return;
      Feedback.press();                     // physical + audio click on tap
      const idx = +row.dataset.idx;
      state.sel[view] = idx;
      applySel(view);
      activate(view, idx);
    };
    el('list-playlists').addEventListener('click', rowClick('playlists'));
    el('list-artists').addEventListener('click', rowClick('artists'));
    el('grid-albums').addEventListener('click', rowClick('albums'));
    el('detail-tracks').addEventListener('click', rowClick('albumdetail'));
    el('list-devices').addEventListener('click', rowClick('devices'));

    // Now Playing: tap the title -> the song's album; tap the artist -> artist.
    el('np-title').addEventListener('click', () => { Feedback.press(); goToCurrentAlbum(); });
    el('np-artist').addEventListener('click', () => { Feedback.press(); goToCurrentArtist(); });

    // Context action menu: tap a row to run it (mirrors center on the wheel).
    el('action-menu').addEventListener('click', (e) => {
      if (e.target.closest('.am-card') == null) { closeActionMenu(); return; }  // tap backdrop = dismiss
      const row = e.target.closest('.am-item');
      if (!row || !state.menu) return;
      Feedback.press();
      state.menu.sel = +row.dataset.i;
      menuActivate();
    });

    // Search results use the dedicated focus model (0 = box, 1.. = rows).
    el('search-results').addEventListener('click', (e) => {
      const row = e.target.closest('[data-idx]');
      if (!row) return;
      Feedback.press();
      const idx = +row.dataset.idx;
      state.searchFocus = idx + 1;
      applySearchFocus();
      activate('search', idx);
    });
    // Tapping the search box opens the in-app keyboard (same as center on it).
    el('search-box').addEventListener('click', () => {
      Feedback.press();
      state.searchFocus = 0; applySearchFocus();
      openKeyboard();
    });

    el('menu-sidebar').addEventListener('click', (e) => {
      const it = e.target.closest('.menu-item');
      if (it) { Feedback.press(); selMenu(+it.dataset.idx); }
    });

    // Cover Flow: tap a side cover to glide it to centre; tap the centre to
    // drill into its tracklist.
    el('cf-stage').addEventListener('click', (e) => {
      const card = e.target.closest('.cf-cover');
      if (!card) return;
      const i = +card.dataset.i;
      const st = cfState();
      if (i === Math.round(st.pos)) {
        Feedback.press();
        const al = cfCurrentAlbum();
        if (al) openAlbumDetail(al);
      } else {
        Feedback.tick();
        st.target = i;
        animateCoverFlow();
      }
    });

    el('search-chips').addEventListener('click', (e) => {
      const c = e.target.closest('.chip');
      if (!c) return;
      Feedback.press();
      clearTimeout(searchTimer);           // cancel any pending debounced query
      el('search-input').value = c.dataset.q;
      runSearch(c.dataset.q);
    });

    const input = el('search-input');
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = input.value;
      if (!q.trim()) { showRecent(); return; }
      searchTimer = setTimeout(() => runSearch(q), 400);
    });
  }

  function bindKeys() {
    window.addEventListener('keydown', (e) => {
      const typing = document.activeElement === el('search-input');
      if (e.key === 'ArrowDown') { Feedback.resume(); onScroll(1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { Feedback.resume(); onScroll(-1); e.preventDefault(); }
      else if (e.key === 'Enter') { Feedback.press(); if (typing) kbdGo(); else onCenter(); }
      else if (e.key === 'ArrowRight') { if (!typing) { Feedback.press(); Player.nextTrack(); } }
      else if (e.key === 'ArrowLeft') { if (!typing) { Feedback.press(); Player.previousTrack(); } }
      else if (e.key === 'Escape') { Feedback.press(); if (kbdOpen()) closeKeyboard(); else goMenu(); }
      else if (e.key === 'Backspace' && !typing) { Feedback.press(); goMenu(); }
    });
  }

  // ===================================================================
  //  Sign-in overlay (user-gesture login — reliable in iOS standalone PWAs)
  // ===================================================================
  // The iOS home-indicator strip (and status-bar area) shows the page/theme
  // background, which the web content can't paint over in a standalone PWA. So
  // we keep that background in sync with whatever screen is up: dark behind the
  // dark sign-in, silver behind the silver iPod — so the strip never contrasts.
  function setShellBg(color) {
    document.documentElement.style.backgroundColor = color;
    document.body.style.backgroundColor = color;
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', color);
  }

  // Tap the bare metal body (not the screen or wheel) to toggle the iPod's
  // finish between silver and full graphite. Persisted across launches.
  const SILVER_BG = '#c6c9cf', GRAPHITE_BG = '#1c1d20';
  function bodyIsGraphite() { return el('app').classList.contains('graphite'); }
  function applyBodyTheme(graphite) {
    el('app').classList.toggle('graphite', graphite);
    if (!document.getElementById('signin') || document.getElementById('signin').style.display === 'none') {
      setShellBg(graphite ? GRAPHITE_BG : SILVER_BG);  // keep the home-bar strip matched
    }
    try { localStorage.setItem('ultrapod_graphite', graphite ? '1' : '0'); } catch (e) {}
  }
  function bindBodyTap() {
    el('app').addEventListener('click', (e) => {
      // Pause the finish toggle entirely while searching: the in-app keyboard
      // sits OUTSIDE .wheel, so every key tap would otherwise bubble here and
      // flip the colour on each letter typed.
      if (state.view === 'search') return;
      // ignore taps on the screen, the wheel, the keyboard, or the sign-in overlay
      if (e.target.closest('.screen') || e.target.closest('.wheel') ||
          e.target.closest('#keyboard') || e.target.closest('#signin')) return;
      Feedback.press();
      applyBodyTheme(!bodyIsGraphite());
    });
  }

  function showSignIn(note) {
    setShellBg('#0a0a0c');
    let o = document.getElementById('signin');
    if (!o) {
      o = document.createElement('div');
      o.id = 'signin';
      o.innerHTML =
        '<div class="signin-card">' +
          '<div class="signin-logo">iPod</div>' +
          '<div class="signin-tag">your Spotify, iPod-style</div>' +
          '<button class="signin-btn" id="signin-btn">Sign in with Spotify</button>' +
          '<div class="signin-note" id="signin-note"></div>' +
        '</div>';
      (document.getElementById('scaler') || document.body).appendChild(o);
      document.getElementById('signin-btn').addEventListener('click', () => {
        Feedback.press();
        document.getElementById('signin-note').textContent = 'Opening Spotify…';
        Auth.login();
      });
    }
    document.getElementById('signin-note').textContent = note || '';
    o.style.display = 'flex';
  }
  function hideSignIn() {
    setShellBg(bodyIsGraphite() ? GRAPHITE_BG : SILVER_BG);   // match the home-bar strip to the finish
    const o = document.getElementById('signin');
    if (o) o.style.display = 'none';
  }

  // ===================================================================
  //  Boot
  // ===================================================================
  // Best-effort portrait lock. Works on Android / installed PWAs that allow
  // screen.orientation.lock; iOS Safari has no such API (it throws / is
  // undefined), so the manifest "orientation":"portrait" and the CSS
  // #rotate-guard overlay cover that case. Always wrapped so it never throws.
  function lockPortrait() {
    try {
      if (screen.orientation && typeof screen.orientation.lock === 'function') {
        const p = screen.orientation.lock('portrait');
        if (p && p.catch) p.catch(() => {});
      }
    } catch (e) {}
  }

  async function init() {
    bindWheel();
    bindButtons();
    bindLists();
    bindKeys();
    bindBodyTap();
    lockPortrait();
    window.addEventListener('orientationchange', lockPortrait);
    // restore the saved silver/graphite finish
    try { if (localStorage.getItem('ultrapod_graphite') === '1') applyBodyTheme(true); } catch (e) {}
    fitStage();
    window.addEventListener('resize', fitStage);
    window.addEventListener('orientationchange', fitStage);
    window.addEventListener('load', fitStage);
    window.addEventListener('pageshow', fitStage);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fitStage);
    // iOS standalone can report a stale innerHeight on first paint; re-fit
    // a few times as it settles.
    setTimeout(fitStage, 150);
    setTimeout(fitStage, 500);
    setTimeout(fitStage, 1200);
    startTicker();

    // The menu view + Playlists highlight are present in the static HTML, so
    // the iPod paints on first frame. We only re-assert the highlight here; we
    // must NOT call go('menu') until authenticated (go() loads data via getToken).
    setMi(2);

    if (CONFIG.CLIENT_ID === 'YOUR_CLIENT_ID_HERE' || CONFIG.REDIRECT_URI === 'YOUR_REDIRECT_URI_HERE') {
      toast('Add CLIENT_ID & REDIRECT_URI in config.js');
      return;
    }

    // PKCE needs Web Crypto, which only exists in a secure context.
    if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
      toast('Open over https or http://127.0.0.1 to sign in');
      return;
    }

    let ok = false;
    try {
      ok = await Auth.init();
    } catch (e) {
      console.warn(e);
      const m = (e && e.message) || '';
      showSignIn(
        /STORAGE_BLOCKED/.test(m) ? 'Storage blocked — turn off Private Browsing / allow site data, then tap to retry.'
        : /Token exchange failed|state mismatch|verifier/i.test(m) ? 'Sign-in didn’t complete — tap to try again.'
        : 'Tap to sign in.'
      );
      return;
    }
    // Not signed in: show a tappable Sign-in button. A user-gesture redirect is
    // far more reliable than a silent cold-launch redirect inside an iOS
    // standalone PWA (which otherwise breaks out to Safari and can loop).
    if (!ok) { showSignIn(); return; }

    // Authenticated: hide sign-in, connect the SDK, load live data.
    hideSignIn();
    Player.start();
    setMi(2);
    go('menu');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Export on window: the cross-module calls in player.js / spotify.js /
  // auth.js are written as `if (window.UI && UI.x)`, and a top-level `const`
  // is NOT a property of the global object in a classic script — so without
  // this, every guarded toast and the SDK's onPlayerState push silently no-op.
  window.UI = { goMenu, onCenter, onScroll, toast, onPlayerState, showSignIn, hideSignIn };
  return window.UI;
})();

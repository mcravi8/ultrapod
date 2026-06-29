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
    coverIndex: 0,
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
    search: 'view-search', albumdetail: 'view-albumdetail'
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
  const LIKED_GRAD = 'linear-gradient(135deg,#4422cc,#9b6cff)';

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

    function blip(freq, peak, dur, type) {
      const c = ctx; if (!c) return;
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
    }

    // short, dry "tick" as the selection advances one step
    function tick() {
      resume();
      blip(2300, 0.05, 0.018, 'square');
      if (navigator.vibrate) { try { navigator.vibrate(5); } catch (e) {} }
    }
    // softer, lower "clunk" for a button / center press
    function press() {
      resume();
      blip(820, 0.08, 0.05, 'sine');
      if (navigator.vibrate) { try { navigator.vibrate(11); } catch (e) {} }
    }

    return { resume, tick, press };
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
      case 'nowplaying': refreshNowPlaying(); break;
    }
  }

  function goMenu() { go('menu'); }

  // menu item activation
  function setMi(i) {
    state.mi = clamp(i, 0, 6);
    document.querySelectorAll('#menu-sidebar .menu-item').forEach(node => {
      node.classList.toggle('active', +node.dataset.idx === state.mi);
    });
  }

  function selMenu(i) {
    setMi(i);
    switch (i) {
      case 0: go('nowplaying'); break;
      case 1: go('coverflow');  break;
      case 2: openAllMusic();   break;   // Liked Songs as a tracklist
      case 3: go('playlists');  break;
      case 4: go('search');     break;
      case 5: go('artists');    break;
      case 6: go('albums');     break;
    }
  }

  // ===================================================================
  //  Cover flow (menu mini + full)
  // ===================================================================
  async function loadCoverflow() {
    if (!state.coverflow) {
      try { state.coverflow = await SpotifyAPI.getRecentlyPlayed(); }
      catch (e) { state.coverflow = []; }
      state.coverIndex = 0;
    }
    renderCoverflow();
  }

  function renderCoverflow() {
    const items = state.coverflow || [];
    const i = clamp(state.coverIndex, 0, Math.max(0, items.length - 1));
    const center = items[i], left = items[i - 1], right = items[i + 1];

    const paint = (centerId, leftId, rightId, titleId, subId) => {
      setArt(el(centerId), center && center.image, center ? center.albumId : 'c', 'album');
      setArt(el(leftId),  left  && left.image,  left  ? left.albumId  : 'l', 'album');
      setArt(el(rightId), right && right.image, right ? right.albumId : 'r', 'album');
      el(titleId).textContent = center ? center.title : 'No recent plays';
      el(subId).textContent = center
        ? center.artist + ' · ' + (i + 1) + '/' + items.length
        : 'Spotify';
    };
    paint('menu-cf-center', 'menu-cf-left', 'menu-cf-right', 'menu-cf-title', 'menu-cf-sub');
    paint('cf-center', 'cf-left', 'cf-right', 'cf-title', 'cf-sub');
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
    const cont = el('grid-albums');
    if (!state.albums) {
      cont.innerHTML = loadingHTML();
      try { state.albums = await SpotifyAPI.getSavedAlbums(); }
      catch (e) { state.albums = []; }
    }
    state.rows.albums = state.albums;
    if (!state.albums.length) { cont.innerHTML = emptyHTML('No albums found'); return; }
    cont.innerHTML = state.albums.map((al, idx) =>
      '<div class="album-cell" data-idx="' + idx + '">' +
        '<div class="art album-art" data-art="' + idx + '"></div>' +
        '<div class="album-name">' + esc(al.name) + '</div>' +
        '<div class="album-artist">' + esc(al.artist) + '</div>' +
      '</div>'
    ).join('');
    state.albums.forEach((al, idx) => setArt(cont.querySelector('[data-art="' + idx + '"]'), al.image, al.id, 'album'));
    if (state.sel.albums == null) state.sel.albums = 0;
    applySel('albums');
  }

  // ===================================================================
  //  Album / tracklist detail
  // ===================================================================
  async function openAlbumDetail(album) {
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
    setArtGradient(el('detail-art'), LIKED_GRAD);
    el('detail-title').textContent = 'All Music';
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

  async function refreshNowPlaying() {
    let cur = null;
    try { cur = await SpotifyAPI.getCurrentlyPlaying(); } catch (e) {}
    if (cur) {
      state.currentUri = cur.uri;
      state.np = { progress_ms: cur.progress_ms, duration_ms: cur.duration_ms, is_playing: cur.is_playing, baseTime: Date.now() };
      el('np-title').textContent = cur.name;
      el('np-artist').textContent = cur.artist || '';
      setArt(el('np-art'), cur.image, cur.uri || cur.name, 'album');
      el('np-dur').textContent = fmtTime(cur.duration_ms);
      paintProgress();
    } else if (state.view === 'nowplaying') {
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

  function enterSearch() {
    renderChips();
    if (!el('search-input').value.trim()) showRecent();
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
  }
  function showRecent() {
    el('search-results').style.display = 'none';
    el('search-recent').style.display = 'block';
  }

  async function runSearch(q) {
    el('search-recent').style.display = 'none';
    const cont = el('search-results');
    cont.style.display = 'block';
    cont.innerHTML = loadingHTML();

    let res;
    try { res = await SpotifyAPI.search(q); }
    catch (e) { res = { tracks: [], albums: [], artists: [] }; }
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
    state.sel.search = 0;
    if (!flat.length) { cont.innerHTML = emptyHTML('No results'); return; }
    cont.innerHTML = html;
    flat.forEach((it, idx) => setArt(cont.querySelector('[data-art="' + idx + '"]'), it.image, it.id, it.type === 'artist' ? 'artist' : 'album'));
    applySel('search');
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
      search: el('search-results')
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
    if (view === 'playlists')      { SpotifyAPI.playContext(item.uri).catch(noop); go('nowplaying'); }
    else if (view === 'artists')   { SpotifyAPI.playContext(item.uri).catch(noop); go('nowplaying'); }
    else if (view === 'albums')    { openAlbumDetail(item); }
    else if (view === 'albumdetail') { SpotifyAPI.playTracks(state.detailUris, idx).catch(noop); go('nowplaying'); }
    else if (view === 'search') {
      if (item.type === 'track')      { SpotifyAPI.playTracks([item.uri], 0).catch(noop); go('nowplaying'); }
      else if (item.type === 'album') { openAlbumDetail(item); }
      else if (item.type === 'artist') { SpotifyAPI.playContext(item.uri).catch(noop); go('nowplaying'); }
    }
  }
  function noop() {}

  // ===================================================================
  //  Click wheel: center + scroll dispatch
  // ===================================================================
  function onCenter() {
    const v = state.view;
    if (v === 'menu') { selMenu(state.mi); return; }
    if (v === 'coverflow') {
      const it = (state.coverflow || [])[state.coverIndex];
      if (it) { SpotifyAPI.playContext(it.uri).catch(noop); go('nowplaying'); }
      return;
    }
    if (v === 'nowplaying') { Player.togglePlay(); return; }
    if (['playlists', 'artists', 'albums', 'albumdetail', 'search'].indexOf(v) >= 0) {
      activate(v, state.sel[v] || 0);
    }
  }

  // Advance the selection by one step; fire the click-wheel "tick" (audio +
  // haptic) and a brief on-screen pulse only when the highlight actually moves.
  function onScroll(delta) {
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
        const before = state.coverIndex;
        state.coverIndex = clamp(state.coverIndex + delta, 0, len - 1);
        changed = state.coverIndex !== before;
        if (changed) renderCoverflow();
        node = el('cf-center');
      }
    } else if (['playlists', 'artists', 'albums', 'albumdetail', 'search'].indexOf(v) >= 0) {
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
  function fitStage() {
    const stage = el('stage');
    // Scale so the iPod itself (centered in the 720x1100 stage) fills the
    // screen, rather than fitting the whole mockup "desk" with big margins.
    // The padding leaves a little breathing room and clears the notch / home bar.
    const IPOD_W = 384 + 14, IPOD_H = 808 + 30;
    const s = Math.min(window.innerWidth / IPOD_W, window.innerHeight / IPOD_H);
    stage.style.transform = 'translate(-50%,-50%) scale(' + s + ')';
  }

  function startClock() {
    const tick = () => {
      const d = new Date();
      el('status-time').textContent =
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    };
    tick();
    setInterval(tick, 15000);
  }

  // smooth progress ticker
  function startTicker() {
    setInterval(() => { if (state.view === 'nowplaying') paintProgress(); }, 500);
  }

  let wheelMoved = false;
  function bindWheel() {
    const wheel = el('wheel');
    const STEP = 22;                       // degrees per scroll tick
    const drag = { active: false, last: 0, acc: 0, rect: null };

    const angleAt = (e, rect) => {
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      return Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
    };

    wheel.addEventListener('pointerdown', (e) => {
      Feedback.resume();                   // unlock audio within the gesture
      drag.active = true; drag.acc = 0; wheelMoved = false;
      drag.rect = wheel.getBoundingClientRect();
      drag.last = angleAt(e, drag.rect);
      try { wheel.setPointerCapture(e.pointerId); } catch (_) {}
    });
    wheel.addEventListener('pointermove', (e) => {
      if (!drag.active) return;
      const a = angleAt(e, drag.rect);
      let d = a - drag.last;
      if (d > 180) d -= 360; if (d < -180) d += 360;
      drag.acc += d; drag.last = a;
      while (Math.abs(drag.acc) >= STEP) {
        const dir = drag.acc > 0 ? 1 : -1;
        drag.acc -= dir * STEP;
        wheelMoved = true;
        onScroll(dir);
      }
      if (wheelMoved) e.preventDefault();
    });
    const end = () => { drag.active = false; };
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
      const idx = +row.dataset.idx;
      state.sel[view] = idx;
      applySel(view);
      activate(view, idx);
    };
    el('list-playlists').addEventListener('click', rowClick('playlists'));
    el('list-artists').addEventListener('click', rowClick('artists'));
    el('grid-albums').addEventListener('click', rowClick('albums'));
    el('detail-tracks').addEventListener('click', rowClick('albumdetail'));
    el('search-results').addEventListener('click', rowClick('search'));

    el('menu-sidebar').addEventListener('click', (e) => {
      const it = e.target.closest('.menu-item');
      if (it) selMenu(+it.dataset.idx);
    });

    el('search-chips').addEventListener('click', (e) => {
      const c = e.target.closest('.chip');
      if (!c) return;
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
      else if (e.key === 'Enter') { if (!typing) { Feedback.press(); onCenter(); } }
      else if (e.key === 'ArrowRight') { if (!typing) { Feedback.press(); Player.nextTrack(); } }
      else if (e.key === 'ArrowLeft') { if (!typing) { Feedback.press(); Player.previousTrack(); } }
      else if (e.key === 'Escape' || (e.key === 'Backspace' && !typing)) { Feedback.press(); goMenu(); }
    });
  }

  // ===================================================================
  //  Boot
  // ===================================================================
  async function init() {
    bindWheel();
    bindButtons();
    bindLists();
    bindKeys();
    fitStage();
    window.addEventListener('resize', fitStage);
    window.addEventListener('orientationchange', fitStage);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fitStage);
    startClock();
    startTicker();

    // The menu view + Playlists highlight are present in the static HTML, so
    // the iPod paints fully on first frame with no async/network dependency.
    // We only re-assert the highlight here; we must NOT call go('menu') yet —
    // go() loads live data via getToken(), which on a ?code= callback would
    // redirect before Auth.init() can exchange the code (a login loop).
    setMi(3);

    if (CONFIG.CLIENT_ID === 'YOUR_CLIENT_ID_HERE' || CONFIG.REDIRECT_URI === 'YOUR_REDIRECT_URI_HERE') {
      toast('Add CLIENT_ID & REDIRECT_URI in config.js');
      return;
    }

    // PKCE needs Web Crypto, which only exists in a secure context. Fail with
    // an actionable message instead of an opaque TypeError from crypto.subtle.
    if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
      toast('Open over https or http://127.0.0.1 to sign in');
      return;
    }

    try {
      const ok = await Auth.init();
      if (!ok) return;                  // redirecting to Spotify
    } catch (e) {
      console.warn(e);
      const m = (e && e.message) || '';
      toast(
        /STORAGE_BLOCKED/.test(m) ? 'Storage blocked — exit Private mode / enable cookies'
        : /Token exchange failed|state mismatch/i.test(m) ? m   // show the real cause
        : 'Sign-in required'
      );
      return;
    }

    // Authenticated: connect the Web Playback SDK (only now, so it can never
    // force a login redirect before we're configured), activate the menu for
    // real, and load live cover-flow data.
    Player.start();
    setMi(3);
    go('menu');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { goMenu, onCenter, onScroll, toast, onPlayerState };
})();

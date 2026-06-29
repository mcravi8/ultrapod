/* ============================================================
   UltraPod — spotify.js
   All Spotify Web API calls. Every request is authenticated with
   Auth.getToken(). Centralized error handling:
     - 401  -> refresh token once, retry; else redirect to auth
     - 404/403 on playback -> "Premium required" toast (via UI)
     - no active device on play -> transferPlayback then retry
   ============================================================ */
/* Named SpotifyAPI (not "Spotify") to avoid colliding with the Web
   Playback SDK's global window.Spotify (used as `new Spotify.Player`). */
const SpotifyAPI = (() => {
  const BASE = 'https://api.spotify.com/v1';
  // Names this app has given its Web Playback SDK device (current + legacy).
  // A device with one of these names lingering in /me/player/devices is a
  // phantom SDK device that can't stream on iOS — never target it (incl. an
  // older 'UltraPod' phantom still alive server-side after an upgrade).
  const SDK_DEVICE_NAMES = ['iPod', 'UltraPod'];

  // Set by player.js once the Web Playback SDK reports a device id.
  let _deviceId = null;

  // When the in-browser SDK isn't the active device (iOS Safari can't stream),
  // we target a real Spotify Connect device instead — including the user's phone
  // app when it's merely paused/idle (it still appears in /me/player/devices).
  // Cached briefly; re-resolved on demand or after a stale-device 404.
  let _fallbackId = null;
  let _fallbackAt = 0;
  // The device the user explicitly chose in the Devices picker. When still
  // available it overrides automatic selection so playback goes where they said.
  let _preferredId = null;
  function setDeviceId(id) { _deviceId = id; _fallbackId = null; _fallbackAt = 0; }
  function setPreferredDevice(id) { _preferredId = id; _fallbackId = null; _fallbackAt = 0; }

  // GET /v1/me/player/devices -> the user's available Connect devices.
  async function getDevices() {
    const data = await getJSON('/me/player/devices');
    return (data && data.devices) || [];
  }

  // Pick a device to target. Desktop: the in-browser SDK device. Otherwise the
  // best available Connect device — preferring the active one, then any
  // controllable (non-restricted) one (e.g. a paused phone), then anything.
  // Returns null only when the user has NO available device at all.
  async function resolveDeviceId(force) {
    if (_deviceId) return _deviceId;
    const now = Date.now();
    if (!force && _fallbackId && (now - _fallbackAt) < 30000) return _fallbackId;
    let devices = [];
    try { devices = await getDevices(); } catch (e) {}
    _fallbackAt = now;
    // Drop any phantom Web-Playback-SDK device named like our player ("iPod").
    // On iOS that device registers but CANNOT output audio, so targeting it
    // sends playback into silence ("Spotify says playing on iPod, but nothing
    // plays"). We never connect it on iOS now, but a stale one can linger in the
    // list for a few minutes after an old session — ignore it either way.
    devices = devices.filter(d => d && d.id && SDK_DEVICE_NAMES.indexOf(d.name) === -1);
    if (!devices.length) { _fallbackId = null; return null; }
    // Order of preference:
    //  1. the device the user picked in Devices (if still available),
    //  2. the already-active device (don't steal what's currently playing),
    //  3. THIS phone (so an iPhone-held iPod plays through the phone),
    //  4. any controllable (non-restricted) device, e.g. a paused speaker,
    //  5. anything.
    const preferred = _preferredId && devices.find(d => d.id === _preferredId);
    const active = devices.find(d => d.is_active);
    const phone  = devices.find(d => !d.is_restricted && d.type === 'Smartphone');
    const free   = devices.find(d => !d.is_restricted);
    const chosen = preferred || active || phone || free || devices[0];
    _fallbackId = (chosen && chosen.id) || null;
    return _fallbackId;
  }

  // ---- core fetch with auth + 401 retry ------------------------------
  async function api(path, { method = 'GET', body, retry = true } = {}) {
    let token;
    try {
      token = await Auth.getToken();
    } catch (e) {
      // getToken() already redirects (throwing 'Redirecting…') when there is no
      // refresh token. If it threw for ANY other reason — e.g. a refresh that
      // failed and cleared the tokens — no redirect happened, so start one here.
      if (!/Redirecting/.test((e && e.message) || '')) Auth.login();
      throw e;
    }

    const opts = {
      method,
      headers: { Authorization: 'Bearer ' + token }
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(BASE + path, opts);

    // 401 -> token went stale: force a refresh and retry the call once.
    // The single outer catch owns re-auth so Auth.login() runs exactly once
    // whether the retry still 401s OR the refresh itself fails.
    if (res.status === 401 && retry) {
      // Mark the token expired so the next getToken() triggers a refresh.
      localStorage.setItem('spotify_expires_at', '0');
      try {
        return await api(path, { method, body, retry: false });
      } catch (e) {
        Auth.login();
        throw new Error('Re-authenticating');
      }
    }

    if (res.status === 401) {              // retry already used up (inner call)
      throw new Error('AUTH_FAILED');      // let the outer catch trigger login once
    }

    return res;
  }

  // Convenience: GET + parse JSON (204/empty -> null).
  async function getJSON(path) {
    const res = await api(path);
    if (res.status === 204) return null;
    if (!res.ok) {
      // Surface as null so views render their empty state instead of crashing.
      console.warn('GET', path, '->', res.status);
      return null;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ---- helpers -------------------------------------------------------
  function smallestImage(images) {
    if (!images || !images.length) return null;
    // pick a small-ish image (last is usually smallest)
    return images[images.length - 1].url;
  }
  function largestImage(images) {
    if (!images || !images.length) return null;
    return images[0].url;
  }

  // ===================================================================
  //  Library / browse
  // ===================================================================

  // GET /v1/me/playlists -> [{ id, name, image, uri }]
  async function getPlaylists() {
    const data = await getJSON('/me/playlists?limit=50');
    if (!data || !data.items) return [];
    return data.items.filter(Boolean).map(p => ({
      id: p.id,
      name: p.name,
      image: smallestImage(p.images),
      uri: p.uri,
      type: 'playlist'
    }));
  }

  // GET /v1/me/following?type=artist -> [{ id, name, image }]
  async function getFollowedArtists() {
    const data = await getJSON('/me/following?type=artist&limit=50');
    const items = data && data.artists && data.artists.items;
    if (!items) return [];
    return items.filter(Boolean).map(a => ({
      id: a.id,
      name: a.name,
      image: smallestImage(a.images),
      uri: a.uri,
      type: 'artist'
    }));
  }

  // GET /v1/me/albums -> [{ id, name, artist, image, uri }]
  async function getSavedAlbums() {
    const data = await getJSON('/me/albums?limit=50');
    if (!data || !data.items) return [];
    return data.items.filter(it => it && it.album).map(it => {
      const al = it.album;
      return {
        id: al.id,
        name: al.name,
        artist: (al.artists || []).map(a => a.name).join(', '),
        image: largestImage(al.images),
        year: (al.release_date || '').slice(0, 4),
        uri: al.uri,
        type: 'album'
      };
    });
  }

  // GET /v1/albums/{id}/tracks -> [{ name, duration_ms, track_number, uri }]
  async function getAlbumTracks(albumId) {
    const data = await getJSON('/albums/' + albumId + '/tracks?limit=50');
    if (!data || !data.items) return [];
    return data.items.filter(Boolean).map(t => ({
      name: t.name,
      duration_ms: t.duration_ms,
      track_number: t.track_number,
      uri: t.uri,
      type: 'track'
    }));
  }

  // GET /v1/me/tracks -> Liked Songs (used for "All Music")
  async function getSavedTracks() {
    const data = await getJSON('/me/tracks?limit=50');
    if (!data || !data.items) return [];
    return data.items
      .map(it => it.track)
      .filter(Boolean)
      .map((t, i) => ({
        name: t.name,
        duration_ms: t.duration_ms,
        track_number: i + 1,
        artist: (t.artists || []).map(a => a.name).join(', '),
        image: t.album ? smallestImage(t.album.images) : null,
        uri: t.uri,
        type: 'track'
      }));
  }

  // GET /v1/playlists/{id}/tracks -> [{ name, artist, image, duration_ms, uri }]
  // Skips local files and podcast episodes (not playable as plain track uris).
  async function getPlaylistTracks(playlistId) {
    const data = await getJSON('/playlists/' + playlistId + '/tracks?limit=100');
    if (!data || !data.items) return [];
    return data.items
      .map(it => it.track)
      .filter(t => t && t.uri && !t.is_local && t.type === 'track')
      .map((t, i) => ({
        name: t.name,
        duration_ms: t.duration_ms,
        track_number: i + 1,
        artist: (t.artists || []).map(a => a.name).join(', '),
        image: t.album ? smallestImage(t.album.images) : null,
        uri: t.uri,
        type: 'track'
      }));
  }

  // GET /v1/me/player/recently-played?limit=10 -> for Cover Flow
  async function getRecentlyPlayed() {
    const data = await getJSON('/me/player/recently-played?limit=10');
    if (!data || !data.items) return [];
    // De-dupe by album so the cover flow shows distinct covers.
    const seen = new Set();
    const out = [];
    for (const it of data.items) {
      const tr = it.track;
      if (!tr || !tr.album) continue;
      const al = tr.album;
      if (seen.has(al.id)) continue;
      seen.add(al.id);
      out.push({
        albumId: al.id,
        title: al.name,
        artist: (tr.artists || []).map(a => a.name).join(', '),
        image: largestImage(al.images),
        uri: al.uri,
        trackUri: tr.uri
      });
    }
    return out;
  }

  // GET /v1/me/player/currently-playing
  async function getCurrentlyPlaying() {
    const data = await getJSON('/me/player/currently-playing');
    if (!data || !data.item) return null;
    const t = data.item;
    return {
      name: t.name,
      artist: (t.artists || []).map(a => a.name).join(', '),
      albumName: t.album ? t.album.name : '',
      image: t.album ? largestImage(t.album.images) : null,
      progress_ms: data.progress_ms || 0,
      duration_ms: t.duration_ms || 0,
      is_playing: !!data.is_playing,
      uri: t.uri
    };
  }

  // GET /v1/search?q=&type=track,album,artist&limit=10
  async function search(query) {
    if (!query || !query.trim()) return { tracks: [], albums: [], artists: [] };
    const q = encodeURIComponent(query.trim());
    const data = await getJSON('/search?q=' + q + '&type=track,album,artist&limit=10');
    if (!data) return { tracks: [], albums: [], artists: [] };
    const tracks = ((data.tracks && data.tracks.items) || []).filter(Boolean).map(t => ({
      id: t.id, name: t.name,
      artist: (t.artists || []).map(a => a.name).join(', '),
      image: t.album ? smallestImage(t.album.images) : null,
      uri: t.uri, type: 'track'
    }));
    const albums = ((data.albums && data.albums.items) || []).filter(Boolean).map(a => ({
      id: a.id, name: a.name,
      artist: (a.artists || []).map(x => x.name).join(', '),
      image: smallestImage(a.images),
      year: (a.release_date || '').slice(0, 4),
      uri: a.uri, type: 'album'
    }));
    const artists = ((data.artists && data.artists.items) || []).filter(Boolean).map(a => ({
      id: a.id, name: a.name,
      image: smallestImage(a.images),
      uri: a.uri, type: 'artist'
    }));
    return { tracks, albums, artists };
  }

  // ===================================================================
  //  Playback control
  // ===================================================================

  // Internal: a PUT to /me/player/play, targeting a resolved device so playback
  // starts even when nothing is currently active (paused phone, idle speaker).
  async function play(payload, deviceOverride) {
    const dev = deviceOverride || await resolveDeviceId();
    const qs = dev ? ('?device_id=' + dev) : '';
    const res = await api('/me/player/play' + qs, { method: 'PUT', body: payload });

    if (res.ok || res.status === 204) return true;

    // 404 = the target went away (or there was none). Find a fresh device and
    // retry once with that EXACT target. Passing device_id to /play also
    // transfers playback to it, so a paused/idle device starts playing without
    // the user opening Spotify first. (deviceOverride caps this at one retry.)
    if (res.status === 404 && !deviceOverride) {
      const target = _deviceId || await resolveDeviceId(true);
      if (target) {
        await transferPlayback(target, false);
        await new Promise(r => setTimeout(r, 600));   // give Spotify a beat
        return play(payload, target);
      }
    }

    // 403 is the real non-premium / restriction signal.
    if (res.status === 403) {
      if (window.UI && UI.toast) UI.toast('Premium required for playback');
      return false;
    }
    // 404 with no resolvable device: the user genuinely has nowhere to play
    // (Spotify not open anywhere). Don't blame Premium.
    if (res.status === 404) {
      if (window.UI && UI.toast) UI.toast('No active device — open Menu ▸ Devices to pick one');
      return false;
    }

    console.warn('play ->', res.status);
    if (window.UI && UI.toast) UI.toast('Playback unavailable');
    return false;
  }

  // PUT /v1/me/player/play  { context_uri, offset? }
  // offset may be a number (position) OR a track uri string (robust to filtered
  // lists where positions shift, e.g. a playlist with podcast/local items).
  function playContext(contextUri, offset) {
    const body = { context_uri: contextUri };
    if (typeof offset === 'number') body.offset = { position: offset };
    else if (typeof offset === 'string') body.offset = { uri: offset };
    return play(body);
  }

  // PUT /v1/me/player/play  { uris, offset }
  function playTracks(uris, offset = 0) {
    return play({ uris, offset: { position: offset } });
  }

  // PUT /v1/me/player  -> transfer playback to the in-browser SDK device
  async function transferPlayback(deviceId, startPlaying = false) {
    const id = deviceId || _deviceId;
    if (!id) return false;
    const res = await api('/me/player', {
      method: 'PUT',
      body: { device_ids: [id], play: startPlaying }
    });
    return res.ok || res.status === 204;
  }

  // ---- transport (Web API) -------------------------------------------
  // Used as a fallback when the in-browser SDK is not the active device
  // (notably iOS Safari, where the SDK does not stream). When _deviceId is
  // null these act on the user's currently-active device.
  function ok(res) { return res.ok || res.status === 204; }
  // On failure, surface the same actionable toasts as play() so the wheel's
  // play/pause/next/prev buttons never fail silently (notably on iOS with no
  // active device, where these 404).
  function transportFail(status) {
    if (window.UI && UI.toast) {
      if (status === 403) UI.toast('Premium required for playback');
      else if (status === 404) UI.toast('No active device — open Menu ▸ Devices to pick one');
      else UI.toast('Playback unavailable');
    }
    return false;
  }
  // PUT/POST a transport command against a resolved device; toast + return false
  // on any non-OK status. On a stale-device 404 (the cached target closed),
  // re-scan once and retry on a fresh device before giving up.
  async function transport(path, method) {
    const dev = await resolveDeviceId();
    const res = await api(path + (dev ? '?device_id=' + dev : ''), { method });
    if (ok(res)) return true;
    if (res.status === 404 && !_deviceId) {
      const dev2 = await resolveDeviceId(true);
      if (dev2 && dev2 !== dev) {
        const res2 = await api(path + '?device_id=' + dev2, { method });
        if (ok(res2)) return true;
        return transportFail(res2.status);
      }
    }
    return transportFail(res.status);
  }
  function resume()   { return transport('/me/player/play',     'PUT'); }
  function pause()    { return transport('/me/player/pause',    'PUT'); }
  function next()     { return transport('/me/player/next',     'POST'); }
  function previous() { return transport('/me/player/previous', 'POST'); }

  // ---- volume --------------------------------------------------------
  // The ACTIVE device object (the only one the volume endpoint accepts), with
  // its volume capability, or null when nothing is active. supports_volume is
  // false for e.g. the Spotify phone app (hardware-only volume) and many casts.
  async function getActiveDevice() {
    const data = await getJSON('/me/player');
    if (!data || !data.device) return null;
    const d = data.device;
    return {
      id: d.id, name: d.name, type: d.type,
      volume_percent: (typeof d.volume_percent === 'number' ? d.volume_percent : null),
      supports_volume: d.supports_volume !== false,
      is_restricted: !!d.is_restricted
    };
  }
  // PUT /me/player/volume on the active device. Returns a REASON (not a bool):
  // 'ok' | 'no-device' (404) | 'premium' (403 PREMIUM_REQUIRED) |
  // 'unsupported' (403 other — e.g. a phone whose volume is hardware-only) | 'error'.
  async function setVolume(percent, deviceId) {
    const v = Math.max(0, Math.min(100, Math.round(percent)));
    const res = await api('/me/player/volume?volume_percent=' + v + (deviceId ? '&device_id=' + deviceId : ''), { method: 'PUT' });
    if (res.ok || res.status === 204) return 'ok';
    if (res.status === 404) return 'no-device';
    if (res.status === 403) {
      let reason = '';
      try { const j = await res.json(); reason = (j && j.error && j.error.reason) || ''; } catch (e) {}
      return reason === 'PREMIUM_REQUIRED' ? 'premium' : 'unsupported';
    }
    return 'error';
  }

  return {
    setDeviceId, setPreferredDevice, getDevices,
    getPlaylists, getFollowedArtists, getSavedAlbums, getAlbumTracks,
    getPlaylistTracks, getSavedTracks, getRecentlyPlayed,
    getCurrentlyPlaying, search,
    playContext, playTracks, transferPlayback,
    resume, pause, next, previous,
    setVolume, getActiveDevice
  };
})();

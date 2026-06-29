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

  // Set by player.js once the Web Playback SDK reports a device id.
  let _deviceId = null;
  function setDeviceId(id) { _deviceId = id; }
  function getDeviceId() { return _deviceId; }

  // ---- core fetch with auth + 401 retry ------------------------------
  async function api(path, { method = 'GET', body, retry = true } = {}) {
    let token;
    try { token = await Auth.getToken(); }
    catch (e) { throw e; }                 // getToken may redirect to login

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

  // GET /v1/playlists/{id}/tracks -> tracklist (used by album-detail view)
  async function getPlaylistTracks(playlistId) {
    const data = await getJSON('/playlists/' + playlistId +
      '/tracks?limit=50&fields=items(track(name,duration_ms,uri,track_number,artists(name)))');
    if (!data || !data.items) return [];
    return data.items
      .map(it => it.track)
      .filter(Boolean)
      .map((t, i) => ({
        name: t.name,
        duration_ms: t.duration_ms,
        track_number: i + 1,
        artist: (t.artists || []).map(a => a.name).join(', '),
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

  // Internal: a PUT to /me/player/play with retry-on-no-device logic.
  async function play(payload, allowRetry = true) {
    const qs = _deviceId ? ('?device_id=' + _deviceId) : '';
    const res = await api('/me/player/play' + qs, { method: 'PUT', body: payload });

    if (res.ok || res.status === 204) return true;

    // No active device -> make our SDK device active and retry once.
    if (res.status === 404 && allowRetry && _deviceId) {
      await transferPlayback(_deviceId, false);
      await new Promise(r => setTimeout(r, 600));   // give Spotify a beat
      return play(payload, false);
    }

    // 403 (often restriction / non-premium) or 404 with no device.
    if (res.status === 403 || res.status === 404) {
      if (window.UI && UI.toast) UI.toast('Premium required for playback');
      return false;
    }

    console.warn('play ->', res.status);
    if (window.UI && UI.toast) UI.toast('Playback unavailable');
    return false;
  }

  // PUT /v1/me/player/play  { context_uri }
  function playContext(contextUri) {
    return play({ context_uri: contextUri });
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
  async function resume() {
    const res = await api('/me/player/play' + (_deviceId ? '?device_id=' + _deviceId : ''), { method: 'PUT' });
    return ok(res);
  }
  async function pause() {
    const res = await api('/me/player/pause' + (_deviceId ? '?device_id=' + _deviceId : ''), { method: 'PUT' });
    return ok(res);
  }
  async function next() {
    const res = await api('/me/player/next' + (_deviceId ? '?device_id=' + _deviceId : ''), { method: 'POST' });
    return ok(res);
  }
  async function previous() {
    const res = await api('/me/player/previous' + (_deviceId ? '?device_id=' + _deviceId : ''), { method: 'POST' });
    return ok(res);
  }

  return {
    setDeviceId, getDeviceId,
    getPlaylists, getFollowedArtists, getSavedAlbums, getAlbumTracks,
    getPlaylistTracks, getSavedTracks, getRecentlyPlayed,
    getCurrentlyPlaying, search,
    playContext, playTracks, transferPlayback,
    resume, pause, next, previous
  };
})();

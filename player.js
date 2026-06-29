/* ============================================================
   UltraPod — player.js
   Spotify Web Playback SDK init + click-wheel button bindings.

   The SDK calls window.onSpotifyWebPlaybackSDKReady once
   https://sdk.scdn.co/spotify-player.js has loaded. We do NOT build/connect
   the player there directly — ui.js calls Player.start() only AFTER auth has
   succeeded, so the SDK never forces a login redirect on its own (which would
   bypass the not-configured / insecure-context gating in ui.js).

   NOTE: the Web Playback SDK streams audio only in desktop browsers.
   On iOS Safari it still registers as a device and the controls below
   drive whatever device is active (or surface "Premium required").
   ============================================================ */
const Player = (() => {
  let _player = null;
  let _deviceId = null;
  let _ready = false;
  let _paused = true;       // tracked from player_state_changed for fallback toggle
  let _sdkLoaded = false;   // SDK script finished loading
  let _started = false;     // ui.js authorised us to connect
  let _transferred = false; // playback transferred to this device once (non-iOS)

  // The Web Playback SDK registers as a Spotify Connect device on iOS but
  // cannot stream audio there. Detect iOS (incl. iPadOS reporting a Mac UA) so
  // we DON'T trust it as the active device — instead we fall through to Web-API
  // control of the user's real active device.
  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
    (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document);

  // Build + connect the player. Safe to call once; guarded by _player.
  function build() {
    if (_player || typeof Spotify === 'undefined' || !Spotify.Player) return;

    _player = new Spotify.Player({
      name: 'iPod',
      // On token failure hand the SDK an empty token so it raises
      // authentication_error immediately (handled below) instead of stalling
      // until its internal timeout.
      getOAuthToken: cb => { Auth.getToken().then(cb).catch(() => cb('')); },
      volume: 0.8
    });

    // ---- ready / not-ready --------------------------------------------
    _player.addListener('ready', ({ device_id }) => {
      _deviceId = device_id;
      if (isIOS) {
        // Don't mark ready and don't transfer/register: leaving
        // SpotifyAPI._deviceId null makes play()/resume()/pause()/next()/
        // previous() act on the user's CURRENT active Spotify device — the
        // intended iOS fallback (the SDK can't stream audio here anyway).
        return;
      }
      _ready = true;
      SpotifyAPI.setDeviceId(device_id);
      // Activate this device once; never yank playback back on later reconnects.
      if (!_transferred) {
        SpotifyAPI.transferPlayback(device_id, false).then(okk => { if (okk) _transferred = true; }).catch(() => {});
      }
    });

    _player.addListener('not_ready', ({ device_id }) => {
      _ready = false;
      console.warn('Device went offline', device_id);
    });

    // ---- errors -------------------------------------------------------
    const premiumMsg = () => { if (window.UI) UI.toast('Premium required for playback'); };
    _player.addListener('initialization_error', ({ message }) => console.warn('init_error', message));
    _player.addListener('authentication_error', ({ message }) => {
      // Do NOT redirect to login here — the SDK re-requests a token via
      // getOAuthToken (which refreshes on its own), and auto-login from this
      // listener can cause an endless authorize loop (esp. for non-Premium /
      // scope issues). Just surface it.
      console.warn('auth_error', message);
      if (window.UI) UI.toast('Playback needs Spotify Premium');
    });
    _player.addListener('account_error', ({ message }) => { console.warn('account_error', message); premiumMsg(); });
    _player.addListener('playback_error', ({ message }) => console.warn('playback_error', message));

    // ---- state changes -> update Now Playing --------------------------
    _player.addListener('player_state_changed', (state) => {
      if (!state) return;
      _paused = state.paused;
      if (window.UI && UI.onPlayerState) UI.onPlayerState(state);
    });

    _player.connect();
  }

  // The SDK invokes this global when the script finishes loading.
  window.onSpotifyWebPlaybackSDKReady = function () {
    _sdkLoaded = true;
    if (_started) build();          // ui.js already authorised us
  };

  // Called by ui.js once authentication has succeeded.
  function start() {
    _started = true;
    if (_sdkLoaded) build();        // else build() runs when the SDK loads
  }

  // ---- public playback controls (used by the click wheel) ------------
  // Prefer the in-browser SDK when it is the active/ready device; otherwise
  // (e.g. iOS Safari, where the SDK can't stream) drive the user's active
  // device through the Web API so the buttons still work.
  function previousTrack() {
    if (_ready && _player) _player.previousTrack().catch(() => SpotifyAPI.previous());
    else SpotifyAPI.previous();
  }
  function nextTrack() {
    if (_ready && _player) _player.nextTrack().catch(() => SpotifyAPI.next());
    else SpotifyAPI.next();
  }
  // Guard so a rapid double-press can't fire two toggles that race (both read
  // the same state and e.g. pause twice). Released once the press resolves.
  let _toggling = false;
  async function togglePlay() {
    if (_toggling) return;
    _toggling = true;
    try {
      if (_ready && _player) {
        try { await _player.togglePlay(); }
        catch (e) { await fallbackToggle(); }     // SDK refused -> Web API
      } else {
        await fallbackToggle();
      }
    } catch (e) {
      // Errors surface to the user as toasts inside SpotifyAPI; swallow here so
      // a failed network call never becomes an unhandled promise rejection.
    } finally {
      _toggling = false;
    }
  }
  // On iOS the SDK device is never made active, so player_state_changed never
  // fires and _paused stays stuck at its initial `true` — which made this button
  // always resume() and never pause(). Read the active device's real state from
  // the Web API at press time so it can BOTH pause and resume.
  async function fallbackToggle() {
    let playing = !_paused;                       // last-known hint (desktop SDK path)
    try {
      const cur = await SpotifyAPI.getCurrentlyPlaying();
      if (cur) playing = cur.is_playing;
    } catch (e) {}
    _paused = playing;                            // reflect the post-toggle state
    return playing ? SpotifyAPI.pause() : SpotifyAPI.resume();
  }

  return { start, previousTrack, nextTrack, togglePlay };
})();

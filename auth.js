/* ============================================================
   UltraPod — auth.js
   Spotify PKCE Authorization Code flow (no client secret).

   Public surface:
     Auth.init()      -> Promise<boolean>  (true once a valid token exists)
     Auth.getToken()  -> Promise<string>   (fresh access token, auto-refresh)
     Auth.login()     -> redirects to Spotify authorize
     Auth.logout()    -> clears tokens

   getToken() is awaited by every other module before an API call.
   ============================================================ */
const Auth = (() => {
  const AUTH_URL  = 'https://accounts.spotify.com/authorize';
  const TOKEN_URL = 'https://accounts.spotify.com/api/token';

  const LS = {
    access:   'spotify_access_token',
    refresh:  'spotify_refresh_token',
    expires:  'spotify_expires_at',     // ms epoch
    verifier: 'spotify_code_verifier',
    state:    'spotify_auth_state'
  };

  // ---- defensive localStorage (Private mode / blocked storage) -------
  // In locked-down contexts setItem (or even bare access) can throw; wrap
  // everything so a write failure never bubbles out as a generic error.
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  // Redirect-loop breaker. Stored in localStorage (NOT sessionStorage), because
  // an iOS standalone PWA starts a fresh sessionStorage on every Home-Screen
  // relaunch, which would reset the counter and defeat the guard. Time-windowed
  // so a stale guard auto-clears instead of permanently locking sign-in.
  const ATTEMPTS = 'spotify_login_attempts';
  const MAX_ATTEMPTS = 4;
  const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
  function getAttempts() {
    try {
      const raw = lsGet(ATTEMPTS); if (!raw) return 0;
      const o = JSON.parse(raw);
      if (!o || (Date.now() - (o.at || 0)) > ATTEMPT_WINDOW_MS) { lsDel(ATTEMPTS); return 0; }
      return o.n || 0;
    } catch (e) { return 0; }
  }
  function bumpAttempts() { lsSet(ATTEMPTS, JSON.stringify({ n: getAttempts() + 1, at: Date.now() })); }
  function resetAttempts() { lsDel(ATTEMPTS); }

  // ---- PKCE helpers --------------------------------------------------
  function randomString(len) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    let out = '';
    for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  function base64url(bytes) {
    let str = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function sha256(text) {
    const data = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', data);
  }

  // ---- token storage -------------------------------------------------
  function storeTokens(data) {
    let ok = true;
    if (data.access_token) ok = lsSet(LS.access, data.access_token) && ok;
    // Spotify omits refresh_token on some refreshes — keep the existing one.
    if (data.refresh_token) lsSet(LS.refresh, data.refresh_token);
    if (data.expires_in) lsSet(LS.expires, String(Date.now() + data.expires_in * 1000));
    // If we received a token but couldn't persist it, surface a clear error
    // rather than silently looping the login redirect on the next call.
    if (data.access_token && !ok) throw new Error('STORAGE_BLOCKED');
    if (data.access_token && ok) resetAttempts();   // auth succeeded -> reset loop guard
  }

  function clearTokens() {
    lsDel(LS.access);
    lsDel(LS.refresh);
    lsDel(LS.expires);
  }

  function isExpired() {
    if (!lsGet(LS.access)) return true;             // no token == not usable
    const exp = parseInt(lsGet(LS.expires) || '0', 10);
    // Refresh a minute early to avoid mid-request expiry.
    return !exp || Date.now() > exp - 60000;
  }

  // ---- authorize redirect (PKCE challenge + CSRF state) --------------
  function isConfigured() {
    return CONFIG.CLIENT_ID && CONFIG.CLIENT_ID !== 'YOUR_CLIENT_ID_HERE' &&
           CONFIG.REDIRECT_URI && CONFIG.REDIRECT_URI !== 'YOUR_REDIRECT_URI_HERE';
  }

  async function login() {
    // Never redirect to a broken Spotify page when the app isn't set up, or
    // when Web Crypto is unavailable (insecure context) — surface a toast.
    if (!isConfigured()) {
      if (window.UI && UI.toast) UI.toast('Add CLIENT_ID & REDIRECT_URI in config.js');
      return;
    }
    if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
      if (window.UI && UI.toast) UI.toast('Open over https or http://127.0.0.1 to sign in');
      return;
    }

    // Loop breaker: if we've bounced to Spotify several times recently without
    // succeeding, stop instead of redirecting again.
    if (getAttempts() >= MAX_ATTEMPTS) {
      if (window.UI && UI.toast) {
        UI.toast('Sign-in keeps failing. Check the Redirect URI in your Spotify app matches exactly, then try again.');
      }
      return;
    }
    bumpAttempts();

    const verifier  = randomString(64);
    const challenge = base64url(await sha256(verifier));
    const state     = randomString(16);
    lsSet(LS.verifier, verifier);
    lsSet(LS.state, state);

    const params = new URLSearchParams({
      client_id: CONFIG.CLIENT_ID,
      response_type: 'code',
      redirect_uri: CONFIG.REDIRECT_URI,
      scope: CONFIG.SCOPES,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state
    });
    window.location.href = `${AUTH_URL}?${params.toString()}`;
  }

  // ---- exchange ?code= for tokens ------------------------------------
  async function exchangeCode(code) {
    const verifier = lsGet(LS.verifier);
    if (!verifier) throw new Error('Missing PKCE verifier');

    const body = new URLSearchParams({
      client_id: CONFIG.CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: CONFIG.REDIRECT_URI,
      code_verifier: verifier
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!res.ok) throw new Error('Token exchange failed: ' + res.status);
    const data = await res.json();
    storeTokens(data);
    lsDel(LS.verifier);
  }

  // ---- refresh -------------------------------------------------------
  let refreshing = null;            // de-dupe concurrent refreshes
  async function refresh() {
    const refreshToken = lsGet(LS.refresh);
    if (!refreshToken) throw new Error('No refresh token');

    if (refreshing) return refreshing;     // share the in-flight promise
    refreshing = (async () => {
      const body = new URLSearchParams({
        client_id: CONFIG.CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      });
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      if (!res.ok) {
        clearTokens();
        throw new Error('Refresh failed: ' + res.status);
      }
      const data = await res.json();
      storeTokens(data);
    })();

    try { await refreshing; }
    finally { refreshing = null; }
  }

  // ---- public: always-fresh token ------------------------------------
  async function getToken() {
    if (isExpired()) {
      if (lsGet(LS.refresh)) {
        await refresh();
      } else {
        login();
        throw new Error('Redirecting to Spotify login');
      }
    }
    const token = lsGet(LS.access);
    if (!token) {
      login();
      throw new Error('Redirecting to Spotify login');
    }
    return token;
  }

  // ---- public: bootstrap on page load --------------------------------
  // Returns true if authenticated, false if a redirect is happening.
  async function init() {
    // Fail fast & clearly if persistent storage is unavailable, instead of
    // looping the login redirect after every API call.
    if (!lsSet('__up_probe', '1')) throw new Error('STORAGE_BLOCKED');
    lsDel('__up_probe');

    const url = new URL(window.location.href);
    const code  = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      // User denied or recoverable error. Reaching our registered redirect_uri
      // proves the URI is valid, so clear the loop guard.
      resetAttempts();
      lsDel(LS.state);
      cleanUrl();
      throw new Error('Spotify auth error: ' + error);
    }

    if (code) {
      const returnedState = url.searchParams.get('state');
      const expectedState = lsGet(LS.state);
      lsDel(LS.state);                                   // single-use
      // Strip the one-time ?code= up front so it can never be replayed on a
      // reload (auth codes are single-use). A valid round-trip with a code
      // proves the redirect URI works -> clear the loop guard.
      cleanUrl();
      resetAttempts();
      if (!expectedState || returnedState !== expectedState) {
        throw new Error('Auth state mismatch — please sign in again');
      }
      // Let exchange errors propagate to ui.js (which shows them). We do NOT
      // auto-call login() here: a persistently-failing exchange would otherwise
      // bounce straight back to the consent screen forever.
      await exchangeCode(code);
      return true;
    }

    // Have a usable (or refreshable) token?
    if (!isExpired()) return true;
    if (lsGet(LS.refresh)) {
      try { await refresh(); return true; }
      catch (e) { /* fall through */ }
    }

    // Nothing usable — do NOT auto-redirect (a silent cold-launch redirect
    // breaks out of an iOS standalone PWA and loops). ui.js shows a tappable
    // "Sign in with Spotify" button that calls login() on a user gesture.
    return false;
  }

  function cleanUrl() {
    // Strip query/hash without reconstructing from origin: under file://
    // window.location.origin serializes to "null", which would corrupt the
    // URL (and can throw SecurityError on replaceState).
    const clean = window.location.href.split('#')[0].split('?')[0];
    try { window.history.replaceState({}, document.title, clean); } catch (e) {}
  }

  function logout() {
    clearTokens();
    lsDel(LS.verifier);
    lsDel(LS.state);
  }

  return { init, getToken, login, logout };
})();

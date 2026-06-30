/* ============================================================
   UltraPod — config.js

   1. Create an app at https://developer.spotify.com/dashboard, copy its
      Client ID into CLIENT_ID below.
   2. REDIRECT_URI is auto-derived from wherever the app is served, so the
      same build works locally AND on GitHub Pages. In the Spotify dashboard
      (app → Settings → Redirect URIs) register BOTH exact URLs you'll use:
        - http://127.0.0.1:5173/index.html              (local dev)
        - https://<user>.github.io/<repo>/index.html    (hosted on the phone)

   NOTE: The Client ID is a public PKCE client identifier (there is no client
   secret), so it is safe to commit. Spotify does NOT accept file:// or
   http://localhost redirect URIs, and PKCE needs a secure context
   (https or http://127.0.0.1) — never open the file by double-clicking.
   ============================================================ */
const CONFIG = {
  CLIENT_ID: 'db1bc02319f34bc0bdfe261f0be2c32f',

  // Auto-derived: current origin + path (a bare directory normalizes to
  // index.html). Register each resulting URL in the Spotify dashboard.
  REDIRECT_URI: (function () {
    var p = window.location.pathname;
    if (p.charAt(p.length - 1) === '/') p += 'index.html';
    return window.location.origin + p;
  })(),

  // The required scopes, plus:
  //   user-read-recently-played -> Cover Flow (getRecentlyPlayed)
  //   user-follow-read          -> Artists (GET /me/following?type=artist)
  // This is a superset of the baseline scopes.
  SCOPES: 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-modify-public playlist-modify-private user-library-read user-library-modify streaming user-read-recently-played user-follow-read user-follow-modify'
};

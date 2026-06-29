# UltraPod

An iPod Classic–style web player for Spotify — click wheel, Cover Flow, Now Playing,
playlists, albums, artists and search, wired to live Spotify data. Vanilla JS, no
build step, installable as a PWA (Add to Home Screen on iOS).

## Run it on your phone

It's served over HTTPS via GitHub Pages, so it works as a home-screen app:

`https://mcravi8.github.io/ultrapod/index.html`

Open that in Safari → Share → **Add to Home Screen**. Launch it from the icon and it
runs full-screen.

## Run it locally

```bash
python3 -m http.server 5173 --bind 127.0.0.1
open http://127.0.0.1:5173/index.html
```

(Don't open the file directly — Spotify login needs a secure context: `https` or
`http://127.0.0.1`.)

## Setup (already done for this copy)

1. Create an app at https://developer.spotify.com/dashboard and put its **Client ID**
   in [`config.js`](config.js).
2. In the app's **Settings → Redirect URIs**, register both exact URLs you'll use:
   - `http://127.0.0.1:5173/index.html`
   - `https://mcravi8.github.io/ultrapod/index.html`
3. Enable **Web API** and **Web Playback SDK**.

The redirect URI is derived automatically from wherever the app is served, so the same
build works locally and hosted. The Client ID is a public PKCE identifier (no secret),
so it's safe to commit.

## Notes

- **Playback requires Spotify Premium** (Web Playback SDK). Browsing, search and the
  Now Playing display work without it.
- Auth is PKCE Authorization Code flow — no server, no client secret.

## Files

`index.html` · `config.js` · `auth.js` · `spotify.js` · `player.js` · `ui.js` ·
`style.css` · `manifest.json` · icons

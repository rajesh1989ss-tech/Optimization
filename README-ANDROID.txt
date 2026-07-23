OPTIMIZATIONS — ANDROID (GitHub Pages PWA)
==========================================

WHAT THIS FOLDER IS
  index.html            the complete app (same file as the Windows exe uses)
  manifest.webmanifest  install metadata (name, icons, true-black theme)
  sw.js                 network-first service worker (offline fallback)
  icon-*.png            launcher icons

UPLOAD (once)
  1. Create a GitHub repo (e.g. "optimizations") on rajesh1989ss-tech,
     or use a subfolder of an existing Pages repo — all paths are relative,
     so a subfolder works fine.
  2. Upload ALL files in this folder to the repo root (or subfolder).
  3. Repo Settings -> Pages -> Deploy from branch -> main -> / (root). Save.
  4. Wait ~1 minute. App URL:
     https://rajesh1989ss-tech.github.io/<repo>/            (root)
     https://rajesh1989ss-tech.github.io/<repo>/<folder>/   (subfolder)

INSTALL ON THE PHONE
  1. Open the URL in Chrome on Android.
  2. Menu (three dots) -> "Add to Home screen" / "Install app".
  3. Launches full-screen with a black status bar; data lives in
     IndexedDB on the phone.

OFFLINE + UPDATES
  Network-first: when online it always loads the newest uploaded file,
  when offline (at sea) it serves the cached copy. To ship an update just
  replace index.html in the repo — no cache-version dance needed.
  If Chrome ever seems stuck on an old copy: site settings -> clear
  storage is the nuclear option — EXPORT YOUR DATA FIRST (data is wiped
  with storage).

DATA
  Phone data stays on the phone. Move data between phone and the Windows
  exe with Master Mode -> Export / Import data (merge) — same JSON both
  ways, importing twice is harmless.

# Optimization

Two self-contained apps for a ship with unreliable or absent internet.

### `/` — Optimizations (Ship Suite)

Defect, observation and improvement tracker. A single-file PWA installed from
GitHub Pages; data lives in IndexedDB on the device. See
[README-ANDROID.txt](README-ANDROID.txt) for install and update instructions.

### `/chat` — Crew Chat

Messaging between devices on the same Wi-Fi **with no internet connection**.
One laptop runs a zero-dependency Node hub, everyone else opens the printed
`http://<ip>:8080` address. Channels, direct messages, file sharing, and an
outbox that flushes when a device comes back in range.

```sh
cd chat && node server.js
```

See [chat/README.md](chat/README.md).

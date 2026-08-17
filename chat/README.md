# Crew Chat — offline messaging over local Wi-Fi

Group chat, direct messages and file sharing between devices on the same
Wi-Fi, with **no internet connection at all**. Nothing leaves the network:
no cloud, no accounts, no third-party servers.

Built for the case where there is a router but no uplink — a ship at sea, a
site office, a plane, a power cut.

```
 phone ─┐
 phone ─┼─ Wi-Fi router ── laptop running `node server.js`  ← everything lives here
 laptop ┘   (no internet needed)
```

---

## Why one device has to host

A web page cannot find other phones on a Wi-Fi network by itself. Browsers
have no UDP broadcast, no mDNS, and WebRTC still needs a signalling server to
introduce two peers. So one device on the network plays host: it serves the
app and relays messages. Everyone else just opens a URL — nothing to install.

The host is deliberately cheap to run: **zero dependencies**. No `npm install`,
which matters because you cannot npm install anything at sea. It is one file
of plain Node, including a hand-written WebSocket implementation.

---

## Running it

On the machine that will host (any laptop on the Wi-Fi — it does **not** need
internet, only Node.js installed once beforehand):

```sh
node server.js                      # or: double-click start-chat.bat on Windows
node server.js --port 9000          # different port
node server.js --passcode anchor99  # require a passcode to join
```

It prints every address it is reachable at:

```
──────────────────────────────────────────────────────────
  CREW CHAT — offline messaging over local Wi-Fi
──────────────────────────────────────────────────────────
  Open this on any device on the same Wi-Fi:

      http://192.168.1.42:8080      (wlan0)

  On this machine:  http://localhost:8080
```

Everyone else connects their phone to the same Wi-Fi, opens that address in
any browser, picks a name, and is in. On Android, Chrome's *Add to Home
screen* gives it an app icon and a full-screen window.

Keep the host machine awake — a sleeping laptop takes the chat with it.

---

## What it does

**Messaging** — channels (`#general`, `#ops`, plus any you create), direct
messages between any two people, replies with quoted context, emoji
reactions, delete-your-own-message, typing indicators, unread badges, and
search across everything you have.

**Files** — drag and drop, paste a screenshot straight into the box, or attach
from the phone's camera roll. Images preview inline and are downscaled to
1600px before upload, because a shared boat Wi-Fi does not want your 8 MB
camera originals. Up to 25 MB per file.

**Offline behaviour** — this is the part that matters, and it works at two
different levels:

| What happened | What the app does |
|---|---|
| No internet, Wi-Fi fine | Everything works. Internet is never involved. |
| You walk out of Wi-Fi range | Messages you type go to an outbox and send themselves when you are back. History stays readable. |
| Host laptop reboots | Clients reconnect on their own and catch up on exactly what they missed. |
| You reload the page | History comes back from the phone's own IndexedDB copy. |

**Presence** — who is online right now, and when the others were last seen.

---

## How catching up works

The hub is an append-only event log. Every message, reaction, deletion and
channel creation gets a sequence number and is written to
`data/events.jsonl`. Clients mirror those same events into IndexedDB and run
the **same reducer** over them.

That makes reconnecting boring, which is the goal: a client says *"I have up
to sequence 4,182"*, and the hub sends everything after that which the client
is allowed to see. A phone that was off for a day and a laptop that never
disconnected end up with an identical picture.

Messages carry a client-generated id, so an outbox retry whose ack was lost
in a dropped connection is recognised and re-acked rather than posted twice.

---

## Security model — read this bit

The trust boundary is **the Wi-Fi network**. Anyone who can reach the host can
join, pick any display name, and read every channel. That is the right model
for a crew on a private network and the wrong one for a café hotspot.

- `--passcode` adds a shared secret for joining and uploading. It is a
  doorlock, not encryption.
- Traffic is plain HTTP on the LAN. It is not end-to-end encrypted, and
  someone on the same network with the right tools could watch it.
- Direct messages are enforced server-side: a third party is not sent them and
  cannot post into them (there are tests for both). But they are private *from
  other users*, not from whoever runs the host machine — `data/events.jsonl`
  is readable there.
- Uploads are stored under server-issued filenames only; a client cannot
  choose the path, and path traversal on both routes is refused.

Do not use this to carry anything you would not be comfortable having on the
host laptop in plain text.

### One honest limitation

Browsers only allow service workers on secure origins. Over
`http://192.168.x.x` there is no HTTPS, so **the app shell itself is not
cached on phones** — the page must be loaded while the host is reachable.
Once loaded, everything above still applies: the tab keeps working, queues
messages, and reads history offline. On the host machine itself
(`http://localhost`) the service worker does register.

If you want true install-and-open-with-the-hub-down on phones, put the hub
behind HTTPS with a certificate the phones trust.

---

## Files

| File | What it is |
|---|---|
| `server.js` | The hub. Static file server + WebSocket relay + event log. No dependencies. |
| `index.html` | The whole client — UI, sync, IndexedDB, outbox. System fonts only, no CDN. |
| `sw.js` | Service worker for the app shell (secure origins only, see above). |
| `test.js` | 24 integration tests: run `node test.js`. |
| `start-chat.bat` / `start-chat.sh` | Double-click launchers. |
| `data/` | Created on first run: `events.jsonl`, `users.json`, `files/`. Delete it to wipe everything. |

Configuration is all flags or environment variables: `--port` / `PORT`,
`--passcode` / `CHAT_PASSCODE`, `--data` / `CHAT_DATA`.

---

## Housekeeping

To reset the whole chat, stop the hub and delete `data/`. To free space
without losing recent history, delete `data/files/` (old attachments will
show as broken links, messages stay). The event log compacts itself on
startup once it passes ~120,000 events.

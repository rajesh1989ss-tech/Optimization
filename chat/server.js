#!/usr/bin/env node
/*
 * Crew Chat — offline LAN messaging hub.
 *
 * One device on the Wi-Fi runs this file. Everyone else opens the printed
 * http://<ip>:<port> address in a browser and chats. No internet, no cloud,
 * no npm install: this uses nothing but Node's own standard library,
 * including a hand-rolled RFC 6455 WebSocket implementation, so it starts
 * on a laptop that has never been online.
 *
 *   node server.js [--port 8080] [--passcode secret] [--data ./data]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/* ------------------------------------------------------------------ config */

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return fallback;
}

const ROOT = __dirname;
const PORT = Number(process.env.PORT || flag('--port', 8080));
const PASSCODE = String(process.env.CHAT_PASSCODE || flag('--passcode', ''));
const DATA_DIR = path.resolve(process.env.CHAT_DATA || flag('--data', path.join(ROOT, 'data')));
const FILE_DIR = path.join(DATA_DIR, 'files');
const LOG_FILE = path.join(DATA_DIR, 'events.jsonl');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const MAX_UPLOAD = 25 * 1024 * 1024;   // per attachment
const MAX_TEXT = 8000;                 // characters per message
const MAX_FRAME = 1 * 1024 * 1024;     // websocket frame ceiling
const BACKFILL_LIMIT = 4000;           // events replayed to a reconnecting client
const COMPACT_ABOVE = 120000;          // rewrite the log once it passes this many events
const COMPACT_KEEP = 60000;

fs.mkdirSync(FILE_DIR, { recursive: true });

/* ------------------------------------------------------------------- state */

/* The server is an append-only event log plus a projection of it. Clients run
   the exact same reducer over the exact same events, which is what makes
   "reconnect and catch up" a single code path instead of a special case. */

let seq = 0;
const events = [];              // every event, ordered by seq
const messages = new Map();     // msgId -> msg event
const rooms = new Map();        // roomId -> {id, name, kind, members}
const users = new Map();        // deviceId -> {id, nick, lastSeen}
const sockets = new Set();      // live connections

const DEFAULT_ROOMS = [
  { id: 'general', name: 'general' },
  { id: 'ops', name: 'ops' },
];

function ensureRoom(ev) {
  if (rooms.has(ev.id)) return rooms.get(ev.id);
  const room = {
    id: ev.id,
    name: ev.name || ev.id,
    kind: ev.kind || (ev.id.startsWith('dm:') ? 'dm' : 'channel'),
    members: ev.members || (ev.id.startsWith('dm:') ? ev.id.slice(3).split('~') : null),
  };
  rooms.set(room.id, room);
  return room;
}

function canSee(roomId, deviceId) {
  const room = rooms.get(roomId);
  if (!room) return false;
  if (room.kind !== 'dm') return true;
  return Array.isArray(room.members) && room.members.includes(deviceId);
}

/* Apply one event to the projection. Used both when replaying the log at boot
   and when accepting something new, so there is only one definition of what an
   event means. */
function apply(ev) {
  switch (ev.t) {
    case 'room':
      ensureRoom(ev);
      break;
    case 'msg':
      ensureRoom({ id: ev.room });
      messages.set(ev.id, ev);
      break;
    case 'react': {
      const target = messages.get(ev.msg);
      if (!target) break;
      target.reactions = target.reactions || {};
      const who = target.reactions[ev.emoji] || [];
      const idx = who.indexOf(ev.from);
      if (ev.on && idx === -1) who.push(ev.from);
      if (!ev.on && idx !== -1) who.splice(idx, 1);
      if (who.length) target.reactions[ev.emoji] = who;
      else delete target.reactions[ev.emoji];
      break;
    }
    case 'del': {
      const target = messages.get(ev.msg);
      if (target && target.from === ev.from) {
        target.deleted = true;
        target.text = '';
        target.att = null;
      }
      break;
    }
  }
}

/* ------------------------------------------------------------------ storage */

let logStream = null;

function loadLog() {
  if (!fs.existsSync(LOG_FILE)) return;
  const raw = fs.readFileSync(LOG_FILE, 'utf8');
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (typeof ev.seq !== 'number') continue;
    events.push(ev);
    apply(ev);
    if (ev.seq > seq) seq = ev.seq;
  }
}

/* Keeping every message forever is fine for a crew, but not for a machine that
   has been up for a year. Trim the cold tail on boot, never mid-session. */
function compactIfNeeded() {
  if (events.length <= COMPACT_ABOVE) return;
  const kept = events.slice(-COMPACT_KEEP);
  const tmp = LOG_FILE + '.tmp';
  fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.renameSync(tmp, LOG_FILE);
  events.length = 0;
  events.push(...kept);
  log(`compacted event log down to ${kept.length} events`);
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return;
  try {
    const list = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    for (const u of list) users.set(u.id, u);
  } catch { /* a corrupt roster is not worth refusing to boot over */ }
}

let usersDirty = false;
function saveUsersSoon() { usersDirty = true; }
setInterval(() => {
  if (!usersDirty) return;
  usersDirty = false;
  const tmp = USERS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify([...users.values()], null, 1));
    fs.renameSync(tmp, USERS_FILE);
  } catch (e) { log('could not save roster: ' + e.message); }
}, 5000).unref();

/* Record an event: assign it a sequence number, project it, persist it,
   and hand it back for broadcast. */
function record(ev) {
  ev.seq = ++seq;
  events.push(ev);
  apply(ev);
  logStream.write(JSON.stringify(ev) + '\n');
  return ev;
}

/* -------------------------------------------------------------- websockets */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function wsSend(conn, obj) {
  if (conn.socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x81; // FIN + text
  conn.socket.write(Buffer.concat([header, payload]));
}

function wsControl(conn, opcode, payload = Buffer.alloc(0)) {
  if (conn.socket.destroyed) return;
  const header = Buffer.alloc(2);
  header[0] = 0x80 | opcode;
  header[1] = payload.length;
  conn.socket.write(Buffer.concat([header, payload]));
}

function wsClose(conn, code = 1000) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  try { wsControl(conn, 0x8, payload); } catch { /* already gone */ }
  conn.socket.end();
}

function readFrames(conn) {
  for (;;) {
    let buf = conn.buf;
    if (buf.length < 2) return;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;

    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = buf.readUInt32BE(2) * 4294967296 + buf.readUInt32BE(6);
      off = 10;
    }

    if (len > MAX_FRAME) { wsClose(conn, 1009); return; }
    if (!masked) { wsClose(conn, 1002); return; }   // clients must mask
    if (buf.length < off + 4) return;

    const mask = buf.subarray(off, off + 4);
    off += 4;
    if (buf.length < off + len) return;

    const payload = Buffer.from(buf.subarray(off, off + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    conn.buf = buf.subarray(off + len);

    if (opcode === 0x8) { wsClose(conn, 1000); return; }
    if (opcode === 0x9) { wsControl(conn, 0xa, payload); continue; }
    if (opcode === 0xa) { conn.pong = Date.now(); continue; }

    if (opcode === 0x0) {
      conn.frag.push(payload);
    } else {
      conn.frag = [payload];
    }
    if (!fin) {
      if (conn.frag.reduce((n, b) => n + b.length, 0) > MAX_FRAME) { wsClose(conn, 1009); return; }
      continue;
    }

    const whole = conn.frag.length === 1 ? conn.frag[0] : Buffer.concat(conn.frag);
    conn.frag = [];
    let msg;
    try { msg = JSON.parse(whole.toString('utf8')); } catch { continue; }
    try { onMessage(conn, msg); } catch (e) { log('handler error: ' + e.message); }
  }
}

/* ------------------------------------------------------------- chat protocol */

function visibleEventsSince(deviceId, since) {
  const out = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.seq <= since) break;
    let roomId = ev.room;
    if (ev.t === 'react' || ev.t === 'del') {
      const target = messages.get(ev.msg);
      if (!target) continue;
      roomId = target.room;
    }
    if (ev.t === 'room') roomId = ev.id;
    if (roomId && !canSee(roomId, deviceId)) continue;
    out.push(ev);
    if (out.length >= BACKFILL_LIMIT) break;
  }
  return out.reverse();
}

function roomListFor(deviceId) {
  return [...rooms.values()]
    .filter((r) => canSee(r.id, deviceId))
    .map((r) => ({ id: r.id, name: r.name, kind: r.kind, members: r.members }));
}

function presence() {
  const online = new Set();
  for (const c of sockets) if (c.deviceId) online.add(c.deviceId);
  return [...users.values()].map((u) => ({
    id: u.id,
    nick: u.nick,
    lastSeen: u.lastSeen,
    online: online.has(u.id),
  }));
}

function broadcast(obj, roomId) {
  for (const c of sockets) {
    if (!c.deviceId) continue;
    if (roomId && !canSee(roomId, c.deviceId)) continue;
    wsSend(c, obj);
  }
}

function broadcastPresence() {
  const list = presence();
  for (const c of sockets) if (c.deviceId) wsSend(c, { t: 'presence', users: list });
}

function onMessage(conn, msg) {
  /* Every connection must say hello before it can do anything else. */
  if (!conn.deviceId) {
    if (msg.t !== 'hello') { wsClose(conn, 1008); return; }
    if (PASSCODE && msg.passcode !== PASSCODE) {
      wsSend(conn, { t: 'denied', reason: 'Wrong passcode.' });
      wsClose(conn, 1008);
      return;
    }
    const id = String(msg.deviceId || '').slice(0, 64);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) { wsClose(conn, 1008); return; }

    conn.deviceId = id;
    conn.nick = cleanNick(msg.nick) || 'crew';
    users.set(id, { id, nick: conn.nick, lastSeen: Date.now() });
    saveUsersSoon();

    const since = Number(msg.since) || 0;
    wsSend(conn, {
      t: 'welcome',
      you: { id, nick: conn.nick },
      rooms: roomListFor(id),
      users: presence(),
      serverTime: Date.now(),
      seq,
    });
    wsSend(conn, { t: 'sync', events: visibleEventsSince(id, since), seq, full: since === 0 });
    broadcastPresence();
    return;
  }

  const user = users.get(conn.deviceId);
  if (user) { user.lastSeen = Date.now(); saveUsersSoon(); }

  switch (msg.t) {
    case 'msg': {
      const roomId = String(msg.room || '');
      if (!roomId) return;
      if (roomId.startsWith('dm:')) {
        const members = roomId.slice(3).split('~');
        if (!members.includes(conn.deviceId) || members.length !== 2) return;
        if (!rooms.has(roomId)) record({ t: 'room', id: roomId, name: roomId, kind: 'dm', members });
      } else if (!rooms.has(roomId)) {
        return; // channels are created explicitly, not by typing into a typo
      }

      const text = String(msg.text || '').slice(0, MAX_TEXT);
      const att = sanitizeAttachment(msg.att);
      if (!text.trim() && !att) return;

      const id = String(msg.id || crypto.randomUUID()).slice(0, 64);

      /* An outbox that never got its ack — a dropped Wi-Fi moment, a phone that
         slept mid-send — retries the same client-generated id. Re-ack it and
         stop: the message is already recorded, and recording it twice is how
         chat apps end up showing everything the crew said twice. */
      const seen = messages.get(id);
      if (seen) {
        if (seen.from === conn.deviceId) wsSend(conn, { t: 'ack', id, seq: seen.seq, at: seen.at });
        return;
      }

      const ev = record({
        t: 'msg',
        id,
        room: roomId,
        from: conn.deviceId,
        nick: conn.nick,
        text,
        att,
        reply: msg.reply ? String(msg.reply).slice(0, 64) : null,
        at: Date.now(),
      });
      /* The sender gets an ack carrying the server's sequence number, which is
         how a queued outbox entry turns into a delivered message. */
      wsSend(conn, { t: 'ack', id: ev.id, seq: ev.seq, at: ev.at });
      broadcast({ t: 'event', event: ev }, roomId);
      return;
    }

    case 'react': {
      const target = messages.get(String(msg.msg || ''));
      if (!target || !canSee(target.room, conn.deviceId)) return;
      const emoji = String(msg.emoji || '').slice(0, 8);
      if (!emoji) return;
      const ev = record({
        t: 'react',
        id: crypto.randomUUID(),
        msg: target.id,
        from: conn.deviceId,
        emoji,
        on: !!msg.on,
        at: Date.now(),
      });
      broadcast({ t: 'event', event: ev }, target.room);
      return;
    }

    case 'del': {
      const target = messages.get(String(msg.msg || ''));
      if (!target || target.from !== conn.deviceId) return;
      const ev = record({ t: 'del', id: crypto.randomUUID(), msg: target.id, from: conn.deviceId, at: Date.now() });
      broadcast({ t: 'event', event: ev }, target.room);
      return;
    }

    case 'room': {
      const name = cleanRoomName(msg.name);
      if (!name) return;
      const id = name;
      if (rooms.has(id)) { wsSend(conn, { t: 'roomExists', id }); return; }
      const ev = record({ t: 'room', id, name, kind: 'channel', by: conn.deviceId });
      broadcast({ t: 'event', event: ev });
      return;
    }

    case 'nick': {
      const nick = cleanNick(msg.nick);
      if (!nick) return;
      conn.nick = nick;
      const u = users.get(conn.deviceId);
      if (u) u.nick = nick;
      saveUsersSoon();
      broadcastPresence();
      return;
    }

    case 'typing': {
      const roomId = String(msg.room || '');
      if (!canSee(roomId, conn.deviceId)) return;
      for (const c of sockets) {
        if (c === conn || !c.deviceId) continue;
        if (!canSee(roomId, c.deviceId)) continue;
        wsSend(c, { t: 'typing', room: roomId, from: conn.deviceId, nick: conn.nick });
      }
      return;
    }

    case 'sync': {
      const since = Number(msg.since) || 0;
      wsSend(conn, { t: 'sync', events: visibleEventsSince(conn.deviceId, since), seq, full: since === 0 });
      return;
    }

    case 'ping':
      wsSend(conn, { t: 'pong', at: Date.now() });
      return;
  }
}

/* Drop control characters — whatever else someone wants to be called is their
   business, including spaces, ranks in brackets and non-Latin scripts. */
function cleanNick(v) {
  let out = '';
  for (const ch of String(v || '')) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code !== 127) out += ch;
  }
  return out.trim().slice(0, 32);
}

function cleanRoomName(v) {
  const s = String(v || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 32) || '';
}

function sanitizeAttachment(att) {
  if (!att || typeof att !== 'object') return null;
  const url = String(att.url || '');
  if (!/^files\/[A-Za-z0-9._-]+$/.test(url)) return null;
  return {
    url,
    name: String(att.name || 'file').slice(0, 120),
    type: String(att.type || 'application/octet-stream').slice(0, 80),
    size: Number(att.size) || 0,
    w: Number(att.w) || 0,
    h: Number(att.h) || 0,
  };
}

/* --------------------------------------------------------------- http layer */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

function safeJoin(base, rel) {
  const target = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function serveFile(res, file, { download } = {}) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': file.startsWith(FILE_DIR) ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (download) headers['Content-Disposition'] = `attachment; filename="${download.replace(/"/g, '')}"`;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

function handleUpload(req, res) {
  if (PASSCODE && req.headers['x-passcode'] !== PASSCODE) {
    res.writeHead(403).end('forbidden');
    return;
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD) { res.writeHead(413).end('too large'); return; }

  const name = String(req.headers['x-filename'] || 'file').slice(0, 120);
  const ext = (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || ['.bin'])[0];
  const id = crypto.randomUUID() + ext;
  const dest = path.join(FILE_DIR, id);
  const out = fs.createWriteStream(dest);

  let size = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_UPLOAD && !aborted) {
      aborted = true;
      out.destroy();
      fs.unlink(dest, () => {});
      res.writeHead(413).end('too large');
      req.destroy();
    }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (aborted) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      url: 'files/' + id,
      name: decodeURIComponent(name),
      type: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 80),
      size,
    }));
  });
  out.on('error', () => { if (!aborted) res.writeHead(500).end('write failed'); });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(u.pathname);

  if (req.method === 'POST' && pathname === '/upload') return handleUpload(req, res);

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, users: users.size, rooms: rooms.size, seq, clients: sockets.size }));
    return;
  }

  if (pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ passcode: !!PASSCODE, maxUpload: MAX_UPLOAD, name: os.hostname() }));
    return;
  }

  if (pathname.startsWith('/files/')) {
    const file = safeJoin(FILE_DIR, pathname.slice('/files/'.length));
    if (!file) { res.writeHead(400).end('bad path'); return; }
    return serveFile(res, file, { download: u.searchParams.get('dl') ? u.searchParams.get('dl') : null });
  }

  const rel = pathname === '/' ? 'index.html' : pathname;
  const file = safeJoin(ROOT, rel);
  if (!file) { res.writeHead(400).end('bad path'); return; }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return serveFile(res, path.join(ROOT, 'index.html'));
    serveFile(res, file);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const conn = { socket, buf: Buffer.alloc(0), frag: [], deviceId: null, nick: null, pong: Date.now() };
  sockets.add(conn);

  socket.on('data', (chunk) => {
    conn.buf = conn.buf.length ? Buffer.concat([conn.buf, chunk]) : chunk;
    try { readFrames(conn); } catch (e) { log('frame error: ' + e.message); wsClose(conn, 1011); }
  });
  const bye = () => {
    if (!sockets.delete(conn)) return;
    if (conn.deviceId) {
      const u = users.get(conn.deviceId);
      if (u) { u.lastSeen = Date.now(); saveUsersSoon(); }
      broadcastPresence();
    }
  };
  socket.on('close', bye);
  socket.on('error', bye);
});

/* Wi-Fi drops do not always close a TCP socket; without this, a phone that
   walked out of range would sit in the crew list as "online" forever. */
setInterval(() => {
  const now = Date.now();
  for (const conn of [...sockets]) {
    if (now - conn.pong > 70000) { wsClose(conn, 1001); conn.socket.destroy(); continue; }
    try { wsControl(conn, 0x9); } catch { /* closing */ }
  }
}, 25000).unref();

/* ------------------------------------------------------------------- boot */

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] ${msg}`);
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function banner() {
  const addrs = lanAddresses();
  const line = '─'.repeat(58);
  console.log('\n' + line);
  console.log('  CREW CHAT — offline messaging over local Wi-Fi');
  console.log(line);
  if (addrs.length === 0) {
    console.log('  No Wi-Fi/LAN address found. Connect this machine to the');
    console.log('  same network as the phones, then restart.');
  } else {
    console.log('  Open this on any device on the same Wi-Fi:\n');
    for (const a of addrs) {
      console.log(`      http://${a.address}:${PORT}      (${a.name})`);
    }
  }
  console.log(`\n  On this machine:  http://localhost:${PORT}`);
  console.log(`  Passcode:         ${PASSCODE ? 'required' : 'none (open to anyone on the Wi-Fi)'}`);
  console.log(`  Data:             ${DATA_DIR}`);
  console.log(`  History:          ${messages.size} messages, ${rooms.size} rooms, ${users.size} known crew`);
  console.log(line + '\n');
}

loadLog();
compactIfNeeded();
loadUsers();
logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
for (const r of DEFAULT_ROOMS) {
  if (!rooms.has(r.id)) record({ t: 'room', id: r.id, name: r.name, kind: 'channel', by: 'server' });
}

server.listen(PORT, '0.0.0.0', banner);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Try:  node server.js --port ${PORT + 1}\n`);
    process.exit(1);
  }
  throw e;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down');
    for (const c of sockets) wsClose(c, 1001);
    try {
      fs.writeFileSync(USERS_FILE, JSON.stringify([...users.values()], null, 1));
    } catch { /* best effort */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

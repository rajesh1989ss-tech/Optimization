#!/usr/bin/env node
/*
 * Integration test for the Crew Chat hub.
 *
 * Boots a real server on a scratch data directory and drives it with real
 * WebSocket clients (Node 22's built-in client, so the hand-rolled RFC 6455
 * server is checked against an implementation that did not come from here).
 *
 *   node test.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 8100 + Math.floor(Math.random() * 400);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'crewchat-test-'));

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + (e && e.message));
  }
}

/* ------------------------------------------------------------ harness bits */

function startServer(args = [], port = PORT, data = DATA) {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', String(port), '--data', data, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return child;
}

async function waitForServer(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server never came up on port ' + port);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A test client: connects, says hello, records everything it is told. */
function client(opts = {}, port = PORT) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const c = {
    ws,
    inbox: [],
    deviceId: opts.deviceId || 'dev-' + Math.random().toString(36).slice(2, 10),
    closed: false,
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
    /* Wait until some message satisfies pred, checking messages that already
       arrived first — otherwise every test would be a race. */
    async waitFor(pred, ms = 3000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = c.inbox.find(pred);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error('timed out waiting for a message');
        await sleep(25);
      }
    },
    async never(pred, ms = 600) {
      await sleep(ms);
      const hit = c.inbox.find(pred);
      if (hit) throw new Error('received a message it should not have: ' + JSON.stringify(hit).slice(0, 160));
    },
    syncedEvents() {
      return c.inbox.filter((m) => m.t === 'sync').flatMap((m) => m.events || [])
        .concat(c.inbox.filter((m) => m.t === 'event').map((m) => m.event));
    },
  };
  ws.addEventListener('message', (e) => { try { c.inbox.push(JSON.parse(e.data)); } catch { /* ignore */ } });
  ws.addEventListener('close', () => { c.closed = true; });
  c.ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      c.send({ t: 'hello', deviceId: c.deviceId, nick: opts.nick || 'tester', since: opts.since || 0, passcode: opts.passcode || '' });
      resolve();
    });
    ws.addEventListener('error', reject);
  });
  return c;
}

/* ------------------------------------------------------------------ tests */

async function main() {
  console.log('\nCrew Chat — integration test\n');
  const server = startServer();
  const health = await waitForServer(PORT);

  await check('server reports healthy with default rooms', async () => {
    assert.ok(health.ok);
    assert.ok(health.rooms >= 2, 'expected default channels');
  });

  await check('serves the client app at /', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    const body = await res.text();
    assert.strictEqual(res.status, 200);
    assert.ok(body.includes('Crew Chat'), 'index.html should be served at the root');
  });

  const alice = client({ nick: 'Alice', deviceId: 'dev-alice-000' });
  const bob = client({ nick: 'Bob', deviceId: 'dev-bob-00000' });
  await Promise.all([alice.ready, bob.ready]);

  await check('handshake returns a welcome with identity and rooms', async () => {
    const w = await alice.waitFor((m) => m.t === 'welcome');
    assert.strictEqual(w.you.id, 'dev-alice-000');
    assert.ok(w.rooms.some((r) => r.id === 'general'));
  });

  await check('presence lists both crew members as online', async () => {
    const p = await alice.waitFor((m) => m.t === 'presence' && m.users.length >= 2);
    const bobRow = p.users.find((u) => u.id === 'dev-bob-00000');
    assert.ok(bobRow && bobRow.online, 'Bob should show as online');
  });

  await check('a message is acked to the sender and broadcast to the room', async () => {
    alice.send({ t: 'msg', id: 'msg-1', room: 'general', text: 'engine room, all normal' });
    const ack = await alice.waitFor((m) => m.t === 'ack' && m.id === 'msg-1');
    assert.ok(ack.seq > 0, 'ack should carry a sequence number');
    const ev = await bob.waitFor((m) => m.t === 'event' && m.event.id === 'msg-1');
    assert.strictEqual(ev.event.text, 'engine room, all normal');
    assert.strictEqual(ev.event.nick, 'Alice', 'the hub stamps the sender name');
  });

  await check('re-sending a queued message keeps one copy, not two', async () => {
    /* This is the outbox retry case: the client sent it, the ack was lost, so
       it sends the same id again after reconnecting. */
    alice.send({ t: 'msg', id: 'msg-1', room: 'general', text: 'engine room, all normal' });
    await sleep(300);
    const late = client({ nick: 'Late', deviceId: 'dev-late-0000' });
    await late.ready;
    await late.waitFor((m) => m.t === 'sync');
    const copies = late.syncedEvents().filter((e) => e.t === 'msg' && e.id === 'msg-1');
    assert.strictEqual(copies.length, 1, 'a repeated id must not duplicate the message');
    late.close();
  });

  await check('empty messages are rejected', async () => {
    alice.send({ t: 'msg', id: 'msg-empty', room: 'general', text: '   ' });
    await bob.never((m) => m.t === 'event' && m.event.id === 'msg-empty');
  });

  await check('messages to an unknown channel are dropped', async () => {
    alice.send({ t: 'msg', id: 'msg-ghost', room: 'not-a-real-room', text: 'hello?' });
    await bob.never((m) => m.t === 'event' && m.event.id === 'msg-ghost');
  });

  await check('reactions toggle on and off', async () => {
    bob.send({ t: 'react', msg: 'msg-1', emoji: '👍', on: true });
    const on = await alice.waitFor((m) => m.t === 'event' && m.event.t === 'react' && m.event.on === true);
    assert.strictEqual(on.event.emoji, '👍');
    bob.send({ t: 'react', msg: 'msg-1', emoji: '👍', on: false });
    await alice.waitFor((m) => m.t === 'event' && m.event.t === 'react' && m.event.on === false);
  });

  await check('only the author can delete a message', async () => {
    bob.send({ t: 'del', msg: 'msg-1' });
    await alice.never((m) => m.t === 'event' && m.event.t === 'del');
    alice.send({ t: 'msg', id: 'msg-del', room: 'general', text: 'oops wrong channel' });
    await alice.waitFor((m) => m.t === 'ack' && m.id === 'msg-del');
    alice.send({ t: 'del', msg: 'msg-del' });
    const ev = await bob.waitFor((m) => m.t === 'event' && m.event.t === 'del');
    assert.strictEqual(ev.event.msg, 'msg-del');
  });

  await check('a new channel is announced to everyone', async () => {
    alice.send({ t: 'room', name: 'Engine Room' });
    const ev = await bob.waitFor((m) => m.t === 'event' && m.event.t === 'room');
    assert.strictEqual(ev.event.id, 'engine-room', 'channel names are normalised');
  });

  await check('direct messages reach the recipient', async () => {
    const dm = 'dm:' + ['dev-alice-000', 'dev-bob-00000'].sort().join('~');
    alice.send({ t: 'msg', id: 'dm-1', room: dm, text: 'private word' });
    const ev = await bob.waitFor((m) => m.t === 'event' && m.event.id === 'dm-1');
    assert.strictEqual(ev.event.text, 'private word');
  });

  await check('direct messages are hidden from everyone else', async () => {
    const carol = client({ nick: 'Carol', deviceId: 'dev-carol-000' });
    await carol.ready;
    await carol.waitFor((m) => m.t === 'sync');
    const leaked = carol.syncedEvents().find((e) => e.id === 'dm-1');
    assert.ok(!leaked, 'a third party must not receive a DM in its backfill');

    const dm = 'dm:' + ['dev-alice-000', 'dev-bob-00000'].sort().join('~');
    alice.send({ t: 'msg', id: 'dm-2', room: dm, text: 'still private' });
    await carol.never((m) => m.t === 'event' && m.event.id === 'dm-2');
    carol.close();
  });

  await check('an outsider cannot post into someone else’s DM', async () => {
    const carol = client({ nick: 'Carol', deviceId: 'dev-carol-000' });
    await carol.ready;
    const dm = 'dm:' + ['dev-alice-000', 'dev-bob-00000'].sort().join('~');
    carol.send({ t: 'msg', id: 'dm-intrude', room: dm, text: 'let me in' });
    await bob.never((m) => m.t === 'event' && m.event.id === 'dm-intrude');
    carol.close();
  });

  await check('reconnecting with a sequence number backfills only what was missed', async () => {
    const first = await alice.waitFor((m) => m.t === 'welcome');
    const cutoff = first.seq;
    alice.send({ t: 'msg', id: 'msg-after', room: 'general', text: 'sent while bob was away' });
    await alice.waitFor((m) => m.t === 'ack' && m.id === 'msg-after');

    const returning = client({ nick: 'Bob', deviceId: 'dev-bob-00000', since: cutoff });
    await returning.ready;
    const sync = await returning.waitFor((m) => m.t === 'sync');
    assert.ok(sync.events.some((e) => e.id === 'msg-after'), 'should receive what it missed');
    assert.ok(sync.events.every((e) => e.seq > cutoff), 'should not resend what it already had');
    returning.close();
  });

  await check('typing notices go to the room but not back to the sender', async () => {
    alice.send({ t: 'typing', room: 'general' });
    await bob.waitFor((m) => m.t === 'typing' && m.from === 'dev-alice-000');
    await alice.never((m) => m.t === 'typing', 300);
  });

  await check('renaming yourself updates presence for everyone', async () => {
    alice.send({ t: 'nick', nick: 'Alice (C/E)' });
    const p = await bob.waitFor((m) => m.t === 'presence' && m.users.some((u) => u.nick === 'Alice (C/E)'));
    assert.ok(p);
  });

  await check('uploads round-trip and attach to a message', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'x-filename': 'noon-report.txt' },
      body: 'ROB 412.5 MT',
    });
    assert.strictEqual(res.status, 200);
    const att = await res.json();
    assert.ok(/^files\/[A-Za-z0-9._-]+$/.test(att.url), 'upload should return a relative files/ url');

    const back = await fetch(`http://127.0.0.1:${PORT}/${att.url}`);
    assert.strictEqual(await back.text(), 'ROB 412.5 MT');

    alice.send({ t: 'msg', id: 'msg-att', room: 'general', text: '', att });
    const ev = await bob.waitFor((m) => m.t === 'event' && m.event.id === 'msg-att');
    assert.strictEqual(ev.event.att.name, 'noon-report.txt');
  });

  await check('a forged attachment path is stripped', async () => {
    alice.send({ t: 'msg', id: 'msg-bad-att', room: 'general', text: 'look', att: { url: '../../etc/passwd', name: 'x' } });
    const ev = await bob.waitFor((m) => m.t === 'event' && m.event.id === 'msg-bad-att');
    assert.strictEqual(ev.event.att, null, 'the hub must refuse an attachment path it did not issue');
  });

  await check('path traversal on the static route is refused', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/files/..%2F..%2Fserver.js`);
    const body = await res.text();
    assert.ok(!body.includes('WS_GUID'), 'must not serve files outside the upload directory');
  });

  await check('history survives a restart of the hub', async () => {
    server.kill('SIGTERM');
    await sleep(400);
    const again = startServer();
    await waitForServer(PORT);
    const fresh = client({ nick: 'Fresh', deviceId: 'dev-fresh-000' });
    await fresh.ready;
    await fresh.waitFor((m) => m.t === 'sync');
    const found = fresh.syncedEvents().find((e) => e.id === 'msg-1');
    assert.ok(found, 'messages should be replayed from the event log after a restart');
    assert.strictEqual(found.text, 'engine room, all normal');
    fresh.close();
    again.kill('SIGTERM');
  });

  alice.close();
  bob.close();
  await sleep(200);

  /* ---- a second hub, this one locked with a passcode ---- */
  const PORT2 = PORT + 1;
  const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'crewchat-pass-'));
  const locked = startServer(['--passcode', 'anchor99'], PORT2, DATA2);
  await waitForServer(PORT2);

  await check('the wrong passcode is refused', async () => {
    const c = client({ nick: 'Stranger', deviceId: 'dev-stranger0', passcode: 'guess' }, PORT2);
    await c.ready;
    const denied = await c.waitFor((m) => m.t === 'denied');
    assert.ok(denied.reason);
  });

  await check('the right passcode gets in', async () => {
    const c = client({ nick: 'Crew', deviceId: 'dev-crew-0000', passcode: 'anchor99' }, PORT2);
    await c.ready;
    await c.waitFor((m) => m.t === 'welcome');
    c.close();
  });

  await check('uploads are refused without the passcode', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT2}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'x-filename': 'sneak.txt' },
      body: 'nope',
    });
    assert.strictEqual(res.status, 403);
  });

  locked.kill('SIGTERM');
  await sleep(200);
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(DATA2, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.log('  failed: ' + f);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('\ntest harness crashed:', e);
  process.exit(1);
});

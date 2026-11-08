#!/usr/bin/env node
/*
 * IR Binder daemon (runs as root on a rooted webOS TV).
 *
 * - Reads every key-capable /dev/input/event* device (the IR receiver shows up here).
 * - Lets the UI "learn" a signal, then binds it to an action.
 * - Runs the bound action when that signal arrives, even when the app is closed.
 * - Exposes a small JSON API on 127.0.0.1:8765 for the UI app.
 */
'use strict';

// Each open input device blocks one libuv threadpool thread, so raise the limit
// before any async fs call happens.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '64';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const VERSION = '1.0.0';
const PORT = parseInt(process.env.IRBIND_PORT || '8765', 10);
const DATA_DIR = process.env.IRBIND_DATA || '/var/lib/irbind';
const INPUT_DIR = process.env.IRBIND_INPUT_DIR || '/dev/input';
const BINDINGS_FILE = path.join(DATA_DIR, 'bindings.json');

// struct input_event is 16 bytes for 32-bit processes and 24 bytes for 64-bit ones.
const EV_SIZE = /64$/.test(process.arch) ? 24 : 16;
const EV_SYN = 0, EV_KEY = 1, EV_MSC = 4, MSC_SCAN = 4;

const KEY_NAMES = {
  1: 'ESC', 2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9', 11: '0',
  28: 'ENTER', 102: 'HOME', 103: 'UP', 105: 'LEFT', 106: 'RIGHT', 108: 'DOWN',
  113: 'MUTE', 114: 'VOLUMEDOWN', 115: 'VOLUMEUP', 116: 'POWER', 119: 'PAUSE', 128: 'STOP',
  139: 'MENU', 158: 'BACK', 164: 'PLAYPAUSE', 168: 'REWIND', 174: 'EXIT', 207: 'PLAY',
  208: 'FASTFORWARD', 352: 'OK', 358: 'INFO', 398: 'RED', 399: 'GREEN', 400: 'YELLOW',
  401: 'BLUE', 402: 'CHANNELUP', 403: 'CHANNELDOWN', 512: 'NUMERIC_0', 513: 'NUMERIC_1',
};

function log() {
  const args = Array.prototype.slice.call(arguments);
  console.log.apply(console, [new Date().toISOString()].concat(args));
}

/* ------------------------------------------------------------------ bindings */

let bindings = {}; // sig -> { sig, label, action, repeat, signal, created }
let paused = false;

function loadBindings() {
  try {
    const data = JSON.parse(fs.readFileSync(BINDINGS_FILE, 'utf8'));
    bindings = data.bindings || {};
    paused = !!data.paused;
    log('loaded', Object.keys(bindings).length, 'bindings');
  } catch (e) {
    if (e.code !== 'ENOENT') log('could not read bindings:', e.message);
  }
}

function saveBindings() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = BINDINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, paused: paused, bindings: bindings }, null, 2));
    fs.renameSync(tmp, BINDINGS_FILE);
  } catch (e) {
    log('could not save bindings:', e.message);
  }
}

/* ------------------------------------------------------------- input devices */

const devices = new Map(); // "event3" -> device state

// Map eventN -> { name, hasKeys } from /proc/bus/input/devices.
function readDeviceInfo() {
  const map = {};
  let txt = '';
  try { txt = fs.readFileSync('/proc/bus/input/devices', 'utf8'); } catch (e) { return map; }
  txt.split(/\n\s*\n/).forEach(function (block) {
    const h = /H: Handlers=([^\n]*)/.exec(block);
    const ev = h && /\b(event\d+)\b/.exec(h[1]);
    if (!ev) return;
    const n = /N: Name="([^"]*)"/.exec(block);
    const bits = /B: EV=([0-9a-f]+)/i.exec(block);
    map[ev[1]] = {
      name: n ? n[1] : ev[1],
      hasKeys: bits ? (parseInt(bits[1], 16) & (1 << EV_KEY)) !== 0 : true,
    };
  });
  return map;
}

function scanDevices() {
  const info = INPUT_DIR === '/dev/input' ? readDeviceInfo() : {};
  let nodes = [];
  try { nodes = fs.readdirSync(INPUT_DIR).filter(function (f) { return /^event\d+$/.test(f); }); } catch (e) { /* none */ }
  const now = Date.now();
  nodes.forEach(function (node) {
    const meta = info[node] || { name: node, hasKeys: true };
    if (!meta.hasKeys) return;
    const existing = devices.get(node);
    if (existing && !(existing.error && now >= existing.retryAt)) return;
    openDevice(node, meta.name);
  });
  // Forget devices that disappeared.
  devices.forEach(function (dev, node) {
    if (nodes.indexOf(node) === -1) {
      if (dev.stream) dev.stream.destroy();
      devices.delete(node);
    }
  });
}

function openDevice(node, name) {
  const dev = { node: node, name: name, buf: null, scan: null, keys: [], error: null, retryAt: 0, stream: null };
  devices.set(node, dev);
  const stream = fs.createReadStream(path.join(INPUT_DIR, node), { highWaterMark: EV_SIZE * 64 });
  dev.stream = stream;
  stream.on('open', function () { log('listening on', node, '(' + name + ')'); });
  stream.on('data', function (chunk) {
    let buf = dev.buf ? Buffer.concat([dev.buf, chunk]) : chunk;
    let off = 0;
    while (buf.length - off >= EV_SIZE) {
      parseEvent(dev, buf, off);
      off += EV_SIZE;
    }
    dev.buf = off < buf.length ? buf.slice(off) : null;
  });
  stream.on('error', function (e) {
    dev.error = e.message;
    dev.retryAt = Date.now() + 30000;
    log('cannot read', node, '-', e.message);
  });
  stream.on('close', function () {
    if (!dev.error) { dev.error = 'closed'; dev.retryAt = Date.now() + 5000; }
  });
}

function parseEvent(dev, b, o) {
  const t = o + (EV_SIZE === 24 ? 16 : 8);
  const type = b.readUInt16LE(t);
  const code = b.readUInt16LE(t + 2);
  const value = b.readInt32LE(t + 4);

  if (type === EV_MSC && code === MSC_SCAN) {
    dev.scan = value >>> 0;
  } else if (type === EV_KEY) {
    dev.keys.push({ code: code, value: value });
  } else if (type === EV_SYN) {
    if (dev.keys.length) {
      dev.keys.forEach(function (k) { onSignal(dev, k.code, k.value, dev.scan); });
    } else if (dev.scan !== null) {
      // A scancode with no keycode: an IR code the TV's keymap doesn't know.
      onSignal(dev, null, null, dev.scan);
    }
    dev.keys = [];
    dev.scan = null;
  }
}

/* ------------------------------------------------------- signal handling */

const events = []; // ring buffer for the UI's live view
let eventSeq = 0;
let learner = null; // { resolve, timer }
const lastSeen = {}; // sig -> ms, used to tell repeats apart for scancode-only signals
const lastRun = {};  // sig -> ms, throttles held-button repeats

function signatureOf(code, scan) {
  return scan !== null && scan !== undefined ? 'scan:0x' + scan.toString(16) : 'key:' + code;
}

function onSignal(dev, code, value, scan) {
  const sig = signatureOf(code, scan);
  const now = Date.now();

  if (value === null) {
    // Scancode-only: no press/release info, so infer repeats from timing.
    value = now - (lastSeen[sig] || 0) < 250 ? 2 : 1;
  }
  lastSeen[sig] = now;
  if (value === 0) return; // ignore key-up

  const binding = bindings[sig];
  const ev = {
    id: ++eventSeq,
    t: now,
    device: dev.name,
    node: dev.node,
    code: code,
    keyName: code !== null ? (KEY_NAMES[code] || 'KEY_' + code) : null,
    scan: scan !== null ? '0x' + scan.toString(16) : null,
    repeat: value === 2,
    sig: sig,
    bound: binding ? binding.label : null,
  };
  events.push(ev);
  if (events.length > 200) events.shift();

  if (learner && value === 1) {
    const l = learner;
    learner = null;
    clearTimeout(l.timer);
    l.resolve({ ok: true, signal: { sig: sig, device: ev.device, code: code, keyName: ev.keyName, scan: ev.scan } });
    return;
  }
  if (learner || paused || !binding) return;
  if (value === 2) {
    if (!binding.repeat || now - (lastRun[sig] || 0) < 120) return;
  }
  lastRun[sig] = now;
  runAction(binding.action).then(function (r) {
    if (!r.ok) log('action failed for', sig, '-', r.error);
  });
}

/* ------------------------------------------------------------------ actions */

function luna(uri, params) {
  return new Promise(function (resolve) {
    execFile('luna-send', ['-n', '1', uri, JSON.stringify(params || {})], { timeout: 8000 }, function (err, stdout) {
      let res = null;
      try { res = JSON.parse(String(stdout).trim()); } catch (e) { /* not JSON */ }
      resolve(res || { returnValue: false, errorText: err ? err.message : String(stdout) });
    });
  });
}

// Try several luna calls in order; webOS versions differ in which ones exist.
async function lunaFirst(calls) {
  let last = null;
  for (const c of calls) {
    last = await luna(c[0], c[1]);
    if (last && last.returnValue !== false) return { ok: true, result: last };
  }
  return { ok: false, error: (last && (last.errorText || JSON.stringify(last))) || 'no response' };
}

// Minimal WebSocket client for the TV's "network input" socket, which accepts
// remote-control button presses (the same channel LG's phone app uses).
let pointerSock = null;

function wsConnect(url) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const secure = u.protocol === 'wss:';
    const req = (secure ? https : http).request({
      host: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      rejectUnauthorized: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      },
    });
    const timer = setTimeout(function () { req.destroy(new Error('websocket connect timeout')); }, 5000);
    req.on('upgrade', function (res, sock) {
      clearTimeout(timer);
      sock.setTimeout(0);
      sock.on('data', function () { /* server messages are not needed */ });
      sock.on('error', function () { sock.destroy(); });
      resolve(sock);
    });
    req.on('response', function (res) { clearTimeout(timer); reject(new Error('websocket upgrade refused: HTTP ' + res.statusCode)); });
    req.on('error', function (e) { clearTimeout(timer); reject(e); });
    req.end();
  });
}

function wsSendText(sock, text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  sock.write(Buffer.concat([header, mask, payload]));
}

async function getPointerSocket() {
  if (pointerSock && !pointerSock.destroyed) return pointerSock;
  const r = await luna('luna://com.webos.service.networkinput/getPointerInputSocket', {});
  if (!r || !r.socketPath) throw new Error('networkinput unavailable: ' + (r && (r.errorText || JSON.stringify(r))));
  const sock = await wsConnect(r.socketPath);
  sock.on('close', function () { if (pointerSock === sock) pointerSock = null; });
  pointerSock = sock;
  return sock;
}

async function pressButton(name) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const sock = await getPointerSocket();
      wsSendText(sock, 'type:button\nname:' + name + '\n\n');
      return { ok: true };
    } catch (e) {
      pointerSock = null;
      if (attempt === 1) return { ok: false, error: e.message };
    }
  }
  return { ok: false, error: 'unreachable' };
}

async function runAction(action) {
  if (!action || !action.type) return { ok: false, error: 'no action' };
  try {
    switch (action.type) {
      case 'button':
        return await pressButton(String(action.name));

      case 'volume': {
        if (action.dir === 'mute') return await pressButton('MUTE');
        const m = action.dir === 'down' ? 'volumeDown' : 'volumeUp';
        const r = await lunaFirst([
          ['luna://com.webos.service.audio/master/' + m, {}],
          ['luna://com.webos.audio/' + m, {}],
        ]);
        return r.ok ? r : await pressButton(action.dir === 'down' ? 'VOLUMEDOWN' : 'VOLUMEUP');
      }

      case 'power': {
        const P = 'luna://com.webos.service.tvpower/power/';
        if (action.mode === 'screenToggle') {
          const st = await luna(P + 'getPowerState', {});
          const off = st && /screen off/i.test(String(st.state || ''));
          return await lunaFirst([[P + (off ? 'turnOnScreen' : 'turnOffScreen'), {}]]);
        }
        if (action.mode === 'screenOff') return await lunaFirst([[P + 'turnOffScreen', {}]]);
        if (action.mode === 'screenOn') return await lunaFirst([[P + 'turnOnScreen', {}]]);
        const r = await lunaFirst([[P + 'turnOffTV', {}], [P + 'turnOffTV', { reason: 'remoteKey' }]]);
        return r.ok ? r : await pressButton('POWER');
      }

      case 'launch':
        return await lunaFirst([['luna://com.webos.applicationManager/launch', { id: action.id }]]);

      case 'luna':
        return await lunaFirst([[action.uri, action.params || {}]]);

      case 'shell':
        return await new Promise(function (resolve) {
          execFile('/bin/sh', ['-c', action.command], { timeout: 15000 }, function (err, stdout, stderr) {
            resolve(err ? { ok: false, error: String(stderr || err.message) } : { ok: true, output: String(stdout) });
          });
        });

      default:
        return { ok: false, error: 'unknown action type ' + action.type };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ---------------------------------------------------------------- HTTP API */

function reply(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function cancelLearn(reason) {
  if (!learner) return;
  const l = learner;
  learner = null;
  clearTimeout(l.timer);
  l.resolve({ ok: false, cancelled: reason });
}

let appsCache = null;

async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const route = req.method + ' ' + u.pathname;

  if (req.method === 'OPTIONS') return reply(res, 204, {});

  switch (route) {
    case 'GET /status':
      return reply(res, 200, {
        ok: true,
        version: VERSION,
        pid: process.pid,
        uid: process.getuid ? process.getuid() : null,
        arch: process.arch,
        node: process.version,
        paused: paused,
        learning: !!learner,
        bindingCount: Object.keys(bindings).length,
        devices: Array.from(devices.values()).map(function (d) {
          return { node: d.node, name: d.name, error: d.error };
        }),
      });

    case 'GET /events': {
      const after = parseInt(u.searchParams.get('after') || '0', 10);
      return reply(res, 200, { ok: true, last: eventSeq, events: events.filter(function (e) { return e.id > after; }) });
    }

    case 'POST /learn': {
      const body = await readBody(req);
      const timeout = Math.min(Math.max(parseInt(body.timeout, 10) || 20000, 1000), 60000);
      cancelLearn('replaced');
      const result = await new Promise(function (resolve) {
        learner = {
          resolve: resolve,
          timer: setTimeout(function () { learner = null; resolve({ ok: false, timeout: true }); }, timeout),
        };
        req.on('close', function () { if (learner && learner.resolve === resolve) cancelLearn('client gone'); });
      });
      return reply(res, 200, result);
    }

    case 'POST /learn/cancel':
      cancelLearn('cancelled');
      return reply(res, 200, { ok: true });

    case 'GET /bindings':
      return reply(res, 200, { ok: true, paused: paused, bindings: Object.values(bindings) });

    case 'POST /bindings': {
      const b = await readBody(req);
      if (!b.sig || !b.action || !b.action.type) return reply(res, 400, { ok: false, error: 'sig and action are required' });
      bindings[b.sig] = {
        sig: b.sig,
        label: String(b.label || b.action.type),
        action: b.action,
        repeat: !!b.repeat,
        signal: b.signal || null,
        created: Date.now(),
      };
      saveBindings();
      return reply(res, 200, { ok: true, binding: bindings[b.sig] });
    }

    case 'DELETE /bindings': {
      const sig = u.searchParams.get('sig');
      const existed = !!bindings[sig];
      delete bindings[sig];
      saveBindings();
      return reply(res, 200, { ok: true, deleted: existed });
    }

    case 'POST /pause': {
      const b = await readBody(req);
      paused = !!b.paused;
      saveBindings();
      return reply(res, 200, { ok: true, paused: paused });
    }

    case 'POST /run': {
      const b = await readBody(req);
      return reply(res, 200, await runAction(b.action));
    }

    case 'GET /apps': {
      if (!appsCache || u.searchParams.get('refresh')) {
        const r = await luna('luna://com.webos.applicationManager/listApps', {});
        if (!r || !Array.isArray(r.apps)) return reply(res, 200, { ok: false, error: (r && r.errorText) || 'listApps failed' });
        appsCache = r.apps
          .filter(function (a) { return a.visible !== false; })
          .map(function (a) { return { id: a.id, title: a.title || a.id }; })
          .sort(function (a, b) { return a.title.localeCompare(b.title); });
      }
      return reply(res, 200, { ok: true, apps: appsCache });
    }

    default:
      return reply(res, 404, { ok: false, error: 'not found: ' + route });
  }
}

/* -------------------------------------------------------------------- main */

loadBindings();
scanDevices();
setInterval(scanDevices, 10000);

http.createServer(function (req, res) {
  handle(req, res).catch(function (e) { reply(res, 500, { ok: false, error: e.message }); });
}).listen(PORT, '127.0.0.1', function () {
  log('IR Binder daemon', VERSION, 'on 127.0.0.1:' + PORT, '| arch', process.arch, '| event size', EV_SIZE);
});

process.on('uncaughtException', function (e) { log('uncaught:', e && e.stack || e); });
process.on('unhandledRejection', function (e) { log('unhandled rejection:', e && e.stack || e); });

// server/proxy.js
// CommonJS server: fetch-based proxy + WS sync (rooms by sid) + debug flags.

const express = require('express');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ORIGIN || `http://localhost:${PORT}`;

const app = express();

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/client', express.static(path.join(__dirname, 'client')));

function isHtml(ct = '') {
  return ct.toLowerCase().includes('text/html');
}
function log(...args) {
  console.log(new Date().toISOString(), '[proxy]', ...args);
}

// --- Proxy with debug flags --------------------------------------------------
app.get('/proxy', async (req, res) => {
  const started = Date.now();
  const targetUrl = req.query.url;
  const sid = (req.query.sid || '').toString().slice(0, 64) || 'demo';
  const raw = req.query.raw === '1' || req.query.raw === 'true';
  const noinject = req.query.noinject === '1' || req.query.noinject === 'true';
  const norewrite = req.query.norewrite === '1' || req.query.norewrite === 'true';

  if (!targetUrl) return res.status(400).send('Missing url query param');

  let u;
  try { u = new URL(targetUrl); } catch { return res.status(400).send('Invalid url'); }

  log(`→ GET ${u.toString()} sid=${sid} raw=${raw} noinject=${noinject} norewrite=${norewrite}`);

  const fwdHeaders = {
    'user-agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    'accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'pragma': 'no-cache'
  };

  let originRes;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    originRes = await fetch(u.toString(), { headers: fwdHeaders, redirect: 'follow', signal: controller.signal });
    clearTimeout(t);
  } catch (err) {
    log('✖ upstream fetch error:', err?.message || err);
    return res.status(502).send(`Upstream error: ${err.message || String(err)}`);
  }

  const hdrs = {};
  originRes.headers.forEach((v, k) => (hdrs[k.toLowerCase()] = v));

  const status = originRes.status;
  const contentType = (hdrs['content-type'] || '').toLowerCase();
  const htmlLike = isHtml(contentType);

  // RAW passthrough
  if (raw) {
    res.writeHead(status, hdrs);
    if (!originRes.body) return res.end();
    const { Readable } = require('stream');
    return Readable.fromWeb(originRes.body).pipe(res);
  }

  // Non-HTML passthrough
  if (!htmlLike) {
    delete hdrs['content-length'];
    res.writeHead(status, hdrs);
    if (!originRes.body) return res.end();
    const { Readable } = require('stream');
    return Readable.fromWeb(originRes.body).pipe(res);
  }

  // HTML path
  let body;
  try {
    body = await originRes.text();
  } catch (e) {
    log('✖ read html error:', e?.message || e);
    return res.status(502).send(`Read error: ${e.message || String(e)}`);
  }

  try {
    fs.writeFileSync('/tmp/proxy_dump.html', body);
  } catch {}

  // Remove blocking headers + enc/length (we’ll send utf-8)
  delete hdrs['content-security-policy'];
  delete hdrs['content-security-policy-report-only'];
  delete hdrs['x-frame-options'];
  delete hdrs['frame-ancestors'];
  delete hdrs['content-encoding'];
  delete hdrs['content-length'];

  // Remove meta CSP
  body = body.replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, '');

  const originBase = `${u.protocol}//${u.host}`;

  if (!norewrite) {
    body = body.replace(/(\bhref|\bsrc)=["']\/([^"']*)["']/gi,
      (_m, attr, p) => `${attr}="/proxy?sid=${encodeURIComponent(sid)}&url=${encodeURIComponent(originBase + '/' + p)}"`);

    body = body.replace(/\bsrcset=["']([^"']+)["']/gi, (_m, val) => {
      const rewritten = val.split(',').map(part => {
        const t = part.trim();
        const sp = t.indexOf(' ');
        const url = sp === -1 ? t : t.slice(0, sp);
        const desc = sp === -1 ? '' : t.slice(sp);
        if (url.startsWith('/')) return `/proxy?sid=${encodeURIComponent(sid)}&url=${encodeURIComponent(originBase + url)}${desc}`;
        return `${url}${desc}`;
      }).join(', ');
      return `srcset="${rewritten}"`;
    });
  }

  if (!noinject) {

    // inside your injection snippet in /proxy handler
    const snippet = `
    <script>
    try { if (window.top !== window.self) { window.top.__ALLOW_IFRAME__ = true; } } catch (e) {}
    window.__COBROWSE__ = {
        sessionId: ${JSON.stringify(sid)},
        origin: ${JSON.stringify(ORIGIN)}
    };
    </script>
    <script src="/client/boot.js"></script>
    `;

    if (/<\/head>/i.test(body)) body = body.replace(/<\/head>/i, `${snippet}</head>`);
    else body += snippet;
  }

  res.writeHead(status, {
    ...hdrs,
    'content-type': 'text/html; charset=utf-8'
  });
  res.end(body, 'utf8');

  log(`← ${status} (HTML) in ${Date.now() - started}ms`);
});

// --- WebSocket signaling/sync -----------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`Proxy server running at ${ORIGIN}`);
  console.log(`Health: ${ORIGIN}/healthz`);
  console.log(`Example: ${ORIGIN}/proxy?sid=demo&url=${encodeURIComponent('https://news.ycombinator.com')}`);
});

const wss = new WebSocketServer({ noServer: true });

// rooms: sid -> { clients: Map<id, ws>, controllerId: string }
const rooms = new Map();

function getRoom(sid) {
  if (!rooms.has(sid)) rooms.set(sid, { clients: new Map(), controllerId: null });
  return rooms.get(sid);
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname !== '/ws') return socket.destroy();

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, ORIGIN);
  const sid = (url.searchParams.get('sid') || 'demo').slice(0, 64);
  const id = randomUUID();

  const room = getRoom(sid);
  room.clients.set(id, ws);
  if (!room.controllerId) room.controllerId = id;

  const broadcast = (msg, exceptId = null) => {
    const data = JSON.stringify(msg);
    for (const [cid, sock] of room.clients) {
      if (cid === exceptId) continue;
      if (sock.readyState === 1) sock.send(data);
    }
  };

  // announce join + current controller
  ws.send(JSON.stringify({ type: 'hello', id, sid, controllerId: room.controllerId }));
  broadcast({ type: 'peer_joined', id }, id);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // control flow
    if (msg.type === 'request_control') {
      room.controllerId = id;
      broadcast({ type: 'controller_changed', controllerId: room.controllerId });
      ws.send(JSON.stringify({ type: 'controller_changed', controllerId: room.controllerId }));
      return;
    }

    // only controller's user events are broadcast
    if (id !== room.controllerId) return;

    // relay allowed event types
    if (['nav', 'scroll', 'click', 'input', 'focus'].includes(msg.type)) {
      broadcast({ ...msg, from: id }, id);
    }
  });

  ws.on('close', () => {
    room.clients.delete(id);
    if (room.controllerId === id) {
      // hand control to any remaining peer
      room.controllerId = room.clients.keys().next().value || null;
      broadcast({ type: 'controller_changed', controllerId: room.controllerId });
    }
    if (room.clients.size === 0) rooms.delete(sid);
  });
});

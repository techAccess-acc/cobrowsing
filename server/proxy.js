// server/proxy.js
// CommonJS server with fetch-based proxy, raw passthrough, and safe HTML handling.

const express = require('express');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ORIGIN || `http://localhost:${PORT}`;

const app = express();

// Health
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Static hosting for landing page and injected client
app.use(express.static(path.join(__dirname, 'public')));
app.use('/client', express.static(path.join(__dirname, 'client')));

function isHtml(ct = '') {
  return ct.toLowerCase().includes('text/html');
}
function log(...args) {
  console.log(new Date().toISOString(), '[proxy]', ...args);
}

app.get('/proxy', async (req, res) => {
  const started = Date.now();
  const targetUrl = req.query.url;
  const raw = req.query.raw === '1' || req.query.raw === 'true';
  const noinject = req.query.noinject === '1' || req.query.noinject === 'true';
  const norewrite = req.query.norewrite === '1' || req.query.norewrite === 'true';

  if (!targetUrl) return res.status(400).send('Missing url query param');

  let u;
  try { u = new URL(targetUrl); } catch { return res.status(400).send('Invalid url'); }

  log(`→ GET ${u.toString()} raw=${raw} noinject=${noinject} norewrite=${norewrite}`);

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

  // Clone headers we’ll forward
  const hdrs = {};
  originRes.headers.forEach((v, k) => (hdrs[k.toLowerCase()] = v));

  const status = originRes.status;
  const contentType = (hdrs['content-type'] || '').toLowerCase();
  const htmlLike = isHtml(contentType);

  // RAW passthrough: forward exactly as-is (no header/body changes)
  if (raw) {
    res.writeHead(status, hdrs);
    if (!originRes.body) {
      log(`← ${status} (raw no body) in ${Date.now() - started}ms`);
      return res.end();
    }
    const { Readable } = require('stream');
    return Readable.fromWeb(originRes.body)
      .on('error', (e) => { log('✖ raw stream error:', e?.message || e); res.destroy(e); })
      .pipe(res)
      .on('finish', () => log(`← ${status} (raw) in ${Date.now() - started}ms`));
  }

  // Non-HTML passthrough (we don’t touch)
  if (!htmlLike) {
    delete hdrs['content-length']; // length may change
    res.writeHead(status, hdrs);
    if (!originRes.body) {
      log(`← ${status} (non-HTML no body) in ${Date.now() - started}ms`);
      return res.end();
    }
    const { Readable } = require('stream');
    return Readable.fromWeb(originRes.body)
      .on('error', (e) => { log('✖ passthrough stream error:', e?.message || e); res.destroy(e); })
      .pipe(res)
      .on('finish', () => log(`← ${status} (non-HTML) in ${Date.now() - started}ms`));
  }

  // HTML: fetch auto-decompresses; we must remove content-encoding when we send text.
  let body;
  try {
    body = await originRes.text(); // already decompressed
  } catch (e) {
    log('✖ read html error:', e?.message || e);
    return res.status(502).send(`Read error: ${e.message || String(e)}`);
  }

  // Debug
  try {
    log(`fetched HTML length=${body.length}`);
    log('preview:', body.slice(0, 300).replace(/\s+/g, ' ').slice(0, 300));
    fs.writeFileSync('/tmp/proxy_dump.html', body);
    log('wrote /tmp/proxy_dump.html');
  } catch (_) {}

  // Remove headers that block iframing, and remove content-encoding/length
  delete hdrs['content-security-policy'];
  delete hdrs['content-security-policy-report-only'];
  delete hdrs['x-frame-options'];
  delete hdrs['frame-ancestors'];
  delete hdrs['content-encoding']; // critical: avoid ERR_CONTENT_DECODING_FAILED
  delete hdrs['content-length'];   // body length changed

  // Remove meta CSP
  body = body.replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, '');

  const originBase = `${u.protocol}//${u.host}`;

  if (!norewrite) {
    // Minimal absolute-path rewriting so navigation stays in proxy
    body = body.replace(/(\bhref|\bsrc)=["']\/([^"']*)["']/gi,
      (_m, attr, p) => `${attr}="/proxy?url=${encodeURIComponent(originBase + '/' + p)}"`);

    body = body.replace(/\bsrcset=["']([^"']+)["']/gi, (_m, val) => {
      const rewritten = val.split(',').map(part => {
        const t = part.trim();
        const sp = t.indexOf(' ');
        const url = sp === -1 ? t : t.slice(0, sp);
        const desc = sp === -1 ? '' : t.slice(sp);
        if (url.startsWith('/')) return `/proxy?url=${encodeURIComponent(originBase + url)}${desc}`;
        return `${url}${desc}`;
      }).join(', ');
      return `srcset="${rewritten}"`;
    });
  }

  if (!noinject) {
    const snippet = `
      <script>
        // Light frame-bust neutralizer
        try { if (window.top !== window.self) { window.top.__ALLOW_IFRAME__ = true; } } catch (e) {}
        window.__COBROWSE__ = { sessionId: 'anon', origin: ${JSON.stringify(ORIGIN)} };
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

app.listen(PORT, () => {
  console.log(`Proxy server running at ${ORIGIN}`);
  console.log(`Health: ${ORIGIN}/healthz`);
  console.log(`Example: ${ORIGIN}/proxy?url=${encodeURIComponent('https://example.com')}`);
});

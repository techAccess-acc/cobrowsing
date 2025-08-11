// server/client/boot.js
(function () {
    const meta = window.__COBROWSE__ || {};
    const sid = meta.sessionId || 'demo';
  
    // ✅ Build WS URL from the page you’re viewing
    const wsUrl = `${location.origin.replace(/^http/, 'ws')}/ws?sid=${encodeURIComponent(sid)}`;
  
    // Small status badge
    const ui = document.createElement('div');
    ui.style.position = 'fixed';
    ui.style.bottom = '8px';
    ui.style.right = '8px';
    ui.style.padding = '6px 10px';
    ui.style.background = 'rgba(0,0,0,0.6)';
    ui.style.color = '#fff';
    ui.style.font = '12px/1.35 system-ui, sans-serif';
    ui.style.borderRadius = '4px';
    ui.style.zIndex = 2147483647;
    ui.textContent = 'Co-browse: connecting…';
    document.documentElement.appendChild(ui);
  
    const state = { id: null, controllerId: null, isController() { return this.id && this.controllerId === this.id; } };
  
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => { ui.textContent = 'Co-browse: connected'; });
    ws.addEventListener('close', () => { ui.textContent = 'Co-browse: disconnected'; });
  
    function setController(cid) {
      state.controllerId = cid || null;
      ui.textContent = state.isController()
        ? 'You have control (Ctrl+Shift+R to pass to yourself on joiner)'
        : 'View-only (press Ctrl+Shift+R to request control)';
    }
  
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello') { state.id = msg.id; setController(msg.controllerId); return; }
      if (msg.type === 'controller_changed') { setController(msg.controllerId); return; }
  
      if (msg.type === 'scroll') { window.scrollTo(msg.x, msg.y); }
      if (msg.type === 'click') {
        const el = document.elementFromPoint(msg.clientX, msg.clientY);
        if (el && typeof el.click === 'function') el.click();
      }
      if (msg.type === 'focus') { const el = queryByPath(msg.path); if (el) el.focus(); }
      if (msg.type === 'input') {
        const el = queryByPath(msg.path);
        if (el && 'value' in el) {
          el.value = msg.valueMasked ? '' : msg.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      if (msg.type === 'nav' && typeof msg.url === 'string') {
        const u = new URL(msg.url, location.href);
        const next = `/proxy?sid=${encodeURIComponent(sid)}&url=${encodeURIComponent(u.href)}`;
        if (location.href !== next) location.href = next;
      }
    });
  
    function getPath(el) {
      const p = []; let n = el;
      while (n && n !== document.documentElement) {
        const parent = n.parentElement; if (!parent) break;
        p.push(Array.prototype.indexOf.call(parent.children, n)); n = parent;
      }
      return p.reverse();
    }
    function queryByPath(path) {
      let n = document.documentElement;
      for (const idx of path) { n = n.children[idx]; if (!n) return null; }
      return n || null;
    }
  
    function isMasked(el) {
      if (!el) return false;
      if (el.matches && (el.matches('input[type="password"]') || el.matches('[data-mask]'))) return true;
      const name = (el.getAttribute && (el.getAttribute('name') || el.getAttribute('id') || '') || '').toLowerCase();
      return /pass|otp|card|cvv|pin/.test(name);
    }
  
    window.addEventListener('scroll', () => {
      if (!state.isController()) return;
      wsSend({ type: 'scroll', x: window.scrollX, y: window.scrollY });
    }, { passive: true });
  
    document.addEventListener('click', (e) => {
      if (!state.isController()) return;
      wsSend({ type: 'click', clientX: e.clientX, clientY: e.clientY });
    });
  
    document.addEventListener('focusin', (e) => {
      if (!state.isController()) return;
      wsSend({ type: 'focus', path: getPath(e.target) });
    });
  
    document.addEventListener('input', (e) => {
      if (!state.isController()) return;
      const t = e.target; if (!t || !('value' in t)) return;
      wsSend({ type: 'input', path: getPath(t), value: String(t.value), valueMasked: isMasked(t) });
    });
  
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) wsSend({ type: 'request_control' });
    });
  
    function wsSend(obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} }
  })();
  
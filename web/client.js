// Injected into every HTML page via proxy rewrite.
(function(){
    const cfg = window.__COBROWSE__ || {};
    const sessionId = cfg.sessionId || 'anon';
    const origin = cfg.origin || location.origin;
    const ws = new WebSocket((origin.replace('http','ws')) + '/ws');
    let role = 'owner'; // naive: first to open is owner; improve via URL param later
    let canControl = true;
  
    function send(type, payload) {
      ws.readyState === 1 && ws.send(JSON.stringify({ type, payload, role, sessionId }));
    }
  
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', sessionId, role }));
    });
  
    // Control bar UI
    const bar = document.createElement('div');
    bar.id = 'cobar';
    bar.innerHTML = `
      <span class="status">Session: ${sessionId}</span>
      <button id="giveCtl">${canControl ? 'Revoke Control' : 'Give Control'}</button>
      <button id="pointer">Pointer</button>
    `;
    document.documentElement.appendChild(bar);
  
    bar.querySelector('#giveCtl').onclick = () => {
      canControl = !canControl;
      send('control', { action: canControl ? 'owner' : 'view' });
      bar.querySelector('#giveCtl').textContent = canControl ? 'Revoke Control' : 'Give Control';
    };
  
    // Simple event capture
    function nodeInfo(el){
      const info = { tag: el.tagName, name: el.getAttribute('name'), type: el.getAttribute('type'), selectors: [] };
      if (el.hasAttribute('data-mask')) info.selectors.push('data-mask');
      return info;
    }
  
    function capture(e){
      if (!canControl) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      const path = getXPath(t);
      const payload = { events: [{ type: e.type, path, value: t.value, node: nodeInfo(t) }] };
      send('batch', payload);
    }
  
    ['click','input','change','scroll'].forEach(ev=>document.addEventListener(ev, capture, true));
  
    // Mutation observer for typing/DOM changes
    const mo = new MutationObserver(list => {
      if (!canControl) return;
      const mutations = [];
      for (const m of list){
        if (m.type === 'characterData') {
          mutations.push({ type:'text', path:getXPath(m.target.parentElement||m.target), text:m.target.data, node: nodeInfo(m.target.parentElement||m.target) });
        } else if (m.type === 'attributes' && m.attributeName === 'value') {
          const el = m.target;
          mutations.push({ type:'setValue', path:getXPath(el), value: el.value, node: nodeInfo(el) });
        }
      }
      if (mutations.length) send('batch', { mutations });
    });
  
    mo.observe(document.documentElement, { subtree:true, characterData:true, attributes:true, attributeFilter:['value'] });
  
    // Apply incoming batches
    function applyBatch(batch){
      if (!batch) return;
      if (batch.events){
        for (const e of batch.events){
          const el = getByXPath(e.path);
          if (!el) continue;
          if (e.type === 'input' || e.type === 'change') {
            el.value = e.value;
            el.dispatchEvent(new Event('input',{bubbles:true}));
          } else if (e.type === 'click') {
            el.click();
          }
        }
      }
      if (batch.mutations){
        for (const m of batch.mutations){
          const el = getByXPath(m.path);
          if (!el) continue;
          if (m.type === 'text') {
            if (el.firstChild && el.firstChild.nodeType === Node.TEXT_NODE) el.firstChild.data = m.text;
          }
          if (m.type === 'setValue') {
            el.value = m.value;
          }
        }
      }
    }
  
    ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'batch') {
        applyBatch(msg.payload);
      }
      if (msg.type === 'control') {
        canControl = msg.action === 'owner';
        bar.querySelector('#giveCtl').textContent = canControl ? 'Revoke Control' : 'Give Control';
      }
    });
  
    // Basic XPath helpers
    function getXPath(el){
      if (el === document.body) return '/HTML/BODY';
      const ix = Array.from(el.parentNode.children).filter(sib => sib.tagName === el.tagName).indexOf(el)+1;
      return getXPath(el.parentNode) + '/' + el.tagName + '[' + ix + ']';
    }
    function getByXPath(path){
      try { return document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch { return null; }
    }
  })();
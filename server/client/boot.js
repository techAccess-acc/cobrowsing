// server/client/boot.js
(function () {
    try {
      const meta = window.__COBROWSE__ || {};
      // Visually confirm injection by adding a small corner badge.
      const banner = document.createElement('div');
      banner.textContent = 'Co-browse injection active';
      banner.style.position = 'fixed';
      banner.style.bottom = '8px';
      banner.style.right = '8px';
      banner.style.padding = '6px 10px';
      banner.style.background = 'rgba(0,0,0,0.6)';
      banner.style.color = '#fff';
      banner.style.font = '12px/1.2 system-ui, sans-serif';
      banner.style.zIndex = 2147483647;
      banner.style.borderRadius = '4px';
      banner.title = `session: ${meta.sessionId || 'anon'} | origin: ${meta.origin || ''}`;
      document.documentElement.appendChild(banner);
  
      // Placeholders for your upcoming sync code:
      // - attach MutationObserver
      // - capture input events
      // - send/receive over WebSocket to your collab service
      console.debug('[cobrowse] injected', meta);
    } catch (e) {
      console.error('[cobrowse] boot error', e);
    }
  })();
  
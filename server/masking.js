// Simple masking: redact inputs and elements matching selectors before broadcasting.
const DEFAULT_SELECTORS = [
    'input[type=password]',
    'input[name*="password"]',
    'input[name*="card"]',
    '[data-mask]',
  ];
  
  export function shouldMask(node) {
    // node example: { tag:"INPUT", name:"cardNumber", type:"text", selectors:["#card",".input"] }
    const tag = (node.tag || '').toLowerCase();
    if (tag === 'input' && /password/i.test(node.type)) return true;
    if (/password|card/i.test(node.name || '')) return true;
    if ((node.selectors || []).some(sel => sel.includes('data-mask'))) return true;
    return false;
  }
  
  export function applyMask(payload) {
    // payload is a mutation/event batch; replace sensitive values with bullets.
    const clone = JSON.parse(JSON.stringify(payload));
    if (clone.mutations) {
      for (const m of clone.mutations) {
        if (m.type === 'setValue' && shouldMask(m.node)) {
          m.value = '••••••';
        }
        if (m.type === 'text' && shouldMask(m.node)) {
          m.text = '••••••';
        }
      }
    }
    if (clone.events) {
      for (const e of clone.events) {
        if (e.type === 'input' && shouldMask(e.node)) {
          e.value = '••••••';
        }
      }
    }
    return clone;
  }
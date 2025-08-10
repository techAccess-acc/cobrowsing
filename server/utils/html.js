export function injectClient(html, { sessionId, origin }) {
    // Minimal, robust injection right before </head>. If not found, prepend.
    const snippet = `\n<script>window.__COBROWSE__={sessionId: "${sessionId}", origin: "${origin}"};</script>\n<script src="${origin}/client.js" defer></script>\n<link rel="stylesheet" href="${origin}/styles.css"/>\n`;
    if (!html) return html;
    const idx = html.indexOf("</head>");
    if (idx !== -1) {
      return html.slice(0, idx) + snippet + html.slice(idx);
    }
    return snippet + html;
  }
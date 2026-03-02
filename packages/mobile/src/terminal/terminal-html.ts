/**
 * Standalone xterm.js terminal page, loaded into WebView.
 * WS URL and session ID are injected via injectedJavaScriptBeforeContentLoaded
 * which sets window.AO_WS_URL and window.AO_SESSION_ID before the script runs.
 */
export const TERMINAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>Terminal</title>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"><\/script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css" />
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; background: #0d1117; overflow: hidden; }
  #terminal { width: 100%; height: 100%; }
  #status {
    position: fixed;
    top: 6px;
    right: 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #8b949e;
    z-index: 10;
    transition: background 0.3s;
  }
  #status.connecting { background: #e3b341; }
  #status.connected  { background: #3fb950; }
  #status.error      { background: #f85149; }
<\/style>
</head>
<body>
<div id="status" class="connecting"></div>
<div id="terminal"></div>
<script>
(function () {
  var WS_BASE  = window.AO_WS_URL    || 'ws://localhost:3003';
  var SESSION  = window.AO_SESSION_ID || '';

  var statusEl = document.getElementById('status');
  var term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#0d1117',
      foreground: '#e6edf3',
      cursor: '#e6edf3',
      black:   '#0d1117',
      red:     '#f85149',
      green:   '#3fb950',
      yellow:  '#e3b341',
      blue:    '#58a6ff',
      magenta: '#bc8cff',
      cyan:    '#39c5cf',
      white:   '#b1bac4',
      brightBlack:   '#6e7681',
      brightRed:     '#ff7b72',
      brightGreen:   '#56d364',
      brightYellow:  '#e3b341',
      brightBlue:    '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan:    '#56d4dd',
      brightWhite:   '#f0f6fc',
    },
    allowProposedApi: true,
  });

  var fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));
  fitAddon.fit();

  function postToRN(obj) {
    try {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(obj));
      }
    } catch (e) { /* ignore */ }
  }

  function sendResize() {
    fitAddon.fit();
    var cols = term.cols;
    var rows = term.rows;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: cols, rows: rows }));
    }
    postToRN({ type: 'resize', cols: cols, rows: rows });
  }

  window.addEventListener('resize', sendResize);

  var ws;
  var reconnectDelay = 1000;

  function connect() {
    var url = WS_BASE + '/ws?session=' + encodeURIComponent(SESSION);
    statusEl.className = 'connecting';
    postToRN({ type: 'status', state: 'connecting' });

    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function () {
      statusEl.className = 'connected';
      postToRN({ type: 'status', state: 'connected' });
      reconnectDelay = 1000;
      sendResize();
    };

    ws.onmessage = function (evt) {
      if (typeof evt.data === 'string') {
        term.write(evt.data);
      } else {
        term.write(new Uint8Array(evt.data));
      }
    };

    ws.onerror = function () {
      statusEl.className = 'error';
      postToRN({ type: 'status', state: 'error' });
    };

    ws.onclose = function () {
      statusEl.className = 'error';
      postToRN({ type: 'status', state: 'disconnected' });
      setTimeout(function () {
        reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
        connect();
      }, reconnectDelay);
    };
  }

  term.onData(function (data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // XDA handler: respond to CSI > q with XTerm identity (enables tmux clipboard)
  term.onData(function (data) {
    if (data === '\\x1b[>q') {
      term.write('\\x1bP>|XTerm(370)\\x1b\\\\');
    }
  });

  document.addEventListener('message', function (evt) { handleRNMessage(evt.data); });
  window.addEventListener('message', function (evt) { handleRNMessage(evt.data); });

  function handleRNMessage(raw) {
    try {
      var msg = JSON.parse(raw);
      if (msg.type === 'fit') sendResize();
      else if (msg.type === 'focus') term.focus();
    } catch (e) { /* ignore */ }
  }

  if (SESSION) {
    connect();
  } else {
    term.write('\\x1b[31mError: No session ID provided.\\x1b[0m\\r\\n');
    statusEl.className = 'error';
  }
})();
<\/script>
</body>
</html>`;

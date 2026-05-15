import * as vscode from 'vscode';
import { exec } from 'child_process';
import { runAgent, AgentEvent } from '../cli';
import { getNonce } from '../utils/nonce';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    _context: vscode.ExtensionContext,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(this._handleMessage.bind(this));
  }

  private _getCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  }

  private async _handleMessage(message: {
    command: string;
    prompt?: string;
    cmd?: string;
    url?: string;
    subdir?: string;
    files?: Array<{ path: string; content: string }>;
  }): Promise<void> {

    // ── Run agent task ────────────────────────────────────────────────────────
    if (message.command === 'chat' && message.prompt) {
      const cwd = this._getCwd();
      if (!cwd) {
        this._send('chatError', { msg: 'No folder open. Open a project folder first.' });
        return;
      }

      try {
        const result = await runAgent(
          message.prompt,
          cwd,
          (evt: AgentEvent) => this._send('agentEvent', evt),
        );
        this._send('chatDone', { success: result.success, summary: result.summary, files: result.files });

        if (result.files.length > 0) {
          // CLI already wrote the files — just refresh the explorer
          vscode.commands.executeCommand('workbench.view.explorer');
          vscode.window.setStatusBarMessage(`OgaCode: ${result.files.length} file(s) written`, 4000);
        }
      } catch (err) {
        this._send('chatError', { msg: err instanceof Error ? err.message : 'Unknown error' });
      }
      return;
    }

    // ── Dev server ────────────────────────────────────────────────────────────
    if (message.command === 'runDevServer') {
      const folder = this._getCwd();
      if (!folder) { this._send('devServerError', { error: 'No workspace open' }); return; }
      const path = require('path') as typeof import('path');
      const frontendPath = path.join(folder, 'frontend');
      const terminal = vscode.window.createTerminal({ name: 'OgaCode Dev' });
      terminal.show();
      terminal.sendText(`Set-Location "${frontendPath}"; npm install; npm run dev`);
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        const http = require('http') as typeof import('http');
        const req = http.get('http://localhost:3000', () => {
          clearInterval(poll);
          this._send('devServerReady', {});
          vscode.commands.executeCommand('simpleBrowser.show', 'http://localhost:3000');
        });
        req.on('error', () => { /* not ready yet */ });
        req.end();
        if (attempts > 90) {
          clearInterval(poll);
          this._send('devServerError', { error: 'Timed out waiting for server' });
        }
      }, 1000);
      return;
    }

    // ── Terminal / shell commands ─────────────────────────────────────────────
    if (message.command === 'openTerminal' && message.cmd) {
      const terminal = vscode.window.createTerminal({ name: 'OgaCode' });
      terminal.show();
      terminal.sendText(message.cmd);
      return;
    }

    if (message.command === 'runCmd' && message.cmd) {
      const folder = this._getCwd();
      if (!folder) { this._send('cmdResult', { success: false, output: 'No workspace open.' }); return; }
      const path = require('path') as typeof import('path');
      const cwd = message.subdir ? path.join(folder, message.subdir) : folder;
      exec(message.cmd, { cwd, timeout: 120_000 }, (_err, stdout, stderr) => {
        const output = ((stdout ?? '') + (stderr ?? '')).trim();
        this._send('cmdResult', { success: !_err, output: output.slice(0, 4000) });
      });
      return;
    }

    // ── File utilities ────────────────────────────────────────────────────────
    if (message.command === 'listFiles') {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!folder) { this._send('fileList', { files: [] }); return; }
      try {
        const uris = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,py,html,css,json,md}', '**/node_modules/**', 60);
        this._send('fileList', { files: uris.map(u => vscode.workspace.asRelativePath(u)) });
      } catch {
        this._send('fileList', { files: [] });
      }
      return;
    }

    if (message.command === 'pickFile') {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        openLabel: 'Attach', title: 'Attach a file to your prompt',
      });
      if (!picked?.[0]) { return; }
      try {
        const raw = await vscode.workspace.fs.readFile(picked[0]);
        const content = Buffer.from(raw).toString('utf8').slice(0, 8000);
        const name = picked[0].path.split('/').pop() ?? 'file';
        this._send('filePicked', { file: { name, content } });
      } catch {
        this._send('filePicked', { file: null });
      }
      return;
    }

    if (message.command === 'openBrowser' && message.url) {
      vscode.env.openExternal(vscode.Uri.parse(message.url));
      return;
    }
  }

  private _send(command: string, data: Record<string, unknown>): void {
    this._view?.webview.postMessage({ command, ...data });
  }

  private _getHtml(_webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>OgaCode</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body { margin: 0; padding: 8px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    textarea { width: 100%; display: block; margin-bottom: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); padding: 6px; font: inherit; resize: vertical; }
    button { margin-right: 4px; padding: 6px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; font: inherit; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    #status { min-height: 20px; margin-bottom: 6px; font-weight: bold; }
    #log { font-size: 11px; opacity: 0.65; margin-bottom: 8px; max-height: 180px; overflow-y: auto; }
    #log div { margin: 1px 0; white-space: pre-wrap; word-break: break-all; }
    #files { margin-top: 6px; }
    .chip { display: inline-block; margin: 2px 4px 2px 0; padding: 2px 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; font-family: monospace; border-radius: 3px; }
    .ok  { color: #6f6; }
    .err { color: #f88; }
    #runbtn { display: none; margin-top: 4px; }
  </style>
</head>
<body>
  <div id="status" class="ok">OgaCode ready</div>
  <div id="log"></div>
  <textarea id="inp" rows="3" placeholder="What do you want to build?"></textarea>
  <button type="button" id="btn">Send</button>
  <div id="files"></div>
  <button type="button" id="runbtn">Run Dev Server</button>

  <script nonce="${nonce}">
    var api    = acquireVsCodeApi();
    var status = document.getElementById('status');
    var log    = document.getElementById('log');
    var inp    = document.getElementById('inp');
    var btn    = document.getElementById('btn');
    var fbox   = document.getElementById('files');
    var runbtn = document.getElementById('runbtn');

    function addLog(text, color) {
      var d = document.createElement('div');
      if (color) { d.style.color = color; }
      d.textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    }

    function formatEvent(ev) {
      if (ev.type === 'thinking')    { return '> Thinking... (step ' + ev.step + ')'; }
      if (ev.type === 'provider')    { return '  Using ' + ev.name; }
      if (ev.type === 'pre_tool_use') {
        var args = ev.args || {};
        var parts = Object.keys(args).map(function(k) {
          var v = String(args[k]);
          return k + '=' + (v.length > 40 ? v.slice(0, 40) + '...' : v);
        });
        return '> ' + ev.tool + '(' + parts.join(', ') + ')';
      }
      if (ev.type === 'post_tool_use' && !ev.success) { return '! ' + ev.error; }
      if (ev.type === 'correction')  { return '~ ' + ev.msg; }
      if (ev.type === 'supervisor')  { return 'o ' + ev.msg; }
      if (ev.type === 'escalate')    { return '? ' + ev.msg; }
      return '';
    }

    btn.addEventListener('click', function() {
      var text = inp.value.trim();
      if (!text) { return; }
      inp.value = '';
      btn.disabled = true;
      btn.textContent = 'Running...';
      fbox.innerHTML = '';
      log.innerHTML = '';
      runbtn.style.display = 'none';
      status.className = '';
      status.textContent = 'You: ' + text;
      api.postMessage({ command: 'chat', prompt: text });
    });

    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); btn.click(); }
    });

    window.addEventListener('message', function(e) {
      var d = e.data;

      if (d.command === 'agentEvent') {
        var line = formatEvent(d);
        if (line) { addLog(line); }
        return;
      }

      if (d.command === 'chatDone') {
        btn.disabled = false;
        btn.textContent = 'Send';
        if (d.success) {
          status.className = 'ok';
          status.textContent = 'Done: ' + d.summary;
        } else {
          status.className = 'err';
          status.textContent = 'Warning: ' + d.summary;
        }
        if (d.files && d.files.length) {
          d.files.forEach(function(f) {
            var c = document.createElement('span');
            c.className = 'chip';
            c.textContent = f;
            fbox.appendChild(c);
          });
          runbtn.style.display = 'inline-block';
        }
        return;
      }

      if (d.command === 'chatError') {
        btn.disabled = false;
        btn.textContent = 'Send';
        status.className = 'err';
        status.textContent = 'Error: ' + d.msg;
        return;
      }

      if (d.command === 'devServerReady') {
        runbtn.disabled = false;
        runbtn.textContent = 'Run Dev Server';
        addLog('Server running at localhost:3000 — preview opened', '#6f6');
        return;
      }

      if (d.command === 'devServerError') {
        runbtn.disabled = false;
        runbtn.textContent = 'Run Dev Server';
        addLog('Server error: ' + d.error, '#f88');
        return;
      }
    });

    runbtn.addEventListener('click', function() {
      runbtn.disabled = true;
      runbtn.textContent = 'Starting...';
      api.postMessage({ command: 'runDevServer' });
    });
  </script>
</body>
</html>`;
  }
}

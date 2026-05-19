import * as vscode from 'vscode';
import { exec } from 'child_process';
import { runAgent, AgentEvent } from '../cli';
import { getNonce } from '../utils/nonce';
import { PreviewPanel } from '../preview/PreviewPanel';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

interface Memory {
  prd: string;
  rules: string;
  skills: string;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _lastPreviewFile: string | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _ctx: vscode.ExtensionContext,
  ) {}

  private _sessionKey(): string {
    const cwd = this._getCwd();
    return cwd ? `ogacode.session.${cwd}` : 'ogacode.session.__global';
  }

  private _getHistory(): Turn[] {
    return this._ctx.globalState.get<Turn[]>(this._sessionKey()) ?? [];
  }

  private async _setHistory(turns: Turn[]): Promise<void> {
    await this._ctx.globalState.update(this._sessionKey(), turns.slice(-20));
  }

  private async _clearHistory(): Promise<void> {
    await this._ctx.globalState.update(this._sessionKey(), []);
  }

  private _memoryKey(): string {
    const cwd = this._getCwd();
    return cwd ? `ogacode.memory.${cwd}` : 'ogacode.memory.__global';
  }

  private _getMemory(): Memory {
    return this._ctx.globalState.get<Memory>(this._memoryKey()) ?? { prd: '', rules: '', skills: '' };
  }

  private async _saveMemory(mem: Memory): Promise<void> {
    await this._ctx.globalState.update(this._memoryKey(), mem);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(this._handleMessage.bind(this));
    // Send project name once the webview is ready
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      setTimeout(() => this._send('setProject', { name: folder.name }), 200);
    }
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
    slot?: string;
    prd?: string;
    rules?: string;
    skills?: string;
  }): Promise<void> {

    // ── Run agent task ────────────────────────────────────────────────────────
    if (message.command === 'chat' && message.prompt) {
      const cwd = this._getCwd();
      if (!cwd) {
        this._send('chatError', { msg: 'No folder open. Open a project folder first.' });
        return;
      }

      const history = this._getHistory();
      const enriched = this._enrichPrompt(message.prompt, cwd, history);
      const userTurn: Turn = { role: 'user', content: message.prompt };
      await this._setHistory([...history, userTurn]);

      try {
        const result = await runAgent(
          enriched,
          cwd,
          (evt: AgentEvent) => this._send('agentEvent', evt),
        );
        const summary = result.summary || (result.success ? 'Done.' : 'Task finished with no summary.');
        const assistantTurn: Turn = {
          role: 'assistant',
          content: result.files.length
            ? `${summary}\nFiles touched: ${result.files.join(', ')}`
            : summary,
        };
        await this._setHistory([...this._getHistory(), assistantTurn]);
        this._send('chatDone', { success: result.success, summary, files: result.files });

        if (result.files.length > 0) {
          vscode.commands.executeCommand('workbench.view.explorer');
          vscode.window.setStatusBarMessage(`OgaCode: ${result.files.length} file(s) written`, 4000);

          const folder = this._getCwd();
          const hasPackageJson = result.files.some(f => f.endsWith('package.json'));

          // Show Expo button when agent builds a React Native / Expo project
          const hasAppJson = result.files.some(f => f.endsWith('app.json') || f.endsWith('app.config.js'))
            || (folder ? (await vscode.workspace.findFiles('app.json', '**/node_modules/**', 1)).length > 0 : false);
          if (hasAppJson) { this._send('showExpobtn', {}); }

          if (!hasPackageJson && folder) {
            const path = require('path') as typeof import('path');
            const fs = require('fs') as typeof import('fs');

            // Find an HTML file: prefer files_written, fall back to workspace search
            let htmlFile = result.files.find(f => f.endsWith('index.html') || f.endsWith('.html'));

            // Resolve relative paths and verify the file actually exists
            if (htmlFile) {
              const abs = path.isAbsolute(htmlFile) ? htmlFile : path.join(folder, htmlFile);
              if (!fs.existsSync(abs)) { htmlFile = undefined; }
            }

            // Fallback: search workspace for any index.html
            if (!htmlFile) {
              const uris = await vscode.workspace.findFiles('**/index.html', '**/node_modules/**', 5);
              if (uris.length) {
                htmlFile = path.relative(folder, uris[0].fsPath);
              }
            }

            if (htmlFile) {
              this._lastPreviewFile = htmlFile;
              PreviewPanel.show(folder, htmlFile);
              this._send('staticReady', { file: htmlFile });
            } else if (this._lastPreviewFile) {
              PreviewPanel.show(folder, this._lastPreviewFile);
            }
          }
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

    // ── Expo / React Native ───────────────────────────────────────────────────
    if (message.command === 'runExpo') {
      const folder = this._getCwd();
      if (!folder) { this._send('expoError', { error: 'No workspace open' }); return; }
      const terminal = vscode.window.createTerminal({ name: 'OgaCode Expo' });
      terminal.show();
      terminal.sendText(`Set-Location "${folder}"; npx expo start`);
      let expoAttempts = 0;
      const expoPoll = setInterval(() => {
        expoAttempts++;
        const http = require('http') as typeof import('http');
        const req = http.get('http://localhost:8081', (res) => {
          if (res.statusCode && res.statusCode < 500) {
            clearInterval(expoPoll);
            const os = require('os') as typeof import('os');
            const nets = os.networkInterfaces();
            let lanIp = '127.0.0.1';
            outer: for (const iface of Object.values(nets)) {
              for (const addr of (iface ?? [])) {
                if (addr.family === 'IPv4' && !addr.internal) { lanIp = addr.address; break outer; }
              }
            }
            this._send('expoReady', { url: `exp://${lanIp}:8081` });
          }
          res.resume();
        });
        req.on('error', () => {});
        req.end();
        if (expoAttempts > 90) {
          clearInterval(expoPoll);
          this._send('expoError', { error: 'Timed out waiting for Expo' });
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

    if (message.command === 'newChat') {
      await this._clearHistory();
      this._send('chatCleared', {});
      return;
    }

    if (message.command === 'openBrowser' && message.url) {
      vscode.env.openExternal(vscode.Uri.parse(message.url));
      return;
    }

    if (message.command === 'preview') {
      const folder = this._getCwd();
      if (!folder) { return; }
      // Find any HTML file in the workspace to preview
      const uris = await vscode.workspace.findFiles('**/*.html', '**/node_modules/**', 10);
      if (!uris.length) {
        this._send('chatError', { msg: 'No HTML files found in this project.' });
        return;
      }
      const path = require('path') as typeof import('path');
      const htmlFile = path.relative(folder, uris[0].fsPath);
      PreviewPanel.show(folder, htmlFile);
      return;
    }

    if (message.command === 'loadMemory') {
      const mem = this._getMemory();
      this._send('memoryLoaded', { prd: mem.prd, rules: mem.rules, skills: mem.skills });
      return;
    }

    if (message.command === 'saveMemory') {
      await this._saveMemory({
        prd: message.prd ?? '',
        rules: message.rules ?? '',
        skills: message.skills ?? '',
      });
      this._send('memorySaved', {});
      return;
    }

    if (message.command === 'pickMemoryFile') {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        openLabel: 'Load', title: 'Load file into memory slot',
        filters: { 'Text files': ['md', 'txt', 'json', 'yaml', 'toml', 'ts', 'js', 'py'] },
      });
      if (!picked?.[0]) { return; }
      try {
        const raw = await vscode.workspace.fs.readFile(picked[0]);
        const content = Buffer.from(raw).toString('utf8').slice(0, 8000);
        this._send('memoryFilePicked', { slot: message.slot, content });
      } catch {
        // silently ignore read errors
      }
      return;
    }
  }

  private _enrichPrompt(prompt: string, cwd: string, history: Turn[] = []): string {
    const NIGERIAN_CONTEXT =
      '[NIGERIAN DEVELOPER CONTEXT]\n' +
      'You are assisting a Nigerian developer. Always recommend free or low-cost tools first:\n' +
      '- Database/Backend: Supabase (supabase.com) is FREE for small projects — 500MB database,\n' +
      '  50,000 monthly active users, authentication, file storage, and edge functions included.\n' +
      '  No credit card required. When a user asks about forms, user accounts, data storage, or a\n' +
      '  backend API, recommend Supabase first and tell them it is free.\n' +
      '- Static hosting: Netlify or Vercel (both free, no credit card for basic use).\n' +
      '- Backend hosting: Railway free tier or Render free tier.\n' +
      '- Never recommend a paid service as the primary option without explaining the free alternative.\n' +
      '- When mentioning Supabase, always add: "Supabase is free — you will not be charged."';

    const mem = this._getMemory();
    const parts: string[] = [NIGERIAN_CONTEXT];
    if (mem.prd)    { parts.push(`[PROJECT PRD]\n${mem.prd}`); }
    if (mem.rules)  { parts.push(`[PROJECT RULES]\n${mem.rules}`); }
    if (mem.skills) { parts.push(`[PROJECT SKILLS]\n${mem.skills}`); }

    // Inject recent conversation history so the agent has follow-up context
    const recentTurns = history.slice(-8); // last 4 exchanges
    if (recentTurns.length > 0) {
      const historyText = recentTurns
        .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
        .join('\n');
      parts.push(`[CONVERSATION HISTORY]\n${historyText}`);
    }

    let enriched = parts.length
      ? `=== PROJECT MEMORY ===\n${parts.join('\n\n')}\n=== END ===\n\n${prompt}`
      : prompt;

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') { return enriched; }

    const doc = editor.document;
    const path = require('path') as typeof import('path');
    const relPath = path.relative(cwd, doc.uri.fsPath);
    const content = doc.getText().slice(0, 6000);

    const diagnostics = vscode.languages.getDiagnostics(doc.uri)
      .filter(d => d.severity === vscode.DiagnosticSeverity.Error)
      .slice(0, 15)
      .map(d => `  Line ${d.range.start.line + 1}: ${d.message}`)
      .join('\n');

    const selected = editor.selection.isEmpty
      ? ''
      : doc.getText(editor.selection);

    let context = `\n\n---\nActive file: ${relPath}\n\`\`\`\n${content}\n\`\`\``;
    if (diagnostics) { context += `\n\nErrors in this file:\n${diagnostics}`; }
    if (selected)    { context += `\n\nSelected code:\n\`\`\`\n${selected}\n\`\`\``; }

    return enriched + context;
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src https://api.qrserver.com;">
  <title>OgaCode</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      display: flex; flex-direction: column;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }

    /* ── Topbar ── */
    #topbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 8px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      font-size: 10px; opacity: 0.7; flex-shrink: 0;
    }
    #projectLabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── Thread ── */
    #thread {
      flex: 1; overflow-y: auto; padding: 10px 8px;
      display: flex; flex-direction: column; gap: 10px;
    }

    /* ── Bubbles ── */
    .msg { display: flex; flex-direction: column; max-width: 88%; }
    .msg.user  { align-self: flex-end; align-items: flex-end; }
    .msg.bot   { align-self: flex-start; align-items: flex-start; }

    .bubble {
      padding: 8px 12px; border-radius: 14px;
      line-height: 1.45; white-space: pre-wrap; word-break: break-word;
    }
    .user  .bubble {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-bottom-right-radius: 3px;
    }
    .bot .bubble {
      background: var(--vscode-editor-inactiveSelectionBackground, #2a2d2e);
      border-bottom-left-radius: 3px;
    }
    .bot .bubble.err { color: #f88; }
    .bot .bubble b { font-weight: 600; }
    .bot .bubble code { font-family: monospace; background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 2px; font-size: 0.9em; }
    .bot .bubble pre { background: rgba(255,255,255,0.06); padding: 6px 8px; border-radius: 4px; overflow-x: auto; font-size: 11px; margin: 4px 0; }

    /* ── Tool activity ── */
    .activity {
      font-size: 10px; opacity: 0.55; margin-top: 4px;
      max-height: 70px; overflow-y: auto;
      padding-left: 4px;
    }
    .activity div { margin: 1px 0; white-space: pre-wrap; word-break: break-all; }

    /* ── File chips ── */
    .files { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .chip {
      padding: 2px 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 10px; font-family: monospace; border-radius: 3px;
    }

    /* ── Typing dots ── */
    .dots span {
      display: inline-block; width: 5px; height: 5px; border-radius: 50%;
      background: currentColor; margin: 0 2px; opacity: 0.4;
      animation: bounce 1.2s infinite;
    }
    .dots span:nth-child(2) { animation-delay: 0.2s; }
    .dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce { 0%,80%,100%{transform:translateY(0);opacity:.4} 40%{transform:translateY(-4px);opacity:1} }

    /* ── Dev server / Expo buttons ── */
    #runbtn  { display: none; width: 100%; margin-top: 4px; }
    #expobtn { display: none; width: 100%; margin-top: 4px; }

    /* ── Input area ── */
    #inputArea {
      padding: 8px;
      border-top: 1px solid var(--vscode-panel-border, #333);
    }
    #inputRow { display: flex; gap: 4px; align-items: flex-end; }
    textarea {
      flex: 1; min-height: 36px; max-height: 120px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      padding: 6px 8px; font: inherit; resize: none; overflow: hidden;
    }
    .icon-btn {
      flex-shrink: 0; width: 32px; height: 32px;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
      border: none; cursor: pointer; border-radius: 4px;
      font-size: 14px; display: flex; align-items: center; justify-content: center;
    }
    #sendbtn {
      flex-shrink: 0; width: 32px; height: 32px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; cursor: pointer; border-radius: 4px;
      font-size: 16px; display: flex; align-items: center; justify-content: center;
    }
    #sendbtn:disabled, .icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #hint { font-size: 10px; opacity: 0.45; margin-top: 4px; text-align: center; }

    /* ── Memory panel ── */
    #memoryPanel {
      display: none; flex: 1; overflow-y: auto;
      padding: 8px; flex-direction: column; gap: 8px;
    }
    #memoryPanel.open { display: flex; }
    .mem-section { display: flex; flex-direction: column; gap: 4px; }
    .mem-header { display: flex; align-items: center; justify-content: space-between; }
    .mem-label { font-size: 11px; font-weight: 600; opacity: 0.8; }
    .mem-textarea {
      width: 100%; min-height: 70px; max-height: 130px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      padding: 4px 6px; font: inherit; resize: vertical; font-size: 11px;
    }
    #saveMemBtn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; padding: 6px; cursor: pointer; border-radius: 3px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div id="topbar">
    <span id="projectLabel"></span>
    <div style="display:flex;gap:4px;">
      <button class="icon-btn" id="memorybtn" title="Project memory">&#128203;</button>
      <button class="icon-btn" id="newchatbtn" title="New chat">&#128465;</button>
    </div>
  </div>
  <div id="memoryPanel">
    <div class="mem-section">
      <div class="mem-header">
        <span class="mem-label">PRD</span>
        <button class="icon-btn" id="uploadPrd" title="Upload file">&#128206;</button>
      </div>
      <textarea class="mem-textarea" id="memPrd" placeholder="What you&#x27;re building &#8212; goals, users, features&#8230;"></textarea>
    </div>
    <div class="mem-section">
      <div class="mem-header">
        <span class="mem-label">Rules</span>
        <button class="icon-btn" id="uploadRules" title="Upload file">&#128206;</button>
      </div>
      <textarea class="mem-textarea" id="memRules" placeholder="Coding conventions, stack choices, constraints&#8230;"></textarea>
    </div>
    <div class="mem-section">
      <div class="mem-header">
        <span class="mem-label">Skills</span>
        <button class="icon-btn" id="uploadSkills" title="Upload file">&#128206;</button>
      </div>
      <textarea class="mem-textarea" id="memSkills" placeholder="Reusable patterns, techniques, component styles&#8230;"></textarea>
    </div>
    <button id="saveMemBtn">Save Memory</button>
  </div>
  <div id="thread">
    <div class="msg bot">
      <div class="bubble">Hey! I'm OgaCode. Tell me what you want to build or change — I'll handle the code.</div>
    </div>
  </div>

  <div id="inputArea">
    <div id="inputRow">
      <textarea id="inp" rows="1" placeholder="Ask me anything…"></textarea>
      <button class="icon-btn" id="prevbtn" title="Preview HTML">&#128065;</button>
      <button id="sendbtn" title="Send (Enter)">&#10148;</button>
    </div>
    <button type="button" id="runbtn">&#9654; Run Dev Server</button>
    <button type="button" id="expobtn">&#128242; Run Expo</button>
    <div id="hint">Enter to send &nbsp;·&nbsp; Shift+Enter for new line</div>
  </div>

  <script nonce="${nonce}">
    var api         = acquireVsCodeApi();
    var thread      = document.getElementById('thread');
    var inp         = document.getElementById('inp');
    var sendbtn     = document.getElementById('sendbtn');
    var prevbtn     = document.getElementById('prevbtn');
    var runbtn      = document.getElementById('runbtn');
    var expobtn     = document.getElementById('expobtn');
    var newchatbtn  = document.getElementById('newchatbtn');
    var projLabel   = document.getElementById('projectLabel');
    var memorybtn   = document.getElementById('memorybtn');
    var memPanel    = document.getElementById('memoryPanel');
    var memPrd      = document.getElementById('memPrd');
    var memRules    = document.getElementById('memRules');
    var memSkills   = document.getElementById('memSkills');
    var uploadPrd   = document.getElementById('uploadPrd');
    var uploadRules = document.getElementById('uploadRules');
    var uploadSkills= document.getElementById('uploadSkills');
    var saveMemBtn  = document.getElementById('saveMemBtn');

    var currentBot = null;  // the bot message being built right now

    /* ── Helpers ── */
    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function mdToHtml(text) {
      var s = esc(text);
      s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
      s = s.replace(/^#{1,3} (.+)$/gm, '<b>$1</b>');
      s = s.replace(/\\n/g, '<br>');
      return s;
    }

    function scrollBottom() { thread.scrollTop = thread.scrollHeight; }

    function addUserMsg(text) {
      var el = document.createElement('div');
      el.className = 'msg user';
      el.innerHTML = '<div class="bubble">' + esc(text) + '</div>';
      thread.appendChild(el);
      scrollBottom();
    }

    function startBotMsg() {
      var el = document.createElement('div');
      el.className = 'msg bot';
      el.innerHTML =
        '<div class="bubble"><span class="dots"><span></span><span></span><span></span></span></div>' +
        '<div class="activity"></div>' +
        '<div class="files"></div>';
      thread.appendChild(el);
      scrollBottom();
      currentBot = el;
      return el;
    }

    function addActivity(text) {
      if (!currentBot) { return; }
      var act = currentBot.querySelector('.activity');
      var d = document.createElement('div');
      d.textContent = text;
      act.appendChild(d);
      act.scrollTop = act.scrollHeight;
    }

    function finishBotMsg(text, isErr) {
      if (!currentBot) { return; }
      var bubble = currentBot.querySelector('.bubble');
      bubble.innerHTML = isErr ? esc(text) : mdToHtml(text);
      if (isErr) { bubble.classList.add('err'); }
      currentBot = null;
      scrollBottom();
    }

    function addFileChips(files) {
      if (!files || !files.length) { return; }
      var lastBot = thread.querySelector('.msg.bot:last-child');
      if (!lastBot) { return; }
      var fbox = lastBot.querySelector('.files');
      files.forEach(function(f) {
        var chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = f.split(/[\\\\/]/).pop();
        fbox.appendChild(chip);
      });
    }

    function formatEvent(ev) {
      if (ev.type === 'thinking')     { return 'Thinking… (step ' + ev.step + ')'; }
      if (ev.type === 'provider')     { return 'Using ' + ev.name; }
      if (ev.type === 'pre_tool_use') {
        var args = ev.args || {};
        var parts = Object.keys(args).map(function(k) {
          var v = String(args[k]);
          return k + ': ' + (v.length > 50 ? v.slice(0, 50) + '…' : v);
        });
        return ev.tool + '(' + parts.join(', ') + ')';
      }
      if (ev.type === 'post_tool_use' && !ev.success) { return 'Error: ' + ev.error; }
      if (ev.type === 'correction') { return 'Retrying: ' + ev.msg; }
      if (ev.type === 'supervisor') { return 'Reviewing: ' + ev.msg; }
      if (ev.type === 'escalate')   { return 'Need input: ' + ev.msg; }
      return '';
    }

    /* ── Send ── */
    var sendTimer = null;
    function unlockSend() {
      sendbtn.disabled = false;
      if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    }

    function send() {
      if (sendbtn.disabled) { return; }
      var text = inp.value.trim();
      if (!text) { return; }
      inp.value = '';
      inp.style.height = 'auto';
      sendbtn.disabled = true;
      addUserMsg(text);
      startBotMsg();
      api.postMessage({ command: 'chat', prompt: text });
      sendTimer = setTimeout(function() {
        unlockSend();
        finishBotMsg('No response received. Check your connection and try again.', true);
      }, 180000);
    }

    sendbtn.addEventListener('click', send);

    /* ── Keyboard: Enter = send, Shift+Enter = new line ── */
    var shiftDown = false;
    document.addEventListener('keydown', function(e) { if (e.key === 'Shift') { shiftDown = true; } });
    document.addEventListener('keyup',   function(e) { if (e.key === 'Shift') { shiftDown = false; } });

    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    inp.addEventListener('input', function() {
      var val = inp.value;
      var nl  = val.indexOf('\\n');
      if (nl !== -1 && !shiftDown) {
        inp.value = val.slice(0, nl);
        send();
        return;
      }
      inp.style.height = 'auto';
      inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
    });

    prevbtn.addEventListener('click', function() {
      api.postMessage({ command: 'preview' });
    });

    newchatbtn.addEventListener('click', function() {
      api.postMessage({ command: 'newChat' });
    });

    memorybtn.addEventListener('click', function() {
      var open = memPanel.classList.toggle('open');
      thread.style.display = open ? 'none' : '';
      if (open) { api.postMessage({ command: 'loadMemory' }); }
    });

    uploadPrd.addEventListener('click', function() {
      api.postMessage({ command: 'pickMemoryFile', slot: 'prd' });
    });
    uploadRules.addEventListener('click', function() {
      api.postMessage({ command: 'pickMemoryFile', slot: 'rules' });
    });
    uploadSkills.addEventListener('click', function() {
      api.postMessage({ command: 'pickMemoryFile', slot: 'skills' });
    });

    saveMemBtn.addEventListener('click', function() {
      api.postMessage({ command: 'saveMemory', prd: memPrd.value, rules: memRules.value, skills: memSkills.value });
    });

    runbtn.addEventListener('click', function() {
      runbtn.disabled = true;
      runbtn.textContent = '⏳ Starting server…';
      api.postMessage({ command: 'runDevServer' });
    });

    expobtn.addEventListener('click', function() {
      expobtn.disabled = true;
      expobtn.textContent = '⏳ Starting Expo…';
      api.postMessage({ command: 'runExpo' });
    });

    /* ── Messages from extension ── */
    window.addEventListener('message', function(e) {
      var d = e.data;

      if (d.command === 'setProject') {
        projLabel.textContent = d.name || '';
        return;
      }

      if (d.command === 'chatCleared') {
        thread.innerHTML = '<div class="msg bot"><div class="bubble">New chat started. What would you like to build or change?</div></div>';
        unlockSend();
        return;
      }

      if (d.command === 'agentEvent') {
        var line = formatEvent(d);
        if (line) { addActivity(line); }
        // Reset timeout — agent is alive and making progress
        if (sendTimer) {
          clearTimeout(sendTimer);
          sendTimer = setTimeout(function() {
            unlockSend();
            finishBotMsg('No response received. Check your connection and try again.', true);
          }, 180000);
        }
        return;
      }

      if (d.command === 'chatDone') {
        unlockSend();
        finishBotMsg(d.summary, !d.success);
        if (d.files && d.files.length) {
          addFileChips(d.files);
          var hasPackageJson = d.files.some(function(f) { return f.indexOf('package.json') !== -1; });
          if (hasPackageJson) { runbtn.style.display = 'block'; runbtn.disabled = false; runbtn.textContent = '▶ Run Dev Server'; }
          var hasAppJson = d.files.some(function(f) { return f.indexOf('app.json') !== -1 || f.indexOf('app.config.js') !== -1; });
          if (hasAppJson) { expobtn.style.display = 'block'; expobtn.disabled = false; expobtn.textContent = '📱 Run Expo'; }
        }
        return;
      }

      if (d.command === 'chatError') {
        unlockSend();
        finishBotMsg('Sorry, something went wrong: ' + d.msg, true);
        return;
      }

      if (d.command === 'staticReady') {
        var lastBot = thread.querySelector('.msg.bot:last-child');
        if (lastBot) {
          var note = document.createElement('div');
          note.style.cssText = 'font-size:10px;opacity:.6;margin-top:4px;';
          note.textContent = '↗ Opened preview for ' + d.file.split(/[\\\\/]/).pop();
          lastBot.querySelector('.files').appendChild(note);
        }
        return;
      }

      if (d.command === 'devServerReady') {
        runbtn.disabled = false;
        runbtn.textContent = '▶ Run Dev Server';
        var lastBot = thread.querySelector('.msg.bot:last-child');
        if (lastBot) {
          var note2 = document.createElement('div');
          note2.style.cssText = 'font-size:10px;color:#6f6;margin-top:4px;';
          note2.textContent = '↗ Server live at localhost:3000';
          lastBot.querySelector('.files').appendChild(note2);
        }
        return;
      }

      if (d.command === 'devServerError') {
        runbtn.disabled = false;
        runbtn.textContent = '▶ Run Dev Server';
        addActivity('Server error: ' + d.error);
        return;
      }

      if (d.command === 'showExpobtn') {
        expobtn.style.display = 'block';
        expobtn.disabled = false;
        expobtn.textContent = '📱 Run Expo';
        return;
      }

      if (d.command === 'expoReady') {
        expobtn.disabled = false;
        expobtn.textContent = '📱 Run Expo';
        var qrWrap = document.createElement('div');
        qrWrap.style.cssText = 'margin-top:8px;text-align:center;';
        var qrImg = document.createElement('img');
        qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(d.url) + '&size=160x160&margin=4';
        qrImg.alt = 'Expo QR Code';
        qrImg.style.cssText = 'border-radius:6px;background:#fff;padding:4px;display:block;margin:0 auto;';
        var qrNote = document.createElement('div');
        qrNote.style.cssText = 'font-size:10px;opacity:.7;margin-top:4px;';
        qrNote.textContent = 'Scan with Expo Go · ' + d.url;
        qrWrap.appendChild(qrImg);
        qrWrap.appendChild(qrNote);
        var lastBubble = thread.querySelector('.msg.bot:last-child .bubble');
        if (lastBubble) { lastBubble.appendChild(qrWrap); }
        return;
      }

      if (d.command === 'expoError') {
        expobtn.disabled = false;
        expobtn.textContent = '📱 Run Expo';
        addActivity('Expo error: ' + d.error);
        return;
      }

      if (d.command === 'memoryLoaded') {
        memPrd.value    = d.prd    || '';
        memRules.value  = d.rules  || '';
        memSkills.value = d.skills || '';
        return;
      }

      if (d.command === 'memoryFilePicked') {
        if (d.slot === 'prd')    { memPrd.value    = d.content; }
        if (d.slot === 'rules')  { memRules.value  = d.content; }
        if (d.slot === 'skills') { memSkills.value = d.content; }
        return;
      }

      if (d.command === 'memorySaved') {
        saveMemBtn.textContent = 'Saved!';
        setTimeout(function() { saveMemBtn.textContent = 'Save Memory'; }, 1500);
        return;
      }
    });
  </script>
</body>
</html>`;
  }
}

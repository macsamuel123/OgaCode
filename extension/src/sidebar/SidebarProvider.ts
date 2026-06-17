import * as vscode from 'vscode';
import { exec } from 'child_process';
import { runAgent, AgentEvent, checkKeychainSetup, readKeychain, getPlan, PlanComponent, PlanStepDetail } from '../cli';
import { PreviewPanel, ElementSelection } from '../preview/PreviewPanel';
import { Turn, Memory, Chat } from './types';
import { getSidebarHtml } from './getSidebarHtml';
import { enrichPrompt } from './enrichPrompt';
import { describeImage } from './describeImage';
import { autoReview } from './review';
import { deployToNetlify } from './deploy';

const CHATS_KEY = 'ogacode.chats.v2';
const ACTIVE_CHAT_KEY = 'ogacode.activeChatId';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _lastPreviewFile: string | undefined;
  private _abortController: AbortController | undefined;
  private _selectedElement: ElementSelection | undefined;
  private _previewSelectionDisposable: vscode.Disposable | undefined;
  private _isAgentRunning = false;
  private _pendingPlan: { enriched: string; userTurn: Turn; chatId: string; history: Turn[]; cwd: string; serverUrl: string; token: string } | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _ctx: vscode.ExtensionContext,
  ) {}

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
    webviewView.webview.html = getSidebarHtml(webviewView.webview, this._extensionUri);
    webviewView.webview.onDidReceiveMessage(this._handleMessage.bind(this));
    // Restore the last active chat so thread + historyBtn are correct on reload
    setTimeout(() => {
      const chat = this._getActiveChat();
      if (chat && chat.turns.length > 0) {
        this._send('chatLoaded', { turns: chat.turns, chatName: chat.name, chatId: chat.id });
      } else if (chat) {
        this._send('chatNamed', { id: chat.id, name: chat.name });
      }
    }, 200);

    // Show onboarding if managed mode is configured but no token is set yet
    const cfg2 = vscode.workspace.getConfiguration('ogacode');
    const hasServerUrl = cfg2.get<string>('serverUrl', '').trim().length > 0;
    const hasToken     = cfg2.get<string>('token', '').trim().length > 0;
    if (hasServerUrl && !hasToken) {
      this._send('showOnboarding', {});
    }

    // Re-enable send button and focus input when sidebar becomes visible.
    // The WebviewView HTML persists across hide/show (retainContextWhenHidden: true),
    // so a button stuck disabled from a crashed agent stays broken without this.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        if (!this._isAgentRunning) { this._send('unlockSend', {}); }
        this._send('focusInput', {});
      }
    });

    // Subscribe to element clicks from the PreviewPanel
    this._previewSelectionDisposable?.dispose();
    this._previewSelectionDisposable = PreviewPanel.onElementSelected((data) => {
      this._selectedElement = data;
      const label = data.classes
        ? `${data.tagName}.${data.classes.trim().split(/\s+/)[0]}`
        : data.tagName;
      this._send('elementSelected', { label, selector: data.selector });
    });
  }

  private _getCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  }

  private async _handleMessage(message: {
    command: string;
    prompt?: string;
    image?: string;
    cmd?: string;
    url?: string;
    subdir?: string;
    files?: Array<{ path: string; content: string }>;
    slot?: string;
    prd?: string;
    rules?: string;
    skills?: string;
    steps?: string[];
    stepDetails?: PlanStepDetail[];
  }): Promise<void> {

    // ── Run agent task ────────────────────────────────────────────────────────
    if (message.command === 'chat' && message.prompt) {
      const cwd = this._getCwd();
      if (!cwd) {
        this._send('chatError', { msg: 'No folder open. Open a project folder first.' });
        return;
      }

      const cfg = vscode.workspace.getConfiguration('ogacode');
      const serverUrl = cfg.get<string>('serverUrl', '').trim();
      const token     = cfg.get<string>('token', '').trim();

      const preflight = checkKeychainSetup();
      if (!preflight.ok) {
        this._send('chatError', { msg: `Setup required: ${preflight.msg}` });
        return;
      }

      if (!serverUrl || !token) {
        this._send('chatError', { msg: 'OgaCode server not configured. Open Settings → Extensions → OgaCode and set your Server URL and Token.' });
        return;
      }

      this._abortController = new AbortController();
      this._isAgentRunning = true;
      try {
        const activeChat = await this._ensureActiveChat();
        const history = activeChat.turns;
        let userPrompt = message.prompt;

        // Inject selected element context so agent edits exactly the right element
        if (this._selectedElement) {
          const el = this._selectedElement;
          userPrompt =
            `[ELEMENT SELECTED FOR EDITING]\n` +
            `The user clicked this specific element in the preview. Edit ONLY this element — do not change anything else.\n` +
            `CSS Selector: ${el.selector}\n` +
            `HTML: ${el.outerHtml}\n` +
            `[END ELEMENT]\n\n${userPrompt}`;
          this._selectedElement = undefined;
        }

        if (message.image) {
          const isDesignRef = /\b(build|create|make|design|replicate|match|clone|copy)\b/i.test(userPrompt);
          const purpose = isDesignRef ? 'design' : 'debug';
          this._send('agentEvent', { type: 'thinking', step: 0, msg: isDesignRef ? 'Analysing design reference…' : 'Analysing screenshot…' });
          const groqKey = readKeychain('groq_api_key');
          const description = await describeImage(message.image, purpose, groqKey, serverUrl, token);
          if (description) {
            if (isDesignRef) {
              userPrompt =
                `[DESIGN REFERENCE — MATCH THIS EXACTLY]\n` +
                `The user has provided a screenshot of the design they want. ` +
                `Your #1 priority is to replicate this design as faithfully as possible.\n` +
                `Do not invent a different color scheme, layout, or style — use what is described below.\n\n` +
                `Design analysis:\n${description}\n\n` +
                `[END DESIGN REFERENCE]\n\n${userPrompt}`;
            } else {
              userPrompt = `[Screenshot attached — vision analysis:\n${description}]\n\n${userPrompt}`;
            }
          }
        }

        const enriched = enrichPrompt(userPrompt, cwd, history, this._getMemory());
        const userTurn: Turn = { role: 'user', content: message.prompt };

        // Generate plan and wait for user approval before executing
        this._send('agentEvent', { type: 'thinking', step: 0, msg: 'Planning…' });
        const plan = await getPlan(enriched, cwd, serverUrl || undefined, token || undefined);
        const resolvedPlan = plan ?? {
          summary: `Complete: ${userPrompt.slice(0, 80)}`,
          steps: [
            'Read and understand the relevant files in the project',
            'Implement the requested changes',
            'Verify the result works correctly',
          ],
          components: [] as PlanComponent[],
          stepDetails: [] as PlanStepDetail[],
          isDefault: true,
        };
        this._pendingPlan = { enriched, userTurn, chatId: activeChat.id, history, cwd, serverUrl, token };
        this._isAgentRunning = false;
        this._send('showPlan', {
          summary: resolvedPlan.summary,
          steps: resolvedPlan.steps,
          components: resolvedPlan.components ?? [],
          stepDetails: resolvedPlan.stepDetails ?? [],
          isDefault: resolvedPlan.isDefault ?? false,
        });
        return;
      } catch (err) {
        this._isAgentRunning = false;
        this._send('chatError', { msg: err instanceof Error ? err.message : 'Unknown error' });
      }
      return;
    }

    // ── Plan approval ─────────────────────────────────────────────────────────
    if (message.command === 'planApprove' && this._pendingPlan) {
      const p = this._pendingPlan;
      this._pendingPlan = undefined;
      this._abortController = new AbortController();
      this._isAgentRunning = true;
      try {
        let enriched = p.enriched;
        if (message.steps && message.steps.length > 0) {
          const stepLines = message.steps.map((s, i) => {
            const detail = message.stepDetails?.[i];
            const verif = detail?.verification ? `\n   Verify: ${detail.verification}` : '';
            return `${i + 1}. ${s}${verif}`;
          }).join('\n');
          enriched = '[APPROVED PLAN — follow these steps in order]\n' + stepLines + '\n[END PLAN]\n\n' + enriched;
        }
        await this._executeTask(enriched, p.userTurn, p.chatId, p.history, p.userTurn.content, p.cwd, p.serverUrl, p.token);
      } catch (err) {
        this._isAgentRunning = false;
        this._send('chatError', { msg: err instanceof Error ? err.message : 'Unknown error' });
      }
      return;
    }

    if (message.command === 'planReject') {
      this._pendingPlan = undefined;
      this._isAgentRunning = false;
      this._send('chatDone', { success: false, summary: 'Task cancelled.', files: [] });
      return;
    }

    // ── Plan clarification — regenerate plan with user's feedback ─────────────
    if (message.command === 'planClarify' && this._pendingPlan) {
      const p = this._pendingPlan;
      const clarification = ((message as unknown as { clarification?: string }).clarification ?? '').trim();
      const refinedPrompt = clarification
        ? `${p.userTurn.content}\n\n[User clarification]: ${clarification}`
        : p.userTurn.content;
      try {
        const newPlan = await getPlan(refinedPrompt, p.cwd, p.serverUrl || undefined, p.token || undefined);
        const resolvedNewPlan = newPlan ?? {
          summary: `Complete: ${refinedPrompt.slice(0, 80)}`,
          steps: ['Read and understand relevant files', 'Implement the changes', 'Verify the result'],
          components: [] as PlanComponent[],
          stepDetails: [] as PlanStepDetail[],
          isDefault: true,
        };
        this._pendingPlan = { ...p, enriched: enrichPrompt(refinedPrompt, p.cwd, p.history, this._getMemory()) };
        this._send('showPlanUpdate', {
          summary: resolvedNewPlan.summary,
          steps: resolvedNewPlan.steps,
          components: resolvedNewPlan.components ?? [],
          stepDetails: resolvedNewPlan.stepDetails ?? [],
          isDefault: resolvedNewPlan.isDefault ?? false,
        });
      } catch (err) {
        this._pendingPlan = undefined;
        this._isAgentRunning = false;
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
      terminal.sendText(`cd "${frontendPath}" ; npm install ; npm run dev`);
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
      terminal.sendText(`cd "${folder}" ; npx expo start`);
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
      const chat = await this._createNewChat();
      this._send('chatCleared', { chatId: chat.id, chatName: chat.name });
      return;
    }

    if (message.command === 'listChats') {
      const chats = this._getAllChats().sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      const activeChatId = this._ctx.globalState.get<string>(ACTIVE_CHAT_KEY) ?? '';
      this._send('chatList', { chats, activeChatId });
      return;
    }

    if (message.command === 'switchChat' && message.prompt) {
      const chatId = message.prompt;
      await this._ctx.globalState.update(ACTIVE_CHAT_KEY, chatId);
      const chat = this._getAllChats().find(c => c.id === chatId);
      if (chat) {
        this._send('chatLoaded', { turns: chat.turns, chatName: chat.name, chatId: chat.id });
      }
      return;
    }

    if (message.command === 'renameChat' && message.prompt && message.slot) {
      const chatId = message.prompt;
      const name = message.slot;
      const chats = this._getAllChats().map(c => c.id === chatId ? { ...c, name } : c);
      await this._saveAllChats(chats);
      this._send('chatRenamed', { chatId, name });
      return;
    }

    if (message.command === 'deleteChat' && message.prompt) {
      const chatId = message.prompt;
      let chats = this._getAllChats().filter(c => c.id !== chatId);
      const activeChatId = this._ctx.globalState.get<string>(ACTIVE_CHAT_KEY);
      let nextChat: Chat | undefined;
      if (activeChatId === chatId) {
        nextChat = chats[0] ?? await this._createNewChat();
        if (!chats.length) { chats = this._getAllChats(); }
        await this._ctx.globalState.update(ACTIVE_CHAT_KEY, nextChat.id);
      }
      await this._saveAllChats(chats);
      const active = nextChat ?? this._getAllChats().find(c => c.id === this._ctx.globalState.get<string>(ACTIVE_CHAT_KEY));
      this._send('chatDeleted', { turns: active?.turns ?? [], chatName: active?.name ?? 'New Chat' });
      return;
    }

    if (message.command === 'deploy') {
      const folder = this._getCwd();
      if (!folder) { this._send('deployError', { msg: 'No workspace open.' }); return; }
      const token = readKeychain('netlify_token');
      if (!token) { this._send('showDeploySetup', {}); return; }
      this._send('deployStatus', { msg: 'Zipping project…' });
      try {
        const url = await deployToNetlify(folder, token);
        this._send('deployDone', { url });
      } catch (err) {
        this._send('deployError', { msg: err instanceof Error ? err.message : 'Deploy failed.' });
      }
      return;
    }

    if (message.command === 'saveNetlifyToken' && message.prompt) {
      const rawToken = message.prompt.trim();
      const safeToken = rawToken.replace(/'/g, "'\\''");
      try {
        const { execSync } = require('child_process') as typeof import('child_process');
        execSync(
          `python -c "import keyring; keyring.set_password('ogacode','netlify_token','${safeToken}')"`,
          { timeout: 5000, stdio: 'pipe' }
        );
      } catch { /* keychain write failed — still try the deploy with the raw token */ }
      const folder = this._getCwd();
      if (!folder) { this._send('deployError', { msg: 'No workspace open.' }); return; }
      this._send('deployStatus', { msg: 'Zipping project…' });
      try {
        const url = await deployToNetlify(folder, rawToken);
        this._send('deployDone', { url });
      } catch (err) {
        this._send('deployError', { msg: err instanceof Error ? err.message : 'Deploy failed.' });
      }
      return;
    }

    if (message.command === 'clearElement') {
      this._selectedElement = undefined;
      return;
    }

    if (message.command === 'saveToken') {
      const t = ((message as unknown as { token: string }).token || '').trim();
      if (!t) { this._send('onboardErr', { msg: 'Please enter your access code.' }); return; }
      const cfg = vscode.workspace.getConfiguration('ogacode');
      await cfg.update('token', t, vscode.ConfigurationTarget.Global);
      this._send('onboardingDone', {});
      return;
    }

    if (message.command === 'stopAgent') {
      this._abortController?.abort();
      this._abortController = undefined;
      return;
    }

    if (message.command === 'openBrowser' && message.url) {
      vscode.env.openExternal(vscode.Uri.parse(message.url));
      return;
    }

    if (message.command === 'preview') {
      const folder = this._getCwd();
      if (!folder) { return; }
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

  private _getAllChats(): Chat[] {
    return this._ctx.globalState.get<Chat[]>(CHATS_KEY) ?? [];
  }

  private async _saveAllChats(chats: Chat[]): Promise<void> {
    await this._ctx.globalState.update(CHATS_KEY, chats);
  }

  private _getActiveChat(): Chat | undefined {
    const id = this._ctx.globalState.get<string>(ACTIVE_CHAT_KEY);
    return id ? this._getAllChats().find(c => c.id === id) : undefined;
  }

  private _nameChatFromMessage(msg: string): string {
    return msg.trim().slice(0, 32) + (msg.trim().length > 32 ? '…' : '');
  }

  private async _createNewChat(): Promise<Chat> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const now = new Date().toISOString();
    const chat: Chat = {
      id: `chat_${Date.now()}`,
      name: 'New Chat',
      project: folder?.name ?? 'No Project',
      projectPath: folder?.uri.fsPath ?? '',
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
    const chats = this._getAllChats();
    await this._saveAllChats([chat, ...chats]);
    await this._ctx.globalState.update(ACTIVE_CHAT_KEY, chat.id);
    return chat;
  }

  private async _ensureActiveChat(): Promise<Chat> {
    return this._getActiveChat() ?? await this._createNewChat();
  }

  private async _updateChatTurns(id: string, turns: Turn[]): Promise<void> {
    const chats = this._getAllChats().map(c =>
      c.id === id ? { ...c, turns, updatedAt: new Date().toISOString() } : c
    );
    await this._saveAllChats(chats);
  }

  private async _autoNameChat(id: string, firstMessage: string): Promise<void> {
    const name = this._nameChatFromMessage(firstMessage);
    const chats = this._getAllChats().map(c => c.id === id ? { ...c, name } : c);
    await this._saveAllChats(chats);
  }

  private _send(command: string, data: Record<string, unknown>): void {
    this._view?.webview.postMessage({ command, ...data });
    if (command === 'chatError') {
      vscode.window.setStatusBarMessage(`⚠️ OgaCode: ${data['msg']}`, 8000);
    }
  }

  private async _executeTask(
    enriched: string,
    userTurn: Turn,
    chatId: string,
    history: Turn[],
    originalPrompt: string,
    cwd: string,
    serverUrl: string,
    token: string,
  ): Promise<void> {
    const filesWritten: string[] = [];
    const result = await runAgent(
      enriched,
      cwd,
      (evt: AgentEvent) => {
        if (evt.type === 'pre_tool_use') {
          const args = (evt as { args?: Record<string, unknown> }).args;
          const fp = (args?.file_path ?? args?.path) as string | undefined;
          if (fp && !filesWritten.includes(fp)) { filesWritten.push(fp); }
        }
        this._send('agentEvent', evt);
      },
      this._abortController!.signal,
      serverUrl || undefined,
      token || undefined,
    );

    const summary = result.summary || (result.success ? 'Done.' : 'Task finished with no summary.');
    const assistantTurn: Turn = {
      role: 'assistant',
      content: result.files.length
        ? `${summary}\nFiles touched: ${result.files.join(', ')}`
        : summary,
    };
    await this._updateChatTurns(chatId, [...history, userTurn, assistantTurn]);
    if (history.length === 0) {
      await this._autoNameChat(chatId, originalPrompt);
      this._send('chatNamed', { id: chatId, name: this._nameChatFromMessage(originalPrompt) });
    }
    this._isAgentRunning = false;
    this._send('chatDone', { success: result.success, summary, files: result.files });

    if (result.success && cwd) {
      await autoReview(
        enriched, summary, filesWritten, cwd,
        serverUrl || undefined, token || undefined,
        this._send.bind(this),
      );
    }

    if (result.files.length > 0) {
      vscode.commands.executeCommand('workbench.view.explorer');
      vscode.window.setStatusBarMessage(`OgaCode: ${result.files.length} file(s) written`, 4000);

      const touchedWeb = result.files.some(f => /\.(html|css|js|ts|jsx|tsx)$/.test(f));
      if (touchedWeb && this._lastPreviewFile) {
        setTimeout(() => PreviewPanel.show(this._getCwd(), this._lastPreviewFile!), 800);
      }

      const folder = this._getCwd();
      const hasPackageJson = result.files.some(f => f.endsWith('package.json'));
      const hasAppJson = result.files.some(f => f.endsWith('app.json') || f.endsWith('app.config.js'))
        || (folder ? (await vscode.workspace.findFiles('app.json', '**/node_modules/**', 1)).length > 0 : false);
      if (hasAppJson) { this._send('showExpobtn', {}); }

      if (!hasPackageJson && folder) {
        const path = require('path') as typeof import('path');
        const fs = require('fs') as typeof import('fs');
        let htmlFile = result.files.find(f => f.endsWith('index.html') || f.endsWith('.html'));
        if (htmlFile) {
          const abs = path.isAbsolute(htmlFile) ? htmlFile : path.join(folder, htmlFile);
          if (!fs.existsSync(abs)) { htmlFile = undefined; }
        }
        if (!htmlFile) {
          const uris = await vscode.workspace.findFiles('**/index.html', '**/node_modules/**', 5);
          if (uris.length) { htmlFile = path.relative(folder, uris[0].fsPath); }
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
  }
}

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { AgentEvent, checkKeychainSetup, readKeychain, planThenRun, PlanThenRunHandle, PlanComponent, PlanStepDetail } from '../cli';
import { PreviewPanel, ElementSelection } from '../preview/PreviewPanel';
import { Turn, Chat } from './types';
import { getSidebarHtml } from './getSidebarHtml';
import { describeImage } from './describeImage';
import { autoReview } from './review';
import { deployToNetlify } from './deploy';

// enrichPrompt removed — tasks pass directly to CLI without modification

const CHATS_KEY = 'ogacode.chats.v2';
const ACTIVE_CHAT_KEY = 'ogacode.activeChatId';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _lastPreviewFile: string | undefined;
  private _abortController: AbortController | undefined;
  private _selectedElement: ElementSelection | undefined;
  private _previewSelectionDisposable: vscode.Disposable | undefined;
  private _isAgentRunning = false;

  // Execution tracking (reset on each new task)
  private _filesThisRun: string[] = [];
  private _stepCount = 0;
  private _startTime = 0;

  private _pendingPlan: {
    task: string;
    userTurn: Turn;
    chatId: string;
    history: Turn[];
    cwd: string;
    serverUrl: string;
    token: string;
  } | undefined;
  private _mergeHandle: PlanThenRunHandle | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _ctx: vscode.ExtensionContext,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = getSidebarHtml(webviewView.webview, this._extensionUri);
    webviewView.webview.onDidReceiveMessage(this._handleMessage.bind(this));

    // Show onboarding if server URL configured but no token yet
    const cfg2 = vscode.workspace.getConfiguration('ogacode');
    const hasServerUrl = cfg2.get<string>('serverUrl', '').trim().length > 0;
    const hasToken     = cfg2.get<string>('token', '').trim().length > 0;
    if (hasServerUrl && !hasToken) {
      this._send('showOnboarding', {});
    }

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && !this._isAgentRunning) {
        this._send('unlockSend', {});
      }
    });

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
    slot?: string;
    steps?: string[];
    clarification?: string;
    filePath?: string;
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

        // Image description (design reference or debug screenshot)
        if (message.image) {
          const isDesignRef = /\b(build|create|make|design|replicate|match|clone|copy)\b/i.test(userPrompt);
          this._send('agentEvent', { type: 'thinking', step: 0, msg: isDesignRef ? 'Analysing design reference…' : 'Analysing screenshot…' });
          const groqKey = readKeychain('groq_api_key');
          const description = await describeImage(message.image, isDesignRef ? 'design' : 'debug', groqKey, serverUrl, token);
          if (description) {
            userPrompt = isDesignRef
              ? `[DESIGN REFERENCE — MATCH THIS EXACTLY]\nDesign analysis:\n${description}\n[END DESIGN REFERENCE]\n\n${userPrompt}`
              : `[Screenshot attached — vision analysis:\n${description}]\n\n${userPrompt}`;
          }
        }

        // Pass task DIRECTLY to CLI — no enrichment, no injection
        const userTurn: Turn = { role: 'user', content: message.prompt };

        this._send('agentEvent', { type: 'thinking', step: 0, msg: 'Planning…' });

        if (this._mergeHandle) { this._mergeHandle.abort(); }

        const handle = planThenRun(
          userPrompt,
          cwd,
          serverUrl,
          token,
          (evt: AgentEvent) => {
            // Track files created during execution
            if (evt.type === 'pre_tool_use') {
              const e = evt as Record<string, unknown>;
              if (e['tool'] === 'file_edit') {
                const args = e['args'] as Record<string, unknown> | undefined;
                const fp = (args?.['path'] ?? args?.['file_path']) as string | undefined;
                if (fp && !this._filesThisRun.includes(fp)) {
                  this._filesThisRun.push(fp);
                }
              }
            }
            if (evt.type === 'thinking') { this._stepCount++; }
            this._send('agentEvent', evt);
          },
          this._abortController?.signal,
        );
        this._mergeHandle = handle;

        const plan = await handle.plan;
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

        this._pendingPlan = {
          task: userPrompt,
          userTurn,
          chatId: activeChat.id,
          history: activeChat.turns,
          cwd,
          serverUrl,
          token,
        };
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
    if (message.command === 'planApprove' && this._mergeHandle && this._pendingPlan) {
      const p = this._pendingPlan;
      this._pendingPlan = undefined;
      this._isAgentRunning = true;

      // Reset tracking for this execution
      this._filesThisRun = [];
      this._stepCount = 0;
      this._startTime = Date.now();

      try {
        const steps = (message.steps as string[])?.length > 0 ? (message.steps as string[]) : undefined;
        const result = await this._mergeHandle.approve(steps);
        this._mergeHandle = undefined;

        const elapsed = Date.now() - this._startTime;
        const summary = result.summary || (result.success ? 'Done.' : 'Task finished with no summary.');
        const allFiles = result.files.length ? result.files : this._filesThisRun;

        const assistantTurn: Turn = {
          role: 'assistant',
          content: allFiles.length
            ? `${summary}\nFiles: ${allFiles.join(', ')}`
            : summary,
        };
        await this._updateChatTurns(p.chatId, [...p.history, p.userTurn, assistantTurn]);

        if (p.history.length === 0) {
          await this._autoNameChat(p.chatId, p.userTurn.content);
          this._send('chatNamed', { id: p.chatId, name: this._nameChatFromMessage(p.userTurn.content) });
        }

        this._isAgentRunning = false;
        this._send('chatDone', {
          success: result.success,
          summary,
          files: allFiles,
          steps: this._stepCount,
          elapsed,
        });

        if (result.success && p.cwd) {
          await autoReview(
            p.task, summary, allFiles, p.cwd,
            p.serverUrl || undefined, p.token || undefined,
            this._send.bind(this),
          );
        }

        if (allFiles.length > 0) {
          vscode.commands.executeCommand('workbench.view.explorer');
          vscode.window.setStatusBarMessage(`OgaCode: ${allFiles.length} file(s) written`, 4000);

          const pathModule = require('path') as typeof import('path');
          const fs = require('fs') as typeof import('fs');
          const folder = p.cwd;
          const hasPackageJson = allFiles.some(f => f.endsWith('package.json'));
          const hasAppJson = allFiles.some(f => f.endsWith('app.json') || f.endsWith('app.config.js'))
            || ((await vscode.workspace.findFiles('app.json', '**/node_modules/**', 1)).length > 0);
          if (hasAppJson) { this._send('showExpobtn', {}); }

          if (!hasPackageJson && folder) {
            let htmlFile = allFiles.find(f => f.endsWith('index.html') || f.endsWith('.html'));
            if (htmlFile) {
              const abs = pathModule.isAbsolute(htmlFile) ? htmlFile : pathModule.join(folder, htmlFile);
              if (!fs.existsSync(abs)) { htmlFile = undefined; }
            }
            if (!htmlFile) {
              const uris = await vscode.workspace.findFiles('**/index.html', '**/node_modules/**', 5);
              if (uris.length) { htmlFile = pathModule.relative(folder, uris[0].fsPath); }
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
        this._isAgentRunning = false;
        this._mergeHandle = undefined;
        this._pendingPlan = undefined;
        this._send('chatError', { msg: err instanceof Error ? err.message : 'Unknown error' });
      }
      return;
    }

    if (message.command === 'planReject') {
      if (this._mergeHandle) {
        this._mergeHandle.reject();
        this._mergeHandle = undefined;
      }
      this._pendingPlan = undefined;
      this._isAgentRunning = false;
      this._send('chatDone', { success: false, summary: 'Task cancelled.', files: [], steps: 0, elapsed: 0 });
      return;
    }

    // ── Plan clarification ────────────────────────────────────────────────────
    if (message.command === 'planClarify' && this._pendingPlan) {
      const p = this._pendingPlan;
      const clarification = (message.clarification ?? '').trim();
      const refinedTask = clarification
        ? `${p.task}\n\n[User clarification]: ${clarification}`
        : p.task;

      try {
        if (this._mergeHandle) { this._mergeHandle.abort(); }
        const handle = planThenRun(
          refinedTask,
          p.cwd,
          p.serverUrl,
          p.token,
          (evt) => this._send('agentEvent', evt),
          this._abortController?.signal,
        );
        this._mergeHandle = handle;

        const newPlan = await handle.plan;
        const resolvedNewPlan = newPlan ?? {
          summary: `Complete: ${refinedTask.slice(0, 80)}`,
          steps: ['Read and understand relevant files', 'Implement the changes', 'Verify the result'],
          components: [] as PlanComponent[],
          stepDetails: [] as PlanStepDetail[],
          isDefault: true,
        };
        this._pendingPlan = { ...p, task: refinedTask };
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

    // ── File utilities ────────────────────────────────────────────────────────
    if (message.command === 'openFile' && message.filePath) {
      try {
        const uri = vscode.Uri.file(message.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
      } catch { /* file may not exist yet */ }
      return;
    }

    if (message.command === 'revealInExplorer' && message.filePath) {
      try {
        const uri = vscode.Uri.file(message.filePath);
        vscode.commands.executeCommand('revealInExplorer', uri);
      } catch { /* ignore */ }
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

    if (message.command === 'preview') {
      const folder = this._getCwd();
      if (!folder) { return; }
      const uris = await vscode.workspace.findFiles('**/*.html', '**/node_modules/**', 10);
      if (!uris.length) {
        this._send('chatError', { msg: 'No HTML files found in this project.' });
        return;
      }
      const path = require('path') as typeof import('path');
      PreviewPanel.show(folder, path.relative(folder, uris[0].fsPath));
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
        req.on('error', () => {});
        req.end();
        if (attempts > 90) { clearInterval(poll); this._send('devServerError', { error: 'Timed out' }); }
      }, 1000);
      return;
    }

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
        if (expoAttempts > 90) { clearInterval(expoPoll); this._send('expoError', { error: 'Timed out' }); }
      }, 1000);
      return;
    }

    // ── Shell / terminal ──────────────────────────────────────────────────────
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

    // ── Deploy ────────────────────────────────────────────────────────────────
    if (message.command === 'deploy') {
      const folder = this._getCwd();
      if (!folder) { this._send('deployError', { msg: 'No workspace open.' }); return; }
      const netlifyToken = readKeychain('netlify_token');
      if (!netlifyToken) { this._send('showDeploySetup', {}); return; }
      this._send('deployStatus', { msg: 'Zipping project…' });
      try {
        const url = await deployToNetlify(folder, netlifyToken);
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
      } catch { /* ignore */ }
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

    // ── Auth ──────────────────────────────────────────────────────────────────
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

    if (message.command === 'clearElement') {
      this._selectedElement = undefined;
      return;
    }
  }

  // ── Chat storage helpers ──────────────────────────────────────────────────

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
}

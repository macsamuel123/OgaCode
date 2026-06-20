import * as vscode from 'vscode';

export function getSidebarHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'sidebar.js')
  );
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource}; img-src https://api.qrserver.com data:;">
  <title>OgaCode</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      display: flex; flex-direction: column; height: 100%;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }

    /* ── Onboarding overlay ── */
    #onboarding {
      display: none; position: absolute; inset: 0;
      background: var(--vscode-sideBar-background, #1e1e1e);
      z-index: 999; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 28px 20px; gap: 16px; text-align: center;
    }
    #onboarding.visible { display: flex; }
    #onboarding h2 { font-size: 16px; font-weight: 700; }
    #onboarding p { font-size: 12px; opacity: .7; line-height: 1.5; }
    #tokenInput {
      width: 100%; padding: 10px 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 6px; font-size: 13px; outline: none;
    }
    #activateBtn {
      width: 100%; padding: 10px;
      background: #2d883e; color: #fff;
      border: none; border-radius: 6px;
      font-size: 13px; font-weight: 600; cursor: pointer;
    }
    #onboardErr { font-size: 11px; color: #f88; display: none; }

    /* ── Main app layout ── */
    #app { display: flex; flex-direction: column; flex: 1; overflow: hidden; }

    /* ── Input area ── */
    #inputArea {
      padding: 8px;
      border-top: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0;
    }
    #taskInput {
      width: 100%; min-height: 56px; max-height: 140px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      padding: 7px 9px; font: inherit; resize: vertical; overflow-y: auto;
      border-radius: 3px;
    }
    #inputBtns { display: flex; gap: 6px; margin-top: 6px; }
    #sendBtn {
      flex: 1; padding: 7px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px; cursor: pointer;
      font-size: 12px; font-weight: 600;
    }
    #sendBtn:disabled { opacity: .4; cursor: not-allowed; }
    #stopBtn {
      padding: 7px 12px;
      background: #8b0000; color: #fff;
      border: none; border-radius: 4px; cursor: pointer;
      font-size: 12px; font-weight: 600;
    }
    #inputHint { font-size: 10px; opacity: .4; margin-top: 4px; text-align: center; }

    /* ── Plan panel ── */
    #planPanel {
      flex: 1; overflow-y: auto; padding: 8px; display: flex;
      flex-direction: column; gap: 6px;
    }
    #planSummary { font-size: 11px; line-height: 1.5; opacity: .85; }
    #planSteps { display: flex; flex-direction: column; gap: 3px; margin-top: 4px; }
    .plan-step-row { display: flex; gap: 5px; align-items: flex-start; }
    .plan-step-num { flex-shrink: 0; opacity: .55; font-size: 11px; padding-top: 5px; min-width: 18px; }
    .plan-step-ta {
      flex: 1; resize: none; font: inherit; font-size: 11px; line-height: 1.45;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #444);
      padding: 4px 6px; border-radius: 3px; overflow: hidden;
    }
    #planActions { display: flex; gap: 6px; margin-top: 6px; flex-shrink: 0; }
    #approveBtn {
      flex: 1; padding: 7px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px; cursor: pointer;
      font-size: 12px; font-weight: 600;
    }
    #modifyBtn {
      padding: 7px 12px;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
      border: none; border-radius: 4px; cursor: pointer; font-size: 12px;
    }
    #clarifyBox { display: none; flex-direction: column; gap: 5px; margin-top: 4px; }
    #clarifyBox.visible { display: flex; }
    #clarifyInput {
      width: 100%; min-height: 44px; resize: vertical;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      padding: 5px 7px; font: inherit; font-size: 11px; border-radius: 3px;
    }
    .clarify-btns { display: flex; gap: 6px; }
    #clarifySubmit {
      flex: 1; padding: 6px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px; cursor: pointer; font-size: 11px;
    }
    #clarifyCancel {
      padding: 6px 10px;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
      border: none; border-radius: 4px; cursor: pointer; font-size: 11px;
    }

    /* ── Exec panel ── */
    #execPanel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    #execHeader {
      display: flex; justify-content: space-between; align-items: center;
      padding: 4px 8px; flex-shrink: 0;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      font-size: 10px; opacity: .65;
    }
    #eventStream {
      flex: 1; overflow-y: auto; padding: 4px 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px; line-height: 1.5;
    }
    .ev-line { white-space: pre-wrap; word-break: break-all; margin: 1px 0; }
    .ev-ok  { color: #4c4; }
    .ev-err { color: #f88; }
    .ev-dim { opacity: .55; }

    /* ── Files panel ── */
    #filesPanel {
      border-top: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0; max-height: 130px; overflow-y: auto;
    }
    #filesHeader {
      padding: 4px 8px; font-size: 10px; font-weight: 600;
      opacity: .65; background: var(--vscode-sideBar-background);
      position: sticky; top: 0;
    }
    #filesList { padding: 0 8px 4px; }
    .file-row {
      display: flex; align-items: center; gap: 4px;
      padding: 2px 0; font-size: 10px;
    }
    .file-name {
      flex: 1; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; font-family: monospace;
    }
    .file-btn {
      padding: 1px 5px; font-size: 9px;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
      border: none; border-radius: 2px; cursor: pointer; flex-shrink: 0;
    }
    .file-btn:hover { opacity: .8; }

    /* ── Result panel ── */
    #resultPanel { padding: 8px; flex-shrink: 0; }
    #resultMsg { font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
    .result-ok  { color: #4c4; }
    .result-err { color: #f88; }
    #resultStats { font-size: 10px; opacity: .55; margin-top: 4px; }
    #newTaskBtn {
      width: 100%; margin-top: 8px; padding: 7px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px; cursor: pointer;
      font-size: 12px; font-weight: 600;
    }

    /* ── Status bar ── */
    #statusBar {
      padding: 3px 8px; font-size: 10px; opacity: .5;
      border-top: 1px solid var(--vscode-panel-border, #333);
      flex-shrink: 0; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis;
    }
  </style>
</head>
<body>
  <!-- Onboarding overlay -->
  <div id="onboarding">
    <div style="font-size:32px">&#129302;</div>
    <h2>Welcome to OgaCode</h2>
    <p>Enter your access code to get started.<br>No API keys needed.</p>
    <input id="tokenInput" type="password" placeholder="Paste your access code here…">
    <button id="activateBtn">Activate OgaCode &#10148;</button>
    <div id="onboardErr"></div>
  </div>

  <!-- Main app -->
  <div id="app">

    <!-- Plan review panel (shown when plan arrives) -->
    <div id="planPanel" hidden>
      <div id="planSummary"></div>
      <div id="planSteps"></div>
      <div id="planActions">
        <button id="approveBtn">&#9654; Yes &#8212; run plan</button>
        <button id="modifyBtn">&#10005; Modify</button>
      </div>
      <div id="clarifyBox">
        <textarea id="clarifyInput" rows="2" placeholder="What needs to change?"></textarea>
        <div class="clarify-btns">
          <button id="clarifySubmit">&#8645; Regenerate plan</button>
          <button id="clarifyCancel">Cancel</button>
        </div>
      </div>
    </div>

    <!-- Execution panel (shown when running) -->
    <div id="execPanel" hidden>
      <div id="execHeader">
        <span id="stepCount">Step 0</span>
        <span id="elapsed">0s</span>
      </div>
      <div id="eventStream"></div>
    </div>

    <!-- Result panel (shown when done) -->
    <div id="resultPanel" hidden>
      <div id="resultMsg"></div>
      <div id="resultStats"></div>
      <button id="newTaskBtn">&#65291; New Task</button>
    </div>

    <!-- Files panel (appears as files are created) -->
    <div id="filesPanel" hidden>
      <div id="filesHeader">Files Created (<span id="fileCount">0</span>)</div>
      <div id="filesList"></div>
    </div>

    <!-- Input area (always at bottom) -->
    <div id="inputArea">
      <textarea id="taskInput" rows="2" placeholder="What do you want to build or fix?"></textarea>
      <div id="inputBtns">
        <button id="sendBtn">&#9654; Build</button>
        <button id="stopBtn" hidden>&#9632; Stop</button>
      </div>
      <div id="inputHint">Enter to send &nbsp;&#183;&nbsp; Shift+Enter for new line</div>
    </div>

  </div>

  <div id="statusBar">Ready</div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
}

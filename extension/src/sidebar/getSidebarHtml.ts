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
    @keyframes shake { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-4px)} 40%{transform:translateX(4px)} 60%{transform:translateX(-3px)} 80%{transform:translateX(3px)} }
    #inp.shake { animation: shake 0.35s ease; }

    /* ── Dev server / Expo buttons ── */
    #runbtn  { display: none; width: 100%; margin-top: 4px; }
    #expobtn { display: none; width: 100%; margin-top: 4px; }
    #deploybtn {
      display: none; width: 100%; margin-top: 4px;
      background: #24292e; color: #fff; border: none; padding: 7px;
      border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;
    }
    #deploybtn:hover { background: #3a3f44; }
    #deploybtn:disabled { opacity: 0.5; cursor: not-allowed; }
    #deployStatus {
      display: none; font-size: 10px; margin-top: 4px;
      padding: 6px 8px; border-radius: 4px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      word-break: break-all;
    }
    #deployStatus a { color: var(--vscode-textLink-foreground); cursor: pointer; }

    /* ── History dropdown ── */
    #topbar { position: relative; }
    #historyBtn {
      flex: 1; text-align: left; background: none; border: none; color: inherit;
      font-size: 11px; font-weight: 600; cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px;
      padding: 0;
    }
    #historyDropdown {
      position: absolute; top: 28px; left: 0; right: 0; z-index: 100;
      background: var(--vscode-menu-background, #252526);
      border: 1px solid var(--vscode-panel-border, #333);
      max-height: 260px; overflow-y: auto; display: none;
    }
    .hd-item {
      display: flex; align-items: center; gap: 4px; padding: 5px 8px;
      cursor: pointer; font-size: 11px;
    }
    .hd-item:hover, .hd-item.active { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .hd-proj { font-size: 9px; opacity: 0.5; margin: 6px 8px 2px; text-transform: uppercase; letter-spacing: 0.5px; }
    .hd-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hd-actions { display: flex; gap: 2px; flex-shrink: 0; visibility: hidden; pointer-events: none; }
    .hd-item:hover .hd-actions, .hd-item:focus-within .hd-actions { visibility: visible; pointer-events: auto; }
    .hd-new { border-top: 1px solid var(--vscode-panel-border, #333); color: var(--vscode-textLink-foreground, #4fc); }

    /* ── Input area ── */
    #inputArea {
      padding: 8px;
      border-top: 1px solid var(--vscode-panel-border, #333);
    }
    #inputRow { display: flex; gap: 4px; align-items: flex-end; }
    textarea {
      flex: 1; min-height: 36px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      padding: 6px 8px; font: inherit; resize: none; overflow-y: auto;
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
    #stopbtn {
      display: none; flex-shrink: 0; width: 32px; height: 32px;
      background: #8b0000; color: #fff;
      border: none; cursor: pointer; border-radius: 4px;
      font-size: 14px; align-items: center; justify-content: center;
    }
    #stopbtn.visible { display: flex; }
    #hint { font-size: 10px; opacity: 0.45; margin-top: 4px; text-align: center; }

    /* ── Image preview ── */
    #imagePreview {
      display: none; position: relative; margin-top: 4px; width: fit-content;
    }
    #imagePreview img {
      max-height: 72px; max-width: 100%; border-radius: 4px;
      border: 1px solid var(--vscode-input-border, #555); display: block;
    }
    #removeImg {
      position: absolute; top: -5px; right: -5px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 50%; width: 16px; height: 16px;
      font-size: 11px; cursor: pointer; line-height: 16px; text-align: center; padding: 0;
    }
    .user .bubble img { max-height: 120px; border-radius: 4px; display: block; margin-bottom: 4px; }

    /* ── Element selection chip ── */
    #elementChip {
      display: none; align-items: center; gap: 6px; margin-top: 4px;
      padding: 4px 8px; border-radius: 12px; font-size: 10px;
      background: rgba(249,150,0,0.12); border: 1px solid #f90; color: #f90;
    }
    #elementChip span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #clearElement {
      background: none; border: none; color: #f90; cursor: pointer;
      font-size: 13px; padding: 0; line-height: 1; flex-shrink: 0;
    }

    /* ── Build scope picker ── */
    .build-options { display: flex; flex-direction: column; gap: 7px; margin-top: 8px; }
    .build-opt {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; border-radius: 8px; cursor: pointer;
      border: 1.5px solid var(--vscode-panel-border, #444);
      background: var(--vscode-editor-background, #1e1e1e);
      transition: border-color 0.15s, background 0.15s;
      user-select: none;
    }
    .build-opt:hover {
      border-color: var(--vscode-focusBorder, #007acc);
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
    .build-opt.selected {
      border-color: var(--vscode-button-background, #0e639c);
      background: rgba(14,99,156,0.15);
    }
    .build-opt-icon { font-size: 20px; flex-shrink: 0; }
    .build-opt-text { display: flex; flex-direction: column; gap: 2px; flex: 1; }
    .build-opt-title { font-size: 12px; font-weight: 600; }
    .build-opt-desc  { font-size: 10px; opacity: 0.55; line-height: 1.4; }
    .build-opt-radio {
      width: 16px; height: 16px; border-radius: 50%; flex-shrink: 0;
      border: 2px solid var(--vscode-panel-border, #666);
      display: flex; align-items: center; justify-content: center;
      transition: border-color 0.15s;
    }
    .build-opt.selected .build-opt-radio { border-color: var(--vscode-button-background, #0e639c); }
    .build-opt.selected .build-opt-radio::after {
      content: ''; width: 8px; height: 8px; border-radius: 50%;
      background: var(--vscode-button-background, #0e639c); display: block;
    }
    .build-confirm {
      display: none; width: 100%; margin-top: 8px;
      padding: 7px; border-radius: 5px; border: none; cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-size: 12px; font-weight: 600;
    }
    .build-confirm:hover { opacity: 0.9; }

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
  <div id="jsdiag" style="padding:2px 6px;font-size:9px;background:#f80;color:#000;">JS not running — reload window (Ctrl+Shift+P &gt; Developer: Reload Window)</div>

  <div id="onboarding" style="display:none;position:absolute;inset:0;background:var(--vscode-sideBar-background,#1e1e1e);z-index:999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 20px;gap:16px;text-align:center;">
    <div style="font-size:32px;">&#129302;</div>
    <div style="font-weight:700;font-size:16px;color:var(--vscode-foreground);">Welcome to OgaCode</div>
    <div style="font-size:12px;opacity:.7;line-height:1.5;">Enter your access code to get started.<br>No API keys needed.</div>
    <input id="tokenInput" type="password" placeholder="Paste your access code here…"
      style="width:100%;padding:10px 12px;background:var(--vscode-input-background);
             color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);
             border-radius:6px;font-size:13px;outline:none;box-sizing:border-box;">
    <button id="activateBtn"
      style="width:100%;padding:10px;background:#2d883e;color:#fff;border:none;
             border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">
      Activate OgaCode &#10148;
    </button>
    <div id="onboardErr" style="font-size:11px;color:#f88;display:none;"></div>
  </div>
  <div id="topbar">
    <button id="historyBtn">New Chat &#9662;</button>
    <div id="historyDropdown"></div>
    <div style="display:flex;gap:4px;flex-shrink:0;">
      <button class="icon-btn" id="memorybtn" title="Project memory">&#128203;</button>
      <button class="icon-btn" id="newchatbtn" title="New chat">&#65291;</button>
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
    <div id="imagePreview">
      <img id="previewImg" src="" alt="pasted screenshot">
      <button id="removeImg" title="Remove image">&#215;</button>
    </div>
    <div id="elementChip">
      <span>&#9998; Editing: <b id="elementChipLabel"></b></span>
      <button id="clearElement" title="Clear selection">&#215;</button>
    </div>
    <div id="inputRow">
      <textarea id="inp" rows="1" placeholder="Ask me anything… Paste a design screenshot to match it exactly."></textarea>
      <button class="icon-btn" id="prevbtn" title="Preview HTML">&#128065;</button>
      <button id="stopbtn" title="Stop">&#9632;</button>
      <button id="sendbtn" title="Send (Enter)">&#10148;</button>
    </div>
    <button type="button" id="runbtn">&#9654; Run Dev Server</button>
    <button type="button" id="expobtn">&#128242; Run Expo</button>
    <button type="button" id="deploybtn">&#9729; Deploy</button>
    <div id="deployStatus"></div>
    <div id="hint">Enter to send &nbsp;·&nbsp; Shift+Enter for new line</div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
}

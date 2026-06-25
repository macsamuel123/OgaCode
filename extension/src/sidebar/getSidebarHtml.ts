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
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      --bg:           var(--vscode-sideBar-background, #1e1e1e);
      --panel:        var(--vscode-sideBar-background, #1e1e1e);
      --panel-raised: var(--vscode-editorWidget-background, #252526);
      --border:       var(--vscode-panel-border, #333334);
      --border-soft:  #2c2c2d;
      --text:         var(--vscode-foreground, #cccccc);
      --text-dim:     #8a8a8a;
      --text-faint:   #5a5a5a;
      --accent:       #e0a23d;
      --accent-soft:  rgba(224,162,61,0.14);
      --accent-line:  rgba(224,162,61,0.35);
      --green:        #5fb88a;
      --green-soft:   rgba(95,184,138,0.12);
      --blue:         #4a9eda;
      --red:          #d9685f;
      --mono:         'SF Mono','Cascadia Code','Consolas',monospace;
      --sans:         var(--vscode-font-family, -apple-system,'Segoe UI',system-ui,sans-serif);

      font-family: var(--sans);
      font-size: 13px;
      color: var(--text);
      background: var(--bg);
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    /* ── Onboarding overlay ── */
    #onboarding {
      display: none; position: absolute; inset: 0;
      background: var(--bg);
      z-index: 999; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 28px 20px; gap: 16px; text-align: center;
    }
    #onboarding.visible { display: flex; }
    #onboarding h2 { font-size: 16px; font-weight: 700; color: var(--text); }
    #onboarding p  { font-size: 12px; color: var(--text-dim); line-height: 1.5; }
    #tokenInput {
      width: 100%; padding: 10px 12px;
      background: var(--panel-raised);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px; font-size: 13px; outline: none;
      font-family: var(--sans);
    }
    #tokenInput:focus { border-color: var(--accent-line); }
    #activateBtn {
      width: 100%; padding: 10px;
      background: var(--green); color: #1e1e1e;
      border: none; border-radius: 6px;
      font-size: 13px; font-weight: 600; cursor: pointer;
    }
    #activateBtn:hover { opacity: .9; }
    #onboardErr { font-size: 11px; color: var(--red); display: none; }

    /* ── App shell ── */
    #app { display: flex; flex-direction: column; flex: 1; overflow: hidden; position: relative; }

    /* ── Header ── */
    .oga-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 9px 12px; flex-shrink: 0;
      background: var(--panel-raised);
      border-bottom: 1px solid var(--border);
    }
    .oga-brand { display: flex; align-items: center; gap: 7px; }
    .oga-mark {
      width: 16px; height: 16px; border-radius: 3px;
      background: var(--accent); position: relative; flex-shrink: 0;
    }
    .oga-mark::after {
      content: ''; position: absolute; top: 50%; left: 50%;
      width: 6px; height: 6px; background: var(--bg);
      transform: translate(-50%,-50%) rotate(45deg);
    }
    .oga-brand-name { font-size: 12px; font-weight: 600; letter-spacing: 0.2px; color: #e8e8e8; }
    .oga-header-actions { display: flex; align-items: center; gap: 10px; }
    .oga-status-pill { display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--text-dim); }
    .oga-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); }
    .oga-dot.live    { background: var(--green); box-shadow: 0 0 0 2px var(--green-soft); }
    .oga-dot.paused  { background: var(--accent); }
    .oga-dot.error   { background: var(--red); }
    .oga-icon-btn {
      color: var(--text-dim); font-size: 14px; cursor: pointer;
      display: flex; align-items: center; padding: 2px; border-radius: 3px;
      user-select: none; transition: color .12s ease;
    }
    .oga-icon-btn:hover { color: var(--accent); }

    /* ── Conversation body ── */
    .oga-body {
      flex: 1; min-height: 0; overflow-y: auto; padding: 12px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .oga-body::-webkit-scrollbar { width: 6px; }
    .oga-body::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 3px; }

    /* ── User bubble ── */
    .oga-msg-user {
      align-self: flex-end; max-width: 88%;
      background: #2a2d2e; border: 1px solid var(--border-soft);
      border-radius: 6px; padding: 7px 10px;
      font-size: 12.5px; line-height: 1.45; color: #d8d8d8;
      white-space: pre-wrap; word-break: break-word;
    }

    /* ── Agent text bubble ── */
    .oga-msg-agent {
      font-size: 12.5px; line-height: 1.55; color: var(--text);
    }
    .oga-msg-agent p { margin: 0 0 5px 0; }
    .oga-msg-agent code {
      font-family: var(--mono); font-size: 11.5px;
      background: var(--panel-raised); border: 1px solid var(--border-soft);
      border-radius: 3px; padding: 1px 4px; color: #d6b370;
    }

    /* ── Plan ladder ── */
    .oga-plan {
      border: 1px solid var(--border); border-radius: 6px;
      background: var(--panel-raised); overflow: hidden;
    }
    .oga-plan-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 10px; cursor: pointer; user-select: none;
    }
    .oga-plan-head:hover { background: rgba(255,255,255,0.02); }
    .oga-plan-title {
      display: flex; align-items: center; gap: 7px;
      font-size: 11.5px; font-weight: 600; color: #e8e8e8;
    }
    .oga-progress-ring {
      width: 13px; height: 13px; border-radius: 50%;
      border: 2px solid var(--border-soft); position: relative; flex-shrink: 0;
    }
    .oga-progress-ring svg { position: absolute; top: -2px; left: -2px; transform: rotate(-90deg); }
    .oga-plan-meta { font-size: 10.5px; color: var(--text-dim); font-family: var(--mono); }
    .oga-chevron { color: var(--text-faint); font-size: 10px; transition: transform .15s ease; }
    .oga-plan-steps { padding: 2px 10px 10px 10px; display: flex; flex-direction: column; }
    .oga-plan-actions { display: flex; gap: 8px; padding: 0 10px 10px 10px; }

    .oga-step {
      display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; position: relative;
    }
    .oga-step-rail {
      width: 14px; display: flex; flex-direction: column;
      align-items: center; flex-shrink: 0; position: relative; top: 1px;
    }
    .oga-step-rail .line {
      position: absolute; top: 14px; bottom: -10px;
      width: 1px; background: var(--border-soft);
    }
    .oga-step:last-child .oga-step-rail .line { display: none; }
    .oga-step-rail .line.done { background: var(--accent-line); }
    .oga-step-mark {
      width: 13px; height: 13px; border-radius: 50%;
      border: 1.5px solid var(--text-faint); flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      background: var(--panel-raised); z-index: 1;
    }
    .oga-step-mark.done { border-color: var(--accent); background: var(--accent); }
    .oga-step-mark.done::after { content: '✓'; font-size: 8px; color: #1e1e1e; font-weight: 700; }
    .oga-step-mark.active { border-color: var(--accent); animation: oga-pulse 1.4s ease-in-out infinite; }
    .oga-step-mark.active::after { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
    @keyframes oga-pulse {
      0%,100% { box-shadow: 0 0 0 0 var(--accent-soft); }
      50%      { box-shadow: 0 0 0 4px var(--accent-soft); }
    }
    .oga-step-text { font-size: 11.5px; line-height: 1.4; color: var(--text-dim); padding-top: 0; }
    .oga-step.done   .oga-step-text { color: var(--text-faint); text-decoration: line-through; text-decoration-color: var(--border-soft); }
    .oga-step.active .oga-step-text { color: #e8e8e8; font-weight: 500; }

    /* ── File tracking strip ── */
    .oga-files {
      border: 1px solid var(--border); border-radius: 6px;
      background: var(--panel-raised); overflow: hidden;
    }
    .oga-files-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 7px 10px; font-size: 10.5px; color: var(--text-dim);
      cursor: pointer; user-select: none;
    }
    .oga-files-head:hover { background: rgba(255,255,255,0.02); }
    .oga-file-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 5px 10px; border-top: 1px solid var(--border-soft);
      cursor: pointer; transition: background .1s ease;
    }
    .oga-file-row:hover { background: rgba(255,255,255,0.03); }
    .oga-file-left { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .oga-file-icon {
      width: 14px; height: 14px; flex-shrink: 0; border-radius: 2px;
      display: flex; align-items: center; justify-content: center;
      font-size: 8px; font-weight: 700; font-family: var(--mono);
    }
    .oga-file-icon.py   { background: rgba(74,158,218,0.18); color: var(--blue); }
    .oga-file-icon.ts   { background: rgba(74,158,218,0.18); color: var(--blue); }
    .oga-file-icon.js   { background: rgba(216,180,116,0.18); color: #d8b474; }
    .oga-file-icon.json { background: rgba(216,180,116,0.18); color: #d8b474; }
    .oga-file-icon.gen  { background: rgba(90,90,90,0.25); color: var(--text-dim); }
    .oga-file-name {
      font-family: var(--mono); font-size: 11px; color: #cfcfcf;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .oga-file-path { font-family: var(--mono); font-size: 9.5px; color: var(--text-faint); }
    .oga-file-badge {
      font-size: 9px; font-family: var(--mono);
      padding: 1px 5px; border-radius: 3px; flex-shrink: 0;
    }
    .oga-file-badge.created { color: var(--green);    background: var(--green-soft); }
    .oga-file-badge.edited  { color: var(--accent);   background: var(--accent-soft); }
    .oga-file-badge.reading { color: var(--text-dim); }
    .oga-diff-stat { font-family: var(--mono); font-size: 9.5px; flex-shrink: 0; }
    .oga-diff-stat .add { color: var(--green); }
    .oga-diff-stat .rem { color: var(--red); margin-left: 4px; }

    /* ── Diff view ── */
    .oga-diff-view {
      border: 1px solid var(--border); border-radius: 6px;
      overflow: hidden; font-family: var(--mono); font-size: 11px;
    }
    .oga-diff-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 10px; background: var(--panel-raised);
      border-bottom: 1px solid var(--border);
      font-family: var(--sans); font-size: 10.5px; color: var(--text-dim);
    }
    .oga-diff-back { color: var(--accent); cursor: pointer; font-size: 10.5px; }
    .oga-diff-line { padding: 1px 10px; white-space: pre; line-height: 1.6; }
    .oga-diff-line.add { background: rgba(95,184,138,0.10); color: #9fd4b8; }
    .oga-diff-line.rem { background: rgba(217,104,95,0.10);  color: #e0a8a3; }
    .oga-diff-line.ctx { color: var(--text-faint); }

    /* ── Streaming tool-call rows ── */
    .oga-toolcall {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: var(--text-faint);
      font-family: var(--mono); padding: 2px 0;
    }
    .oga-toolcall .verb   { color: var(--text-dim); }
    .oga-toolcall .target { color: #b8b8b8; }
    .oga-toolcall .status { margin-left: 2px; }
    .oga-toolcall .status.ok  { color: var(--green); }
    .oga-toolcall .status.err { color: var(--red); }
    .oga-cursor-blink {
      display: inline-block; width: 6px; height: 12px;
      background: var(--accent); animation: oga-blink 1s step-end infinite;
      vertical-align: middle; margin-left: 2px;
    }
    @keyframes oga-blink { 50% { opacity: 0; } }

    /* ── Paused card ── */
    .oga-pause-card {
      border: 1px solid var(--accent-line); background: var(--accent-soft);
      border-radius: 6px; padding: 12px;
    }
    .oga-pause-title {
      display: flex; align-items: center; gap: 7px;
      font-size: 12px; font-weight: 600; color: #e8c088; margin-bottom: 5px;
    }
    .oga-pause-body {
      font-size: 11.5px; color: var(--text-dim); line-height: 1.5; margin-bottom: 10px;
    }
    .oga-pause-actions { display: flex; gap: 8px; }

    /* ── Error card ── */
    .oga-error-card {
      border: 1px solid rgba(217,104,95,0.4); background: rgba(217,104,95,0.1);
      border-radius: 6px; padding: 10px 12px;
      font-size: 11.5px; color: #e0a8a3; line-height: 1.5;
    }
    .oga-error-title { font-weight: 600; margin-bottom: 4px; color: var(--red); }

    /* ── Done summary bubble ── */
    .oga-done-summary {
      font-size: 12px; line-height: 1.55; color: var(--text);
      border-left: 2px solid var(--green); padding-left: 10px;
    }

    /* ── Buttons ── */
    .oga-btn-primary {
      background: var(--accent); color: #1e1e1e;
      border: none; border-radius: 4px; padding: 6px 12px;
      font-size: 11.5px; font-weight: 600; cursor: pointer; font-family: var(--mono);
    }
    .oga-btn-primary:hover { background: #ecb456; }
    .oga-btn-secondary {
      background: transparent; color: var(--text-dim);
      border: 1px solid var(--border); border-radius: 4px; padding: 6px 12px;
      font-size: 11.5px; cursor: pointer; font-family: var(--sans);
    }
    .oga-btn-secondary:hover { color: var(--text); border-color: var(--text-faint); }

    /* ── Plan review buttons ── */
    .oga-btn-approve {
      flex: 1; padding: 6px 10px;
      background: var(--green); color: #1e1e1e;
      border: none; border-radius: 4px; cursor: pointer;
      font-size: 11px; font-weight: 600;
    }
    .oga-btn-approve:hover { opacity: .9; }
    .oga-btn-modify {
      padding: 6px 10px;
      background: var(--panel-raised); color: var(--text-dim);
      border: 1px solid var(--border); border-radius: 4px;
      cursor: pointer; font-size: 11px;
    }

    /* ── Clarify box (plan modification) ── */
    #clarifyBox {
      display: none; flex-direction: column; gap: 5px;
      padding: 8px 10px; border-top: 1px solid var(--border); flex-shrink: 0;
    }
    #clarifyBox.visible { display: flex; }
    #clarifyInput {
      width: 100%; min-height: 40px; resize: vertical;
      background: var(--panel-raised); color: var(--text);
      border: 1px solid var(--border); padding: 4px 6px;
      font: inherit; font-size: 10px; border-radius: 3px;
    }
    .clarify-btns { display: flex; gap: 6px; }
    #clarifySubmit {
      flex: 1; padding: 5px; background: var(--accent); color: #1e1e1e;
      border: none; border-radius: 4px; cursor: pointer; font-size: 10px; font-weight: 600;
    }
    #clarifyCancel {
      padding: 5px 8px; background: var(--panel-raised); color: var(--text-dim);
      border: 1px solid var(--border); border-radius: 4px; cursor: pointer; font-size: 10px;
    }

    /* ── Section label ── */
    .oga-section-label {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px;
      color: var(--text-faint); font-weight: 600; margin-bottom: 4px; padding: 0 2px;
    }

    /* ── Footer / input ── */
    .oga-footer {
      border-top: 1px solid var(--border); background: var(--panel-raised);
      flex-shrink: 0; padding: 8px 10px;
    }
    .oga-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
    .oga-chips:empty { display: none; }
    .oga-chip {
      display: flex; align-items: center; gap: 5px;
      background: var(--bg); border: 1px solid var(--border);
      border-radius: 4px; padding: 3px 7px;
      font-size: 10.5px; font-family: var(--mono); color: #cfcfcf;
    }
    .oga-chip .x { color: var(--text-faint); cursor: pointer; font-size: 11px; }
    .oga-chip .x:hover { color: var(--text); }

    .oga-input-wrap {
      display: flex; align-items: flex-end; gap: 6px;
      background: var(--bg); border: 1px solid var(--border);
      border-radius: 5px; padding: 6px 8px; transition: border-color .12s ease;
    }
    .oga-input-wrap:focus-within { border-color: var(--accent-line); }
    .oga-input-icon {
      color: var(--text-faint); font-size: 15px; cursor: pointer; padding: 2px; flex-shrink: 0;
      user-select: none; align-self: flex-end; margin-bottom: 1px;
    }
    .oga-input-icon:hover { color: var(--accent); }
    .oga-input-icon:disabled, .oga-input-icon[disabled] { opacity: .35; pointer-events: none; }
    #taskInput {
      flex: 1; background: transparent; border: none; outline: none; resize: none;
      font-family: var(--sans); font-size: 12px; color: var(--text); line-height: 1.45;
      min-height: 20px; max-height: 120px; overflow-y: auto;
    }
    #taskInput::placeholder { color: var(--text-faint); }
    .oga-send-btn {
      background: var(--accent); width: 24px; height: 24px; border-radius: 4px;
      display: flex; align-items: center; justify-content: center;
      color: #1e1e1e; font-size: 12px; flex-shrink: 0; cursor: pointer;
      align-self: flex-end; user-select: none;
    }
    .oga-send-btn:hover { background: #ecb456; }
    .oga-send-btn.disabled { background: var(--border); color: var(--text-faint); cursor: not-allowed; }
    .oga-footer-meta {
      display: flex; justify-content: space-between; align-items: center;
      margin-top: 6px; font-size: 9.5px; color: var(--text-faint);
    }
    #stopBtn { cursor: pointer; color: var(--red); display: none; }
    #stopBtn:hover { opacity: .8; }

    /* ── History overlay ── */
    #historyOverlay { position: absolute; inset: 0; z-index: 20; }
    .oga-history-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.35); }
    .oga-history-pop {
      position: absolute; top: 38px; right: 10px; left: 10px;
      background: var(--panel-raised); border: 1px solid var(--border);
      border-radius: 7px; box-shadow: 0 6px 20px rgba(0,0,0,0.45);
      max-height: 480px; display: flex; flex-direction: column; overflow: hidden;
    }
    .oga-history-search { padding: 8px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .oga-history-search input {
      width: 100%; background: var(--bg); border: 1px solid var(--border);
      border-radius: 4px; padding: 5px 8px; font-size: 11.5px;
      color: var(--text); font-family: var(--sans); outline: none;
    }
    .oga-history-search input::placeholder { color: var(--text-faint); }
    .oga-history-search input:focus { border-color: var(--accent-line); }
    .oga-history-new {
      display: flex; align-items: center; gap: 6px; padding: 8px 10px;
      font-size: 11.5px; color: var(--accent); cursor: pointer;
      border-bottom: 1px solid var(--border-soft); flex-shrink: 0; user-select: none;
    }
    .oga-history-new:hover { background: var(--accent-soft); }
    .oga-history-list { overflow-y: auto; flex: 1; }
    .oga-history-group-label {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--text-faint); font-weight: 600; padding: 8px 10px 4px 10px;
    }
    .oga-history-item {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 7px 10px; cursor: pointer; position: relative;
    }
    .oga-history-item:hover { background: rgba(255,255,255,0.04); }
    .oga-history-item.current { background: var(--accent-soft); }
    .oga-history-item.current::before {
      content: ''; position: absolute; left: 0; top: 0; bottom: 0;
      width: 2px; background: var(--accent);
    }
    .oga-history-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-top: 5px; }
    .oga-history-dot.live   { background: var(--green); }
    .oga-history-dot.paused { background: var(--accent); }
    .oga-history-dot.done   { background: var(--border); }
    .oga-history-text { flex: 1; min-width: 0; }
    .oga-history-title {
      font-size: 11.5px; color: #d6d6d6;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .oga-history-item.current .oga-history-title { color: #efefef; font-weight: 500; }
    .oga-history-snippet {
      font-size: 10.5px; color: var(--text-faint);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px;
    }
    .oga-history-time { font-size: 9.5px; color: var(--text-faint); flex-shrink: 0; font-family: var(--mono); margin-top: 1px; }
    .oga-history-empty { padding: 24px 16px; text-align: center; color: var(--text-faint); font-size: 11px; }
  </style>
</head>
<body>
  <!-- Onboarding overlay -->
  <div id="onboarding">
    <div style="font-size:32px">🤖</div>
    <h2>Welcome to OgaCode</h2>
    <p>Enter your access code to get started.<br>No API keys needed.</p>
    <input id="tokenInput" type="password" placeholder="Paste your access code here…">
    <button id="activateBtn">Activate OgaCode &#10148;</button>
    <div id="onboardErr"></div>
  </div>

  <!-- Main app -->
  <div id="app">
    <!-- Header -->
    <div class="oga-header">
      <div class="oga-brand">
        <div class="oga-mark"></div>
        <span class="oga-brand-name">OgaCode</span>
      </div>
      <div class="oga-header-actions">
        <div class="oga-status-pill">
          <span id="statusLabel">Ready</span>
          <span class="oga-dot" id="statusDot"></span>
        </div>
        <span class="oga-icon-btn" id="historyBtn" title="Chat history">&#128218;</span>
      </div>
    </div>

    <!-- Conversation body -->
    <div class="oga-body" id="chat"></div>

    <!-- Clarify box (plan modification, outside chat) -->
    <div id="clarifyBox">
      <textarea id="clarifyInput" rows="2" placeholder="What needs to change?"></textarea>
      <div class="clarify-btns">
        <button id="clarifySubmit">&#8645; Regenerate plan</button>
        <button id="clarifyCancel">Cancel</button>
      </div>
    </div>

    <!-- Footer -->
    <div class="oga-footer">
      <div class="oga-chips" id="fileChips"></div>
      <div class="oga-input-wrap">
        <span class="oga-input-icon" id="addFilesBtn" title="Attach context files">&#128206;</span>
        <textarea id="taskInput" rows="1" placeholder="Tell Oga what to build…"></textarea>
        <div class="oga-send-btn" id="sendBtn">&#9654;</div>
      </div>
      <div class="oga-footer-meta">
        <span>ogacode &middot; python backend</span>
        <span id="stopBtn">&#9632; Stop</span>
        <span>&#8629; to send</span>
      </div>
    </div>

    <!-- History overlay (hidden by default) -->
    <div id="historyOverlay" style="display:none; position:absolute; inset:0; z-index:20;">
      <div class="oga-history-overlay" id="historyBackdrop"></div>
      <div class="oga-history-pop">
        <div class="oga-history-search">
          <input type="text" id="historySearch" placeholder="Search conversations…">
        </div>
        <div class="oga-history-new" id="newChatBtn">&#65291; New conversation</div>
        <div class="oga-history-list" id="historyList"></div>
      </div>
    </div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
}

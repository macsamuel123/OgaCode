// OgaCode sidebar — thin CLI wrapper UI
// State machine: idle → planning → reviewing → executing → done / error

var _state = 'idle';
var _timerInterval = null;
var _timerStart = 0;
var _filesRendered = {};   // path → true, dedup file rows

var api = acquireVsCodeApi();

function post(cmd, data) {
  api.postMessage(Object.assign({ command: cmd }, data || {}));
}

// ── Onboarding ──────────────────────────────────────────────────────────────

var _jd = document.getElementById('jsdiag');
if (_jd) { _jd.style.display = 'none'; }

document.getElementById('activateBtn').addEventListener('click', function() {
  var t = document.getElementById('tokenInput').value.trim();
  if (!t) {
    var err = document.getElementById('onboardErr');
    err.textContent = 'Please enter your access code.';
    err.style.display = 'block';
    return;
  }
  post('saveToken', { token: t });
});
document.getElementById('tokenInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { document.getElementById('activateBtn').click(); }
});

// ── State machine ────────────────────────────────────────────────────────────

function setState(s) {
  _state = s;

  var planPanel   = document.getElementById('planPanel');
  var execPanel   = document.getElementById('execPanel');
  var resultPanel = document.getElementById('resultPanel');
  var inputArea   = document.getElementById('inputArea');
  var sendBtn     = document.getElementById('sendBtn');
  var stopBtn     = document.getElementById('stopBtn');
  var statusBar   = document.getElementById('statusBar');

  planPanel.hidden   = true;
  execPanel.hidden   = true;
  resultPanel.hidden = true;
  stopBtn.hidden     = true;
  sendBtn.disabled   = false;
  sendBtn.hidden     = false;
  inputArea.hidden   = false;

  if (s === 'idle') {
    statusBar.textContent = 'Ready';
  } else if (s === 'planning') {
    inputArea.hidden = true;
    statusBar.textContent = 'Generating plan…';
  } else if (s === 'reviewing') {
    inputArea.hidden = true;
    planPanel.hidden = false;
    statusBar.textContent = 'Review the plan before running';
  } else if (s === 'executing') {
    inputArea.hidden = true;
    execPanel.hidden = false;
    stopBtn.hidden   = false;
    sendBtn.hidden   = true;
    statusBar.textContent = 'Running…';
    _startTimer();
  } else if (s === 'done') {
    resultPanel.hidden = false;
    statusBar.textContent = 'Done';
    _stopTimer();
  } else if (s === 'error') {
    statusBar.textContent = 'Error — check settings or try again';
    _stopTimer();
  }
}

// ── Timer ────────────────────────────────────────────────────────────────────

function _startTimer() {
  _timerStart = Date.now();
  _timerInterval = setInterval(function() {
    var s = Math.floor((Date.now() - _timerStart) / 1000);
    document.getElementById('elapsed').textContent =
      s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's';
  }, 1000);
}

function _stopTimer() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
}

// ── Plan display ─────────────────────────────────────────────────────────────

function showPlan(d) {
  var summary  = document.getElementById('planSummary');
  var stepsDiv = document.getElementById('planSteps');

  summary.textContent = d.summary || '';
  stepsDiv.innerHTML  = '';

  var steps = d.steps || [];
  steps.forEach(function(step, i) {
    var row = document.createElement('div');
    row.className = 'plan-step-row';

    var num = document.createElement('span');
    num.className   = 'plan-step-num';
    num.textContent = (i + 1) + '.';

    var ta = document.createElement('textarea');
    ta.className        = 'plan-step-ta';
    ta.dataset.planStep = 'true';
    ta.value            = step;
    ta.rows             = 1;
    ta.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = this.scrollHeight + 'px';
    });
    setTimeout(function() {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    }, 0);

    row.appendChild(num);
    row.appendChild(ta);
    stepsDiv.appendChild(row);
  });

  document.getElementById('clarifyBox').classList.remove('visible');
  document.getElementById('clarifyInput').value = '';
  setState('reviewing');
}

// ── Event stream ─────────────────────────────────────────────────────────────

function formatEvent(ev) {
  if (ev.type === 'thinking') {
    return { cls: 'ev-dim', text: '  Thinking… (step ' + (ev.step || 0) + ')' };
  }
  if (ev.type === 'provider') {
    return { cls: 'ev-dim', text: '  Using ' + (ev.name || '') };
  }
  if (ev.type === 'pre_tool_use') {
    var args  = ev.args || {};
    var parts = Object.keys(args).map(function(k) {
      var v = String(args[k]);
      return k + ': ' + (v.length > 60 ? v.slice(0, 60) + '…' : v);
    });
    return { cls: 'ev-dim', text: '  ▸ ' + (ev.tool || '') + '(' + parts.join(', ') + ')' };
  }
  if (ev.type === 'post_tool_use') {
    if (ev.success) {
      var out = String(ev.output || '').slice(0, 80).trim();
      return { cls: 'ev-ok', text: '  ✅ ' + (ev.tool || '') + (out ? ' → ' + out : '') };
    }
    return { cls: 'ev-err', text: '  ❌ ' + String(ev.error || 'failed').slice(0, 120) };
  }
  if (ev.type === 'correction') {
    return { cls: 'ev-dim', text: '  ↺ ' + (ev.msg || '') };
  }
  if (ev.type === 'supervisor') {
    return { cls: 'ev-dim', text: '  ◈ ' + (ev.msg || '') };
  }
  if (ev.type === 'escalate') {
    return { cls: '', text: '  ? ' + (ev.msg || '') };
  }
  return null;
}

function appendEvent(ev) {
  var stream = document.getElementById('eventStream');
  var fmt    = formatEvent(ev);
  if (!fmt) { return; }

  var line = document.createElement('div');
  line.className   = 'ev-line ' + (fmt.cls || '');
  line.textContent = fmt.text;
  stream.appendChild(line);
  stream.scrollTop = stream.scrollHeight;

  if (ev.type === 'thinking' && ev.step) {
    document.getElementById('stepCount').textContent = 'Step ' + ev.step;
  }

  // Track files from file_edit pre_tool events
  if (ev.type === 'pre_tool_use' && ev.tool === 'file_edit') {
    var args2 = ev.args || {};
    var fp = args2['path'] || args2['file_path'];
    if (fp) { _addFileRow(String(fp)); }
  }
}

// ── File list ─────────────────────────────────────────────────────────────────

function _addFileRow(filePath) {
  if (_filesRendered[filePath]) { return; }
  _filesRendered[filePath] = true;

  var filesPanel = document.getElementById('filesPanel');
  var filesList  = document.getElementById('filesList');
  var fileCount  = document.getElementById('fileCount');

  filesPanel.hidden = false;

  var name = filePath.replace(/\\/g, '/').split('/').pop() || filePath;

  var row = document.createElement('div');
  row.className = 'file-row';

  var nameSpan = document.createElement('span');
  nameSpan.className   = 'file-name';
  nameSpan.textContent = '📄 ' + name;
  nameSpan.title       = filePath;

  var openBtn = document.createElement('button');
  openBtn.className   = 'file-btn';
  openBtn.textContent = 'Open';
  openBtn.onclick     = (function(p) { return function() { post('openFile', { filePath: p }); }; })(filePath);

  var revealBtn = document.createElement('button');
  revealBtn.className   = 'file-btn';
  revealBtn.textContent = 'Reveal';
  revealBtn.onclick     = (function(p) { return function() { post('revealInExplorer', { filePath: p }); }; })(filePath);

  row.appendChild(nameSpan);
  row.appendChild(openBtn);
  row.appendChild(revealBtn);
  filesList.appendChild(row);

  fileCount.textContent = String(filesList.children.length);
}

function _resetFileList() {
  _filesRendered = {};
  document.getElementById('filesList').innerHTML = '';
  document.getElementById('fileCount').textContent = '0';
  document.getElementById('filesPanel').hidden = true;
}

// ── Input / send ─────────────────────────────────────────────────────────────

var _taskInput = document.getElementById('taskInput');
var _sendBtn   = document.getElementById('sendBtn');
var _stopBtn   = document.getElementById('stopBtn');

_taskInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    _doSend();
  }
});

_sendBtn.addEventListener('click', _doSend);

function _doSend() {
  var task = _taskInput.value.trim();
  if (!task || _state === 'executing' || _state === 'planning') { return; }

  _resetFileList();
  document.getElementById('eventStream').innerHTML = '';
  document.getElementById('stepCount').textContent = 'Step 0';
  document.getElementById('elapsed').textContent = '0s';
  document.getElementById('resultPanel').hidden = true;

  setState('planning');
  post('chat', { prompt: task });
}

_stopBtn.addEventListener('click', function() {
  post('stopAgent', {});
  _stopTimer();
  setState('idle');
});

// ── Plan actions ──────────────────────────────────────────────────────────────

document.getElementById('approveBtn').addEventListener('click', function() {
  var steps = Array.from(document.querySelectorAll('[data-plan-step]'))
    .map(function(ta) { return ta.value.trim(); })
    .filter(function(s) { return s.length > 0; });
  setState('executing');
  post('planApprove', { steps: steps });
});

document.getElementById('modifyBtn').addEventListener('click', function() {
  var box    = document.getElementById('clarifyBox');
  var isOpen = box.classList.contains('visible');
  if (isOpen) {
    box.classList.remove('visible');
  } else {
    box.classList.add('visible');
    document.getElementById('clarifyInput').focus();
  }
});

document.getElementById('clarifySubmit').addEventListener('click', function() {
  var clarification = document.getElementById('clarifyInput').value.trim();
  if (!clarification) { return; }
  document.getElementById('clarifyBox').classList.remove('visible');
  setState('planning');
  post('planClarify', { clarification: clarification });
});

document.getElementById('clarifyCancel').addEventListener('click', function() {
  document.getElementById('clarifyBox').classList.remove('visible');
});

// ── New Task ─────────────────────────────────────────────────────────────────

document.getElementById('newTaskBtn').addEventListener('click', function() {
  _resetFileList();
  document.getElementById('eventStream').innerHTML = '';
  document.getElementById('taskInput').value = '';
  setState('idle');
  document.getElementById('taskInput').focus();
});

// ── Messages from extension ───────────────────────────────────────────────────

window.addEventListener('message', function(event) {
  var d = event.data;

  if (d.command === 'showOnboarding') {
    document.getElementById('onboarding').classList.add('visible');
    document.getElementById('app').style.display = 'none';
  }

  if (d.command === 'onboardingDone') {
    document.getElementById('onboarding').classList.remove('visible');
    document.getElementById('app').style.display = 'flex';
    setState('idle');
    document.getElementById('taskInput').focus();
  }

  if (d.command === 'showPlan' || d.command === 'showPlanUpdate') {
    showPlan(d);
  }

  if (d.command === 'agentEvent') {
    if (_state === 'executing') { appendEvent(d); }
  }

  if (d.command === 'chatDone') {
    _stopTimer();

    // Add any files from the result array not yet shown
    var files = d.files || [];
    files.forEach(function(f) { _addFileRow(String(f)); });

    var resultMsg   = document.getElementById('resultMsg');
    var resultStats = document.getElementById('resultStats');

    resultMsg.textContent = d.summary || (d.success ? 'Done.' : 'Task finished.');
    resultMsg.className   = d.success ? 'result-ok' : 'result-err';

    var s = Math.floor((d.elapsed || 0) / 1000);
    var timeText = s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's';
    resultStats.textContent = 'Steps: ' + (d.steps || '?') + '  |  Time: ' + timeText;

    setState('done');
  }

  if (d.command === 'chatError') {
    _stopTimer();
    document.getElementById('statusBar').textContent = '⚠️ ' + (d.msg || 'Error occurred.');
    setState('error');
  }

  if (d.command === 'unlockSend') {
    if (_state !== 'reviewing' && _state !== 'executing') {
      setState('idle');
    }
  }

  if (d.command === 'staticReady') {
    document.getElementById('statusBar').textContent = 'Preview opened: ' + (d.file || '');
  }

  if (d.command === 'elementSelected') {
    var lbl = d.label || d.selector || 'element';
    _taskInput.value = (_taskInput.value.trim() ? _taskInput.value.trim() + '\n' : '') +
      'Edit the ' + lbl + ': ';
    _taskInput.focus();
    post('clearElement', {});
  }

  if (d.command === 'filePicked') {
    if (d.file && d.file.content) {
      _taskInput.value =
        (_taskInput.value.trim() ? _taskInput.value.trim() + '\n\n' : '') +
        '```' + (d.file.name || 'file') + '\n' + d.file.content + '\n```';
    }
  }
});

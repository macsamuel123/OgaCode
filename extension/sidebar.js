// OgaCode sidebar — redesigned UI matching the prototype
var api = acquireVsCodeApi();
function post(cmd, data) { api.postMessage(Object.assign({ command: cmd }, data || {})); }

// ── State ─────────────────────────────────────────────────────────────────────
var _state = 'idle';          // idle|planning|reviewing|executing|done|paused|error
var _lastPrompt = '';

// Plan ladder
var _planSteps    = [];       // string[]
var _planActiveIdx = -1;      // which step is currently active (0-based), -1 = none
var _planDoneCount = 0;       // how many steps are fully done
var _planEl       = null;     // .oga-plan DOM node (for in-place updates)

// File strip
var _fileStripEl  = null;     // .oga-files DOM node
var _filesTracked = {};       // { path: { badge, hasDiff } }
var _fileDiffs    = {};       // { path: { stat, patch, isNew } }
var _currentFilePath = '';   // tracks path from pre_tool_use to post_tool_use

// Live tool call
var _activeToolRow = null;    // current in-progress .oga-toolcall DOM node

// History
var _chats = [];
var _activeId = '';
var _historyOpen = false;

// Counters
var _stepCount = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────────
var _taskInput   = document.getElementById('taskInput');
var _sendBtn     = document.getElementById('sendBtn');
var _stopBtn     = document.getElementById('stopBtn');
var _addFilesBtn = document.getElementById('addFilesBtn');

// ── Onboarding ────────────────────────────────────────────────────────────────
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

// ── Chat helpers ──────────────────────────────────────────────────────────────
function _chat() { return document.getElementById('chat'); }
function _scrollBottom() { var c = _chat(); c.scrollTop = c.scrollHeight; }

function _appendUserMsg(text) {
  var div = document.createElement('div');
  div.className = 'oga-msg-user';
  div.textContent = text;
  _chat().appendChild(div);
  _scrollBottom();
}

function _appendNarrativeText(text) {
  var div = document.createElement('div');
  div.className = 'oga-msg-agent';
  var p = document.createElement('p');
  p.textContent = text;
  div.appendChild(p);
  _chat().appendChild(div);
  _scrollBottom();
}

// ── Status pill ───────────────────────────────────────────────────────────────
function _updateStatusPill(state) {
  var label = document.getElementById('statusLabel');
  var dot   = document.getElementById('statusDot');
  dot.className = 'oga-dot';
  if (state === 'planning' || state === 'reviewing' || state === 'executing') {
    label.textContent = 'Working';
    dot.classList.add('live');
  } else if (state === 'paused') {
    label.textContent = 'Paused';
    dot.classList.add('paused');
  } else if (state === 'error') {
    label.textContent = 'Error';
    dot.classList.add('error');
  } else {
    label.textContent = 'Ready';
  }
}

// ── Plan ladder ───────────────────────────────────────────────────────────────
function _buildPlanLadder(showActions) {
  var n   = _planSteps.length || 1;
  var pct = Math.round((_planDoneCount / n) * 100);
  var r = 5.5, circ = 2 * Math.PI * r;

  var el = document.createElement('div');
  el.className = 'oga-plan';

  // ── Head ──
  var head = document.createElement('div');
  head.className = 'oga-plan-head';

  var titleDiv = document.createElement('div');
  titleDiv.className = 'oga-plan-title';
  titleDiv.innerHTML =
    '<span class="oga-progress-ring">' +
    '<svg width="13" height="13" viewBox="0 0 13 13">' +
    '<circle cx="6.5" cy="6.5" r="' + r + '" fill="none" stroke="#e0a23d" stroke-width="2"' +
    ' stroke-dasharray="' + circ.toFixed(1) + '"' +
    ' stroke-dashoffset="' + (circ - circ * pct / 100).toFixed(1) + '"' +
    ' stroke-linecap="round"/></svg></span>' +
    '<span>Plan</span>';

  var metaWrap = document.createElement('div');
  metaWrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
  var metaSpan = document.createElement('span');
  metaSpan.className = 'oga-plan-meta';
  metaSpan.textContent = _planDoneCount + '/' + _planSteps.length;
  var chevSpan = document.createElement('span');
  chevSpan.className = 'oga-chevron';
  chevSpan.textContent = '⌄'; // ⌄
  metaWrap.appendChild(metaSpan);
  metaWrap.appendChild(chevSpan);
  head.appendChild(titleDiv);
  head.appendChild(metaWrap);

  // ── Steps ──
  var stepsDiv = document.createElement('div');
  stepsDiv.className = 'oga-plan-steps';

  _planSteps.forEach(function(text, i) {
    var isDone   = i < _planDoneCount;
    var isActive = i === _planActiveIdx;
    var sc = isDone ? 'done' : (isActive ? 'active' : '');

    var step = document.createElement('div');
    step.className = 'oga-step' + (sc ? ' ' + sc : '');

    var rail = document.createElement('div');
    rail.className = 'oga-step-rail';
    var mark = document.createElement('div');
    mark.className = 'oga-step-mark' + (sc ? ' ' + sc : '');
    var line = document.createElement('div');
    line.className = 'line' + (isDone ? ' done' : '');
    rail.appendChild(mark);
    rail.appendChild(line);

    var stepText = document.createElement('div');
    stepText.className = 'oga-step-text';
    stepText.textContent = text;

    step.appendChild(rail);
    step.appendChild(stepText);
    stepsDiv.appendChild(step);
  });

  el.appendChild(head);
  el.appendChild(stepsDiv);

  // ── Collapse toggle ──
  head.addEventListener('click', function() {
    var showing = stepsDiv.style.display !== 'none';
    stepsDiv.style.display = showing ? 'none' : '';
    chevSpan.textContent = showing ? '⌃' : '⌄'; // ⌃ ⌄
  });

  // ── Approve / Modify (only during review) ──
  if (showActions) {
    var actionsDiv = document.createElement('div');
    actionsDiv.className = 'oga-plan-actions';

    var approveBtn = document.createElement('button');
    approveBtn.className = 'oga-btn-approve';
    approveBtn.textContent = '▶  Yes — run plan';
    approveBtn.addEventListener('click', function() {
      actionsDiv.style.display = 'none';
      document.getElementById('clarifyBox').classList.remove('visible');
      _state = 'executing';
      _planActiveIdx = 0;
      _planDoneCount = 0;
      _updatePlanLadder();
      _updateStatusPill('executing');
      _stopBtn.style.display = '';
      _sendBtn.classList.add('disabled');
      post('planApprove', { steps: _planSteps });
    });

    var modifyBtn = document.createElement('button');
    modifyBtn.className = 'oga-btn-modify';
    modifyBtn.textContent = '✗  Modify';
    modifyBtn.addEventListener('click', function() {
      var box = document.getElementById('clarifyBox');
      if (box.classList.contains('visible')) {
        box.classList.remove('visible');
      } else {
        box.classList.add('visible');
        document.getElementById('clarifyInput').focus();
      }
    });

    actionsDiv.appendChild(approveBtn);
    actionsDiv.appendChild(modifyBtn);
    el.appendChild(actionsDiv);
  }

  return el;
}

function _updatePlanLadder() {
  if (!_planEl || !_planEl.parentNode) { return; }
  var next = _buildPlanLadder(_state === 'reviewing');
  _planEl.parentNode.replaceChild(next, _planEl);
  _planEl = next;
}

// ── File strip ────────────────────────────────────────────────────────────────
function _ensureFileStrip() {
  if (_fileStripEl) { return; }
  var label = document.createElement('div');
  label.className = 'oga-section-label';
  label.id = 'fileStripLabel';
  label.textContent = 'Files touched';
  _chat().appendChild(label);

  _fileStripEl = document.createElement('div');
  _fileStripEl.className = 'oga-files';
  _fileStripEl.id = 'fileStrip';
  _chat().appendChild(_fileStripEl);
  _scrollBottom();
}

function _fileExt(path) {
  var name = String(path).replace(/\\/g, '/').split('/').pop() || '';
  var dot  = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function _fileIconMeta(path) {
  var ext = _fileExt(path);
  if (ext === 'py')                     { return { cls: 'py',   txt: 'PY' }; }
  if (ext === 'ts' || ext === 'tsx')    { return { cls: 'ts',   txt: 'TS' }; }
  if (ext === 'js' || ext === 'jsx')    { return { cls: 'js',   txt: 'JS' }; }
  if (ext === 'json' || ext === 'toml') { return { cls: 'json', txt: '{}' }; }
  return { cls: 'gen', txt: '◻' };
}

function _findFileRow(filePath) {
  if (!_fileStripEl) { return null; }
  var rows = _fileStripEl.querySelectorAll('.oga-file-row');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].dataset.filePath === filePath) { return rows[i]; }
  }
  return null;
}

function _buildFileRow(filePath, badge, diffStat, hasDiff) {
  var p    = String(filePath).replace(/\\/g, '/');
  var name = p.split('/').pop() || filePath;
  var dir  = p.lastIndexOf('/') > 0 ? p.slice(0, p.lastIndexOf('/') + 1) : '';
  var meta = _fileIconMeta(filePath);

  var row = document.createElement('div');
  row.className = 'oga-file-row';
  row.dataset.filePath = filePath;
  if (hasDiff) { row.title = 'Click to view diff'; }

  var left = document.createElement('div');
  left.className = 'oga-file-left';

  var icon = document.createElement('div');
  icon.className = 'oga-file-icon ' + meta.cls;
  icon.textContent = meta.txt;

  var nameWrap = document.createElement('div');
  nameWrap.style.minWidth = '0';
  var nameEl = document.createElement('div');
  nameEl.className = 'oga-file-name';
  nameEl.textContent = name;
  var pathEl = document.createElement('div');
  pathEl.className = 'oga-file-path';
  pathEl.textContent = dir;
  nameWrap.appendChild(nameEl);
  nameWrap.appendChild(pathEl);

  left.appendChild(icon);
  left.appendChild(nameWrap);
  row.appendChild(left);

  if (diffStat) {
    var statEl = document.createElement('div');
    statEl.className = 'oga-diff-stat';
    (diffStat.split(' ')).forEach(function(part) {
      var sp = document.createElement('span');
      sp.className = part.startsWith('+') ? 'add' : 'rem';
      sp.textContent = part;
      statEl.appendChild(sp);
    });
    row.appendChild(statEl);
  } else {
    var badgeEl = document.createElement('span');
    badgeEl.className = 'oga-file-badge ' + (badge || 'reading');
    badgeEl.textContent = badge === 'created' ? 'new'
                        : badge === 'edited'  ? 'edited'
                        : 'reading…';
    row.appendChild(badgeEl);
  }

  if (hasDiff) {
    row.addEventListener('click', function() { _showDiffView(filePath); });
  }
  return row;
}

function _addFileToStrip(filePath, badge) {
  _ensureFileStrip();
  if (_filesTracked[filePath]) { return; }
  _filesTracked[filePath] = { badge: badge, hasDiff: false };
  _fileStripEl.appendChild(_buildFileRow(filePath, badge, null, false));
  _scrollBottom();
}

function _updateFileRow(filePath, badge, diffStat, hasDiff) {
  if (!_fileStripEl) { return; }
  _filesTracked[filePath] = { badge: badge, hasDiff: hasDiff };
  var existing = _findFileRow(filePath);
  var next = _buildFileRow(filePath, badge, diffStat, hasDiff);
  if (existing) {
    _fileStripEl.replaceChild(next, existing);
  } else {
    _fileStripEl.appendChild(next);
  }
}

// ── Diff view ─────────────────────────────────────────────────────────────────
function _parseUnifiedDiff(patch) {
  return (patch || '').split('\n')
    .filter(function(l) { return !/^(---|\+\+\+|@@)/.test(l); })
    .map(function(l) {
      if (l.startsWith('+')) { return { type: 'add', text: l.slice(1) }; }
      if (l.startsWith('-')) { return { type: 'rem', text: l.slice(1) }; }
      return { type: 'ctx', text: l.slice(1) };
    });
}

function _showDiffView(filePath) {
  var diff = _fileDiffs[filePath];
  if (!diff) { return; }

  var label = document.getElementById('fileStripLabel');
  var strip = document.getElementById('fileStrip');
  if (label) { label.style.display = 'none'; }
  if (strip) { strip.style.display = 'none'; }

  var existing = document.getElementById('diffView');
  if (existing) { existing.parentNode.removeChild(existing); }

  var p    = String(filePath).replace(/\\/g, '/');
  var name = p.split('/').pop() || filePath;
  var lines = _parseUnifiedDiff(diff.patch);

  var view = document.createElement('div');
  view.className = 'oga-diff-view';
  view.id = 'diffView';

  // Header
  var hdr = document.createElement('div');
  hdr.className = 'oga-diff-header';

  var back = document.createElement('span');
  back.className = 'oga-diff-back';
  back.textContent = '← Files';
  back.addEventListener('click', function() {
    view.parentNode.removeChild(view);
    if (label) { label.style.display = ''; }
    if (strip) { strip.style.display = ''; }
  });

  var hdrName = document.createElement('span');
  hdrName.textContent = name + (diff.stat ? '  ' + diff.stat : '');
  hdrName.style.fontFamily = 'var(--mono)';
  hdrName.style.fontSize = '11px';

  var openLink = document.createElement('span');
  openLink.textContent = 'Open ↗';
  openLink.style.cssText = 'cursor:pointer;color:var(--accent);font-size:10px;';
  openLink.addEventListener('click', function() { post('openFile', { filePath: filePath }); });

  hdr.appendChild(back);
  hdr.appendChild(hdrName);
  hdr.appendChild(openLink);
  view.appendChild(hdr);

  if (diff.is_new) {
    var newTag = document.createElement('div');
    newTag.style.cssText = 'padding:3px 10px;font-size:10px;color:var(--green);font-family:var(--mono);';
    newTag.textContent = '(new file)';
    view.appendChild(newTag);
  }

  var visible = lines.slice(0, 200);
  visible.forEach(function(l) {
    var lineEl = document.createElement('div');
    lineEl.className = 'oga-diff-line ' + l.type;
    lineEl.textContent = l.text;
    view.appendChild(lineEl);
  });
  if (lines.length > 200) {
    var more = document.createElement('div');
    more.className = 'oga-diff-line ctx';
    more.style.opacity = '.5';
    more.textContent = '  … ' + (lines.length - 200) + ' more lines';
    view.appendChild(more);
  }

  if (strip && strip.nextSibling) {
    _chat().insertBefore(view, strip.nextSibling);
  } else {
    _chat().appendChild(view);
  }
  _scrollBottom();
}

// ── Tool call rows ────────────────────────────────────────────────────────────
var _TOOL_VERBS = {
  'file_edit':      'Editing',
  'bash_exec':      'Running',
  'ripgrep_search': 'Searching',
  'test_runner':    'Testing',
  'git_ops':        'Git',
  'web_search':     'Searching web',
};

function _appendToolCallRow(tool, target) {
  var row = document.createElement('div');
  row.className = 'oga-toolcall';

  var verb = document.createElement('span');
  verb.className = 'verb';
  verb.textContent = _TOOL_VERBS[tool] || tool;

  var tgt = document.createElement('span');
  tgt.className = 'target';
  tgt.textContent = target ? ' ' + target : '';

  var cursor = document.createElement('span');
  cursor.className = 'oga-cursor-blink';

  row.appendChild(verb);
  row.appendChild(tgt);
  row.appendChild(cursor);
  _chat().appendChild(row);
  _scrollBottom();
  return row;
}

function _finalizeToolRow(row, success) {
  if (!row) { return; }
  var cursor = row.querySelector('.oga-cursor-blink');
  if (cursor) { row.removeChild(cursor); }
  var status = document.createElement('span');
  status.className = 'status ' + (success ? 'ok' : 'err');
  status.textContent = ' ' + (success ? '✓' : '✗');
  row.appendChild(status);
}

// ── Paused card ───────────────────────────────────────────────────────────────
function _renderPausedCard(stepsDone, stepsTotal) {
  var card = document.createElement('div');
  card.className = 'oga-pause-card';

  var title = document.createElement('div');
  title.className = 'oga-pause-title';
  title.textContent = '⏸ Paused at step ' + stepsDone + ' of ' + stepsTotal;

  var body = document.createElement('div');
  body.className = 'oga-pause-body';
  body.textContent =
    "This task hit the step limit for a single run. Nothing’s broken — " +
    "your progress is checkpointed. Continue from where it left off.";

  var actions = document.createElement('div');
  actions.className = 'oga-pause-actions';

  var contBtn = document.createElement('button');
  contBtn.className = 'oga-btn-primary';
  contBtn.textContent = 'Continue task';
  contBtn.addEventListener('click', function() {
    _taskInput.value = _lastPrompt;
    _taskInput.dispatchEvent(new Event('input'));
    _taskInput.focus();
  });

  var reviewBtn = document.createElement('button');
  reviewBtn.className = 'oga-btn-secondary';
  reviewBtn.textContent = 'Review changes';
  reviewBtn.addEventListener('click', function() {
    var strip = document.getElementById('fileStrip');
    if (strip) { strip.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  });

  actions.appendChild(contBtn);
  actions.appendChild(reviewBtn);
  card.appendChild(title);
  card.appendChild(body);
  card.appendChild(actions);
  _chat().appendChild(card);
  _scrollBottom();
}

// ── History popover ───────────────────────────────────────────────────────────
function _relativeTime(isoStr) {
  if (!isoStr) { return ''; }
  var ms = Date.now() - new Date(isoStr).getTime();
  if (isNaN(ms)) { return ''; }
  var m = Math.floor(ms / 60000);
  if (m < 2)  { return 'now'; }
  if (m < 60) { return m + 'm'; }
  var h = Math.floor(m / 60);
  if (h < 24) { return h + 'h'; }
  return Math.floor(h / 24) + 'd';
}

function _dayGroup(isoStr) {
  if (!isoStr) { return 'Earlier'; }
  var d    = new Date(isoStr);
  var now  = new Date();
  var diff = Math.floor(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
     Date.UTC(d.getFullYear(),   d.getMonth(),   d.getDate())) / 86400000
  );
  if (diff === 0) { return 'Today'; }
  if (diff === 1) { return 'Yesterday'; }
  return 'Earlier';
}

function _renderHistoryPopover(chats, filter) {
  var list = document.getElementById('historyList');
  if (!list) { return; }
  list.innerHTML = '';

  var items = filter
    ? chats.filter(function(c) {
        return (c.name || '').toLowerCase().includes(filter.toLowerCase());
      })
    : chats;

  if (!items.length) {
    var empty = document.createElement('div');
    empty.className = 'oga-history-empty';
    empty.textContent = filter ? 'No conversations match.' : 'No previous conversations yet.';
    list.appendChild(empty);
    return;
  }

  var groups = ['Today', 'Yesterday', 'Earlier'];
  var grouped = {};
  items.forEach(function(c) {
    var g = _dayGroup(c.updatedAt || c.createdAt);
    if (!grouped[g]) { grouped[g] = []; }
    grouped[g].push(c);
  });

  groups.forEach(function(g) {
    if (!grouped[g] || !grouped[g].length) { return; }

    var glabel = document.createElement('div');
    glabel.className = 'oga-history-group-label';
    glabel.textContent = g;
    list.appendChild(glabel);

    grouped[g].forEach(function(c) {
      var isCurrent = (c.id === _activeId);
      var item = document.createElement('div');
      item.className = 'oga-history-item' + (isCurrent ? ' current' : '');

      var dot = document.createElement('div');
      dot.className = 'oga-history-dot ' + (isCurrent ? 'live' : 'done');

      var text = document.createElement('div');
      text.className = 'oga-history-text';

      var titleEl = document.createElement('div');
      titleEl.className = 'oga-history-title';
      titleEl.textContent = (c.name || 'Untitled').slice(0, 60);

      var snip = document.createElement('div');
      snip.className = 'oga-history-snippet';
      snip.textContent = (c.snippet || '').slice(0, 80);

      text.appendChild(titleEl);
      text.appendChild(snip);

      var time = document.createElement('div');
      time.className = 'oga-history-time';
      time.textContent = _relativeTime(c.updatedAt || c.createdAt);

      item.appendChild(dot);
      item.appendChild(text);
      item.appendChild(time);

      item.addEventListener('click', function() {
        _closeHistory();
        post('switchChat', { id: c.id });
      });

      list.appendChild(item);
    });
  });
}

function _filterHistoryList(query) {
  _renderHistoryPopover(_chats, query);
}

function _closeHistory() {
  _historyOpen = false;
  document.getElementById('historyOverlay').style.display = 'none';
}

// ── History wiring ────────────────────────────────────────────────────────────
document.getElementById('historyBtn').addEventListener('click', function() {
  _historyOpen = true;
  document.getElementById('historyOverlay').style.display = '';
  _renderHistoryPopover(_chats, '');
  post('requestChatHistory', {});
});
document.getElementById('historyBackdrop').addEventListener('click', _closeHistory);
document.getElementById('newChatBtn').addEventListener('click', function() {
  _closeHistory();
  post('newChat', {});
});
document.getElementById('historySearch').addEventListener('input', function(e) {
  _filterHistoryList(e.target.value);
});

// ── File chips ────────────────────────────────────────────────────────────────
function _addFileChip(id, name) {
  var chips = document.getElementById('fileChips');
  var chip = document.createElement('div');
  chip.className = 'oga-chip';
  chip.dataset.fileId = id;

  var nameSpan = document.createElement('span');
  nameSpan.textContent = '📄 ' + (name.length > 22 ? name.slice(0, 22) + '…' : name);
  nameSpan.title = name;

  var x = document.createElement('span');
  x.className = 'x';
  x.textContent = '×';
  x.title = 'Remove';
  x.addEventListener('click', function() { post('removeFile', { id: id }); });

  chip.appendChild(nameSpan);
  chip.appendChild(x);
  chips.appendChild(chip);
}

function _removeFileChip(id) {
  var chip = document.querySelector('[data-file-id="' + id + '"]');
  if (chip) { chip.parentNode.removeChild(chip); }
}

function _clearFileChips() {
  document.getElementById('fileChips').innerHTML = '';
}

_addFilesBtn.addEventListener('click', function() { post('fileUploadPick', {}); });

// ── Input / send ──────────────────────────────────────────────────────────────
_taskInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

_taskInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _doSend(); }
});

_sendBtn.addEventListener('click', function() {
  if (_sendBtn.classList.contains('disabled')) { return; }
  _doSend();
});

function _doSend() {
  var task = _taskInput.value.trim();
  if (!task || _state === 'executing' || _state === 'planning' || _state === 'reviewing') { return; }

  _lastPrompt    = task;
  _planSteps     = [];
  _planActiveIdx = -1;
  _planDoneCount = 0;
  _planEl        = null;
  _fileStripEl   = null;
  _filesTracked  = {};
  _fileDiffs     = {};
  _activeToolRow = null;
  _currentFilePath = '';
  _stepCount     = 0;

  _taskInput.value = '';
  _taskInput.style.height = 'auto';

  _state = 'planning';
  _sendBtn.classList.add('disabled');
  _updateStatusPill('planning');

  _chat().innerHTML = '';
  _appendUserMsg(task);
  post('chat', { prompt: task });
}

_stopBtn.addEventListener('click', function() {
  post('stopAgent', {});
  _activeToolRow = null;
  _state = 'idle';
  _sendBtn.classList.remove('disabled');
  _stopBtn.style.display = 'none';
  _updateStatusPill('idle');

  var card = document.createElement('div');
  card.className = 'oga-error-card';
  card.innerHTML = '<div class="oga-error-title">Stopped</div>Task stopped by user.';
  _chat().appendChild(card);
  _scrollBottom();
});

// ── Plan clarify ──────────────────────────────────────────────────────────────
document.getElementById('clarifySubmit').addEventListener('click', function() {
  var clarification = document.getElementById('clarifyInput').value.trim();
  if (!clarification) { return; }
  document.getElementById('clarifyBox').classList.remove('visible');
  document.getElementById('clarifyInput').value = '';
  if (_planEl && _planEl.parentNode) {
    _planEl.parentNode.removeChild(_planEl);
    _planEl = null;
  }
  _state = 'planning';
  _updateStatusPill('planning');
  post('planClarify', { clarification: clarification });
});

document.getElementById('clarifyCancel').addEventListener('click', function() {
  document.getElementById('clarifyBox').classList.remove('visible');
});

// ── showPlan ──────────────────────────────────────────────────────────────────
function showPlan(d) {
  _planSteps = (d.steps || []).map(function(s) { return String(s).trim(); }).filter(Boolean);
  _planActiveIdx = -1;
  _planDoneCount = 0;
  _state = 'reviewing';
  _updateStatusPill('reviewing');
  _planEl = _buildPlanLadder(true);
  _chat().appendChild(_planEl);
  _scrollBottom();
}

// ── Messages from extension ───────────────────────────────────────────────────
window.addEventListener('message', function(event) {
  var d = event.data;

  // Onboarding
  if (d.command === 'showOnboarding') {
    document.getElementById('onboarding').classList.add('visible');
    document.getElementById('app').style.display = 'none';
  }
  if (d.command === 'onboardingDone') {
    document.getElementById('onboarding').classList.remove('visible');
    document.getElementById('app').style.display = 'flex';
    _updateStatusPill('idle');
    _taskInput.focus();
  }

  // Plan
  if (d.command === 'showPlan' || d.command === 'showPlanUpdate') {
    showPlan(d);
  }

  // Agent events
  if (d.command === 'agentEvent') {
    if (_state !== 'executing') { return; }

    if (d.type === 'pre_tool_use') {
      var path = (d.args || {}).path || '';
      var target = path
        ? String(path).replace(/\\/g, '/').split('/').pop()
        : ((d.args || {}).command || '').slice(0, 40);

      if (d.tool === 'file_edit' && path) {
        _currentFilePath = path;
        _addFileToStrip(path, 'reading');
      }
      _activeToolRow = _appendToolCallRow(d.tool, target);
    }

    if (d.type === 'post_tool_use') {
      _finalizeToolRow(_activeToolRow, d.success);
      _activeToolRow = null;

      if (d.tool === 'file_edit' && _currentFilePath) {
        var fp = _currentFilePath;
        _currentFilePath = '';
        if (d.success && d.diff) {
          _fileDiffs[fp] = d.diff;
          var badge = d.diff.is_new ? 'created' : 'edited';
          _updateFileRow(fp, badge, d.diff.stat, true);
          // Advance plan step on each successful file edit
          if (_planActiveIdx < _planSteps.length - 1) {
            _planDoneCount = _planActiveIdx + 1;
            _planActiveIdx = _planDoneCount;
          } else if (_planActiveIdx >= 0) {
            _planDoneCount = _planActiveIdx + 1;
          }
          _updatePlanLadder();
        } else if (!d.success) {
          _updateFileRow(fp, 'reading', null, false);
        }
      }
    }

    if (d.type === 'narrative') {
      _appendNarrativeText(d.text || '');
    }

    if (d.type === 'correction') {
      var corrRow = document.createElement('div');
      corrRow.className = 'oga-toolcall';
      corrRow.style.opacity = '.55';
      corrRow.innerHTML = '<span class="verb">↺</span> <span class="target">retrying…</span>';
      _chat().appendChild(corrRow);
      _scrollBottom();
    }

    if (d.type === 'thinking') {
      _stepCount = d.step || _stepCount;
    }
  }

  // Done
  if (d.command === 'chatDone') {
    _activeToolRow = null;
    _state = 'done';
    _sendBtn.classList.remove('disabled');
    _stopBtn.style.display = 'none';
    _updateStatusPill('done');

    _planDoneCount = _planSteps.length;
    _planActiveIdx = -1;
    _updatePlanLadder();
    // Collapse plan steps
    if (_planEl) {
      var steps = _planEl.querySelector('.oga-plan-steps');
      var chev  = _planEl.querySelector('.oga-chevron');
      if (steps) { steps.style.display = 'none'; }
      if (chev)  { chev.textContent = '⌃'; }
    }

    var summary = document.createElement('div');
    summary.className = 'oga-done-summary';
    summary.textContent = d.summary || 'Task complete.';
    _chat().appendChild(summary);
    _scrollBottom();
  }

  // Paused
  if (d.command === 'chatPaused') {
    _activeToolRow = null;
    _state = 'paused';
    _sendBtn.classList.remove('disabled');
    _stopBtn.style.display = 'none';
    _updateStatusPill('paused');
    _planDoneCount = d.stepsDone || _stepCount;
    _updatePlanLadder();
    _renderPausedCard(d.stepsDone || _stepCount, d.stepsTotal || _planSteps.length || 10);
  }

  // Error
  if (d.command === 'chatError') {
    _activeToolRow = null;
    _state = 'error';
    _sendBtn.classList.remove('disabled');
    _stopBtn.style.display = 'none';
    _updateStatusPill('error');

    var errCard = document.createElement('div');
    errCard.className = 'oga-error-card';
    var errTitle = document.createElement('div');
    errTitle.className = 'oga-error-title';
    errTitle.textContent = 'Error';
    var errMsg = document.createElement('div');
    errMsg.textContent = d.msg || 'Something went wrong. Try again.';
    errCard.appendChild(errTitle);
    errCard.appendChild(errMsg);
    _chat().appendChild(errCard);
    _scrollBottom();
  }

  // History
  if (d.command === 'chatHistory') {
    _chats = d.chats || [];
    _activeId = d.activeId || '';
    if (_historyOpen) {
      _renderHistoryPopover(_chats, document.getElementById('historySearch').value);
    }
  }

  if (d.command === 'restoreChat') {
    _chat().innerHTML = '';
    _planEl = null; _fileStripEl = null;
    (d.turns || []).forEach(function(t) {
      var el = document.createElement('div');
      if (t.role === 'user') {
        el.className = 'oga-msg-user';
        el.textContent = t.content || '';
      } else {
        el.className = 'oga-msg-agent';
        var p = document.createElement('p');
        p.textContent = t.content || '';
        el.appendChild(p);
      }
      _chat().appendChild(el);
    });
    _state = 'idle';
    _updateStatusPill('idle');
    _sendBtn.classList.remove('disabled');
    _stopBtn.style.display = 'none';
    _scrollBottom();
  }

  // New chat
  if (d.command === 'resetToIdle') {
    _resetChat();
  }

  // Unlock send
  if (d.command === 'unlockSend') {
    if (_state !== 'reviewing' && _state !== 'executing') {
      _state = 'idle';
      _sendBtn.classList.remove('disabled');
      _updateStatusPill('idle');
    }
  }

  // File attachments
  if (d.command === 'fileAdded')   { _addFileChip(d.id, d.name); }
  if (d.command === 'fileRemoved') { _removeFileChip(d.id); }
  if (d.command === 'fileClearAll') {
    _filesTracked = {};
    _fileDiffs    = {};
    _clearFileChips();
  }
  if (d.command === 'fileError') {
    var feCard = document.createElement('div');
    feCard.className = 'oga-error-card';
    feCard.innerHTML =
      '<div class="oga-error-title">Attachment Error</div>' +
      (d.msg || 'Could not attach file.');
    _chat().appendChild(feCard);
    _scrollBottom();
  }

  // Legacy: preview / element selection
  if (d.command === 'staticReady') {
    var infoDiv = document.createElement('div');
    infoDiv.className = 'oga-msg-agent';
    infoDiv.innerHTML = '<p>Opened: <code>' + (d.file || '') + '</code></p>';
    _chat().appendChild(infoDiv);
    _scrollBottom();
  }
  if (d.command === 'elementSelected') {
    var lbl = d.label || d.selector || 'element';
    _taskInput.value = (_taskInput.value.trim() ? _taskInput.value.trim() + '\n' : '') +
      'Edit the ' + lbl + ': ';
    _taskInput.focus();
    post('clearElement', {});
  }
});

// ── Reset ─────────────────────────────────────────────────────────────────────
function _resetChat() {
  _activeToolRow   = null;
  _planEl          = null;
  _fileStripEl     = null;
  _filesTracked    = {};
  _fileDiffs       = {};
  _planSteps       = [];
  _planActiveIdx   = -1;
  _planDoneCount   = 0;
  _currentFilePath = '';
  _stepCount       = 0;
  _state           = 'idle';
  _lastPrompt      = '';
  _sendBtn.classList.remove('disabled');
  _stopBtn.style.display = 'none';
  _updateStatusPill('idle');
  document.getElementById('clarifyBox').classList.remove('visible');
  document.getElementById('chat').innerHTML = '';
  _taskInput.value = '';
  _taskInput.style.height = 'auto';
  _taskInput.focus();
  _clearFileChips();
}

// Hide the "JS not running" diagnostic banner — presence of this line proves JS loaded.
var _jd = document.getElementById('jsdiag');
if (_jd) { _jd.style.display = 'none'; }

/* ── Onboarding ── */
var _onboarding   = document.getElementById('onboarding');
var _tokenInput   = document.getElementById('tokenInput');
var _activateBtn  = document.getElementById('activateBtn');
var _onboardErr   = document.getElementById('onboardErr');

_activateBtn.addEventListener('click', function() {
  var t = _tokenInput.value.trim();
  if (!t) { _onboardErr.textContent = 'Please enter your access code.'; _onboardErr.style.display = 'block'; return; }
  _activateBtn.disabled = true;
  _activateBtn.textContent = 'Activating…';
  api.postMessage({ command: 'saveToken', token: t });
});
_tokenInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { _activateBtn.click(); }
});

var api            = acquireVsCodeApi();
    var thread         = document.getElementById('thread');
    var inp            = document.getElementById('inp');
    var sendbtn        = document.getElementById('sendbtn');
    var prevbtn        = document.getElementById('prevbtn');
    var runbtn         = document.getElementById('runbtn');
    var expobtn        = document.getElementById('expobtn');
    var deploybtn      = document.getElementById('deploybtn');
    var deployStatus   = document.getElementById('deployStatus');
    var newchatbtn     = document.getElementById('newchatbtn');
    var memorybtn      = document.getElementById('memorybtn');
    var memPanel       = document.getElementById('memoryPanel');
    var historyBtn     = document.getElementById('historyBtn');
    var historyDropdown = document.getElementById('historyDropdown');
    var memPrd      = document.getElementById('memPrd');
    var memRules    = document.getElementById('memRules');
    var memSkills   = document.getElementById('memSkills');
    var uploadPrd   = document.getElementById('uploadPrd');
    var uploadRules = document.getElementById('uploadRules');
    var uploadSkills= document.getElementById('uploadSkills');
    var saveMemBtn  = document.getElementById('saveMemBtn');

    var elementChip      = document.getElementById('elementChip');
    var elementChipLabel = document.getElementById('elementChipLabel');
    var clearElementBtn  = document.getElementById('clearElement');

    clearElementBtn.addEventListener('click', function() {
      elementChip.style.display = 'none';
      inp.placeholder = 'Ask me anything\u2026 Paste a design screenshot to match it exactly.';
      api.postMessage({ command: 'clearElement' });
    });

    var currentBot = null;  // the bot message being built right now
    var runnerStarted = false; // true once the first agentEvent arrives
    var pendingImage = null;  // base64 data URL of pasted screenshot
    var activeChatId = null;
    var stopbtn = document.getElementById('stopbtn');

    stopbtn.addEventListener('click', function() {
      api.postMessage({ command: 'stopAgent' });
      stopbtn.classList.remove('visible');
      sendbtn.disabled = false;
      finishBotMsg('Interrupted.', true);
    });

    /* \u2500\u2500 History dropdown helpers \u2500\u2500 */
    function renderChatList(chats, activeId) {
      activeChatId = activeId;
      historyDropdown.innerHTML = '';
      var groups = {};
      chats.forEach(function(c) { (groups[c.project] = groups[c.project] || []).push(c); });
      Object.keys(groups).forEach(function(proj) {
        var lbl = document.createElement('div');
        lbl.className = 'hd-proj'; lbl.textContent = proj;
        historyDropdown.appendChild(lbl);
        groups[proj].forEach(function(c) { historyDropdown.appendChild(makeChatItem(c, activeId)); });
      });
      var newRow = document.createElement('div');
      newRow.className = 'hd-item hd-new';
      newRow.innerHTML = '<span class="hd-name">&#65291; New Chat</span>';
      newRow.addEventListener('click', function() {
        historyDropdown.style.display = 'none';
        api.postMessage({ command: 'newChat' });
      });
      historyDropdown.appendChild(newRow);
    }

    function makeChatItem(c, activeId) {
      var el = document.createElement('div');
      el.className = 'hd-item' + (c.id === activeId ? ' active' : '');

      function renderNormal() {
        el.innerHTML =
          '<span class="hd-name">' + esc(c.name) + '</span>' +
          '<span class="hd-actions">' +
          '<button class="icon-btn" style="width:18px;height:18px;font-size:10px" title="Rename">&#9998;</button>' +
          '<button class="icon-btn" style="width:18px;height:18px;font-size:10px" title="Delete">&#128465;</button>' +
          '</span>';
        el.querySelector('.hd-name').addEventListener('click', function() {
          historyDropdown.style.display = 'none';
          api.postMessage({ command: 'switchChat', prompt: c.id });
        });
        var btns = el.querySelectorAll('.icon-btn');
        btns[0].addEventListener('click', function(e) { e.stopPropagation(); renderRename(); });
        btns[1].addEventListener('click', function(e) { e.stopPropagation(); renderConfirmDelete(); });
      }

      function renderRename() {
        el.innerHTML =
          '<input class="hd-rename-input" value="' + esc(c.name) + '" style="flex:1;min-width:0;' +
          'background:var(--vscode-input-background);color:var(--vscode-input-foreground);' +
          'border:1px solid var(--vscode-input-border,#555);padding:2px 4px;font:inherit;font-size:11px;">' +
          '<button class="icon-btn" style="width:20px;height:18px;font-size:10px" title="Save">&#10003;</button>' +
          '<button class="icon-btn" style="width:20px;height:18px;font-size:10px" title="Cancel">&#10005;</button>';
        var input = el.querySelector('.hd-rename-input');
        var savebtn = el.querySelectorAll('.icon-btn')[0];
        var cancelbtn = el.querySelectorAll('.icon-btn')[1];
        input.focus(); input.select();
        function doSave() {
          var newName = input.value.trim();
          if (newName && newName !== c.name) {
            c.name = newName;
            api.postMessage({ command: 'renameChat', prompt: c.id, slot: newName });
          }
          renderNormal();
        }
        savebtn.addEventListener('mousedown', function(e) { e.preventDefault(); });
        cancelbtn.addEventListener('mousedown', function(e) { e.preventDefault(); });
        savebtn.addEventListener('click', function(e) { e.stopPropagation(); doSave(); });
        cancelbtn.addEventListener('click', function(e) { e.stopPropagation(); renderNormal(); });
        input.addEventListener('blur', function() { renderNormal(); });
        input.addEventListener('keydown', function(e) {
          e.stopPropagation();
          if (e.key === 'Enter') { doSave(); }
          if (e.key === 'Escape') { renderNormal(); }
        });
      }

      function renderConfirmDelete() {
        el.innerHTML =
          '<span style="flex:1;font-size:10px;opacity:.75;">Delete “' + esc(c.name.slice(0, 20)) + '”?</span>' +
          '<button class="icon-btn" style="width:28px;height:18px;font-size:10px;color:#f88;" title="Confirm delete">Yes</button>' +
          '<button class="icon-btn" style="width:24px;height:18px;font-size:10px;" title="Cancel">No</button>';
        el.querySelectorAll('.icon-btn')[0].addEventListener('click', function(e) {
          e.stopPropagation();
          api.postMessage({ command: 'deleteChat', prompt: c.id });
        });
        el.querySelectorAll('.icon-btn')[1].addEventListener('click', function(e) {
          e.stopPropagation();
          renderNormal();
        });
      }

      renderNormal();
      return el;
    }

    function repopulateThread(turns, chatName) {
      thread.innerHTML = '';
      if (!turns || !turns.length) {
        thread.innerHTML = '<div class="msg bot"><div class="bubble">Hey! I&#39;m OgaCode. Tell me what to build or fix.</div></div>';
      } else {
        turns.forEach(function(t) {
          if (t.role === 'user') { addUserMsg(t.content, null); }
          else {
            var el = document.createElement('div');
            el.className = 'msg bot';
            el.innerHTML = '<div class="bubble">' + mdToHtml(t.content) + '</div><div class="activity"></div><div class="files"></div>';
            thread.appendChild(el);
          }
        });
      }
      if (chatName) { historyBtn.textContent = chatName + ' \u25BE'; }
      scrollBottom();
    }

    historyBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var open = historyDropdown.style.display === 'none' || historyDropdown.style.display === '';
      historyDropdown.style.display = open ? 'block' : 'none';
      if (open) { api.postMessage({ command: 'listChats' }); }
    });

    document.addEventListener('click', function(e) {
      if (!historyBtn.contains(e.target) && !historyDropdown.contains(e.target)) {
        historyDropdown.style.display = 'none';
      }
    });

    /* \u2500\u2500 Image paste \u2500\u2500 */
    var imagePreview = document.getElementById('imagePreview');
    var previewImg   = document.getElementById('previewImg');
    var removeImg    = document.getElementById('removeImg');

    inp.addEventListener('paste', function(e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) { return; }
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          e.preventDefault();
          var file = items[i].getAsFile();
          var reader = new FileReader();
          reader.onload = function(ev) {
            pendingImage = ev.target.result;
            previewImg.src = pendingImage;
            imagePreview.style.display = 'block';
          };
          reader.readAsDataURL(file);
          break;
        }
      }
    });

    removeImg.addEventListener('click', function() {
      pendingImage = null;
      previewImg.src = '';
      imagePreview.style.display = 'none';
    });

    /* \u2500\u2500 Helpers \u2500\u2500 */
    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function mdToHtml(text) {
      var s = esc(text);
      s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      s = s.replace(/^#{1,3} (.+)$/gm, '<b>$1</b>');
      s = s.replace(/\n/g, '<br>');
      return s;
    }

    function scrollBottom() { thread.scrollTop = thread.scrollHeight; }

    function addUserMsg(text, imgSrc) {
      var el = document.createElement('div');
      el.className = 'msg user';
      var imgHtml = imgSrc ? '<img src="' + imgSrc + '" alt="screenshot">' : '';
      el.innerHTML = '<div class="bubble">' + imgHtml + esc(text) + '</div>';
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
      if (ev.type === 'thinking')     { return 'Thinking\u2026 (step ' + ev.step + ')'; }
      if (ev.type === 'provider')     { return 'Using ' + ev.name; }
      if (ev.type === 'pre_tool_use') {
        var args = ev.args || {};
        var parts = Object.keys(args).map(function(k) {
          var v = String(args[k]);
          return k + ': ' + (v.length > 50 ? v.slice(0, 50) + '\u2026' : v);
        });
        return ev.tool + '(' + parts.join(', ') + ')';
      }
      if (ev.type === 'post_tool_use' && !ev.success) { return 'Error: ' + ev.error; }
      if (ev.type === 'correction') { return 'Retrying: ' + ev.msg; }
      if (ev.type === 'supervisor') { return 'Reviewing: ' + ev.msg; }
      if (ev.type === 'escalate')   { return 'Need input: ' + ev.msg; }
      return '';
    }

    /* \u2500\u2500 Send \u2500\u2500 */
    var sendTimer = null;
    function unlockSend() {
      sendbtn.disabled = false;
      stopbtn.classList.remove('visible');
      if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    }

    function send() {
      if (sendbtn.disabled) { return; }
      var text = inp.value.trim();
      if (!text) {
        inp.classList.add('shake');
        inp.focus();
        setTimeout(function() { inp.classList.remove('shake'); }, 400);
        return;
      }
      inp.value = '';
      inp.style.height = 'auto';
      sendbtn.disabled = true;
      stopbtn.classList.add('visible');
      runnerStarted = false;
      var imageToSend = pendingImage;
      pendingImage = null;
      previewImg.src = '';
      imagePreview.style.display = 'none';
      addUserMsg(text, imageToSend);
      startBotMsg();
      api.postMessage({ command: 'chat', prompt: text, image: imageToSend || undefined });
      elementChip.style.display = 'none';
      inp.placeholder = 'Ask me anything\u2026 Paste a design screenshot to match it exactly.';
      // 45 s startup watchdog \u2014 resets to 180 s once the runner emits its first event
      sendTimer = setTimeout(function() {
        unlockSend();
        finishBotMsg('OgaCode engine did not start. Check ONBOARDING.md for setup steps.', true);
      }, 45000);
    }

    sendbtn.addEventListener('click', send);

    /* \u2500\u2500 Keyboard: Enter = send, Shift+Enter = new line \u2500\u2500 */
    var shiftDown = false;
    document.addEventListener('keydown', function(e) { if (e.key === 'Shift') { shiftDown = true; } });
    document.addEventListener('keyup',   function(e) { if (e.key === 'Shift') { shiftDown = false; } });

    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    inp.addEventListener('input', function() {
      inp.style.height = 'auto';
      inp.style.height = inp.scrollHeight + 'px';
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
      runbtn.textContent = '\u23F3 Starting server\u2026';
      api.postMessage({ command: 'runDevServer' });
    });

    expobtn.addEventListener('click', function() {
      expobtn.disabled = true;
      expobtn.textContent = '\u23F3 Starting Expo\u2026';
      api.postMessage({ command: 'runExpo' });
    });

    deploybtn.addEventListener('click', function() {
      deploybtn.disabled = true;
      deploybtn.textContent = '\u23F3 Deploying\u2026';
      deployStatus.style.display = 'none';
      api.postMessage({ command: 'deploy' });
    });

    /* \u2500\u2500 Messages from extension \u2500\u2500 */
    window.addEventListener('message', function(e) {
      var d = e.data;

      if (d.command === 'showOnboarding') {
        _onboarding.style.display = 'flex';
        setTimeout(function() { _tokenInput.focus(); }, 100);
        return;
      }

      if (d.command === 'onboardingDone') {
        _onboarding.style.display = 'none';
        _tokenInput.value = '';
        _activateBtn.disabled = false;
        _activateBtn.textContent = 'Activate OgaCode ➤';
        inp.focus();
        return;
      }

      if (d.command === 'onboardErr') {
        _onboardErr.textContent = d.msg;
        _onboardErr.style.display = 'block';
        _activateBtn.disabled = false;
        _activateBtn.textContent = 'Activate OgaCode ➤';
        return;
      }

      if (d.command === 'setProject') {
        // project name now shown per-chat in dropdown
        return;
      }

      if (d.command === 'unlockSend') {
        unlockSend();
        return;
      }

      if (d.command === 'focusInput') {
        inp.focus();
        return;
      }

      if (d.command === 'elementSelected') {
        elementChipLabel.textContent = d.label;
        elementChip.style.display = 'flex';
        inp.placeholder = 'Describe the change for this element\u2026';
        inp.focus();
        return;
      }

      if (d.command === 'chatCleared') {
        repopulateThread([], d.chatName || 'New Chat');
        unlockSend();
        return;
      }

      if (d.command === 'chatList') {
        renderChatList(d.chats || [], d.activeChatId || '');
        return;
      }

      if (d.command === 'chatLoaded') {
        repopulateThread(d.turns || [], d.chatName);
        unlockSend();
        return;
      }

      if (d.command === 'chatNamed') {
        historyBtn.textContent = (d.name || 'Chat') + ' \u25BE';
        return;
      }

      if (d.command === 'chatRenamed') {
        if (d.chatId === activeChatId) { historyBtn.textContent = (d.name || 'Chat') + ' \u25BE'; }
        if (historyDropdown.style.display !== 'none') { api.postMessage({ command: 'listChats' }); }
        return;
      }

      if (d.command === 'chatDeleted') {
        repopulateThread(d.turns || [], d.chatName);
        api.postMessage({ command: 'listChats' });
        unlockSend();
        return;
      }

      if (d.command === 'showPlan') {
        if (currentBot) {
          var bubble = currentBot.querySelector('.bubble');
          var renderPlan = function(steps, summary, components, stepDetails, isDefault) {
            var currentStepDetails = stepDetails || [];
            var defaultBannerHtml = isDefault
              ? '<div style="padding:6px 8px;background:rgba(255,180,0,.12);border:1px solid rgba(255,180,0,.3);' +
                'border-radius:4px;font-size:10px;color:#e8a000;margin-bottom:8px;">' +
                '&#9888; LLM plan unavailable — showing generic steps. Edit them before running.' +
                '</div>'
              : '';
            var componentsHtml = (components && components.length > 0)
              ? '<div style="margin:6px 0 8px;padding:6px 8px;background:rgba(255,255,255,.04);border-radius:4px">' +
                '<div style="font-size:10px;opacity:.5;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Components</div>' +
                components.map(function(c) {
                  return '<span title="' + esc(c.description || '') + '" style="display:inline-block;padding:2px 8px;margin:2px;border-radius:3px;' +
                    'font-size:10px;background:var(--vscode-badge-background,#444);color:var(--vscode-badge-foreground,#ccc);cursor:default">' +
                    esc(c.name) + '</span>';
                }).join('') +
                '</div>'
              : '';
            var stepsInputsHtml = (steps || []).map(function(s, i) {
              var detail = currentStepDetails[i];
              var verifyHint = (detail && detail.verification)
                ? '<div style="font-size:9px;opacity:.4;font-family:monospace;padding:1px 4px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(detail.verification) + '">' +
                  '&#10003; ' + esc(detail.verification) + '</div>'
                : '';
              return '<div style="padding:3px 0">' +
                '<div style="display:flex;align-items:flex-start;gap:5px">' +
                '<span style="font-size:11px;opacity:.45;flex-shrink:0;padding-top:4px;min-width:14px">' + (i + 1) + '.</span>' +
                '<textarea data-plan-step rows="1" style="flex:1;resize:none;overflow:hidden;' +
                'background:var(--vscode-input-background);color:var(--vscode-input-foreground);' +
                'border:1px solid var(--vscode-input-border,#555);padding:3px 6px;font:inherit;' +
                'font-size:11px;border-radius:3px;line-height:1.4;">' + esc(s) + '</textarea>' +
                '</div>' + verifyHint +
              '</div>';
            }).join('');
            bubble.innerHTML =
              defaultBannerHtml +
              '<b style="font-size:11px;opacity:.8">Here\'s my plan — edit steps if needed</b><br>' +
              '<span style="font-size:10px;opacity:.5">' + esc(summary || '') + '</span>' +
              componentsHtml +
              '<div style="margin:8px 0 4px">' + stepsInputsHtml + '</div>' +
              '<div id="planActions" style="display:flex;gap:6px;margin-top:10px">' +
                '<button id="planApprovebtn" style="flex:1;padding:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600">&#9654; Yes — run plan</button>' +
                '<button id="planRejectbtn" style="padding:6px 10px;background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc);border:none;border-radius:4px;cursor:pointer;font-size:11px">&#10005; No — clarify</button>' +
              '</div>' +
              '<div id="clarifyBox" style="display:none;margin-top:8px">' +
                '<textarea id="clarifyInput" rows="2" placeholder="What needs to change? e.g. use Vue instead of React, skip tests…" style="width:100%;resize:none;' +
                'background:var(--vscode-input-background);color:var(--vscode-input-foreground);' +
                'border:1px solid var(--vscode-input-border,#555);padding:4px 6px;font:inherit;' +
                'font-size:11px;border-radius:3px;box-sizing:border-box;"></textarea>' +
                '<div style="display:flex;gap:6px;margin-top:5px">' +
                  '<button id="clarifySubmitbtn" style="flex:1;padding:5px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600">&#8635; Regenerate plan</button>' +
                  '<button id="clarifyCancelbtn" style="padding:5px 10px;background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc);border:none;border-radius:4px;cursor:pointer;font-size:11px">Cancel</button>' +
                '</div>' +
              '</div>';
            // Auto-resize step textareas
            bubble.querySelectorAll('[data-plan-step]').forEach(function(ta) {
              ta.style.height = 'auto';
              ta.style.height = ta.scrollHeight + 'px';
              ta.addEventListener('input', function() {
                ta.style.height = 'auto';
                ta.style.height = ta.scrollHeight + 'px';
              });
            });
            // Yes — run plan
            document.getElementById('planApprovebtn').addEventListener('click', function() {
              var editedSteps = Array.from(bubble.querySelectorAll('[data-plan-step]'))
                .map(function(ta) { return ta.value.trim(); })
                .filter(function(s) { return s.length > 0; });
              document.getElementById('planApprovebtn').disabled = true;
              document.getElementById('planRejectbtn').disabled = true;
              document.getElementById('planActions').innerHTML = '<span style="font-size:10px;opacity:.5">Running plan…</span>';
              document.getElementById('clarifyBox').style.display = 'none';
              stopbtn.classList.add('visible');
              startBotMsg();
              api.postMessage({ command: 'planApprove', steps: editedSteps, stepDetails: currentStepDetails });
            });
            // No — show clarification box
            document.getElementById('planRejectbtn').addEventListener('click', function() {
              var box = document.getElementById('clarifyBox');
              box.style.display = box.style.display === 'none' ? 'block' : 'none';
              if (box.style.display === 'block') {
                document.getElementById('clarifyInput').focus();
              }
            });
            // Regenerate plan with clarification
            document.getElementById('clarifySubmitbtn').addEventListener('click', function() {
              var text = document.getElementById('clarifyInput').value.trim();
              document.getElementById('planApprovebtn').disabled = true;
              document.getElementById('planRejectbtn').disabled = true;
              document.getElementById('clarifySubmitbtn').disabled = true;
              document.getElementById('clarifyCancelbtn').disabled = true;
              bubble.innerHTML = '<span class="dots"><span></span><span></span><span></span></span> <span style="font-size:10px;opacity:.5">Rethinking plan…</span>';
              api.postMessage({ command: 'planClarify', clarification: text });
            });
            // Cancel clarification box
            document.getElementById('clarifyCancelbtn').addEventListener('click', function() {
              document.getElementById('clarifyBox').style.display = 'none';
            });
          }
          renderPlan(d.steps, d.summary, d.components || [], d.stepDetails || [], d.isDefault || false);
          stopbtn.classList.remove('visible');
        }
        return;
      }

      if (d.command === 'showPlanUpdate') {
        // Re-render plan in the same bot bubble after clarification regeneration
        window.dispatchEvent(new MessageEvent('message', { data: { command: 'showPlan', steps: d.steps, summary: d.summary, components: d.components || [], stepDetails: d.stepDetails || [], isDefault: d.isDefault || false } }));
        return;
      }

      if (d.command === 'agentEvent') {
        var line = formatEvent(d);
        if (line) { addActivity(line); }
        // Reset inactivity watchdog on every event \u2014 npm install on 3G can take 5+ minutes
        // and we only want to fire if nothing at all happens for 5 minutes straight.
        clearTimeout(sendTimer);
        runnerStarted = true;
        sendTimer = setTimeout(function() {
          unlockSend();
          finishBotMsg('No response received for 5 minutes. Check your connection and try again.', true);
        }, 300000);
        return;
      }

      if (d.command === 'chatDone') {
        unlockSend();
        finishBotMsg(d.summary, !d.success);
        if (d.files && d.files.length) {
          addFileChips(d.files);
          var hasPackageJson = d.files.some(function(f) { return f.indexOf('package.json') !== -1; });
          if (hasPackageJson) { runbtn.style.display = 'block'; runbtn.disabled = false; runbtn.textContent = '\u25B6 Run Dev Server'; }
          var hasAppJson = d.files.some(function(f) { return f.indexOf('app.json') !== -1 || f.indexOf('app.config.js') !== -1; });
          if (hasAppJson) { expobtn.style.display = 'block'; expobtn.disabled = false; expobtn.textContent = '\u{1F4F1} Run Expo'; }
          if (!hasAppJson) {
            deploybtn.style.display = 'block';
            deploybtn.disabled = false;
            deploybtn.textContent = '\u2601 Deploy';
            deployStatus.style.display = 'none';
          }
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
          note.textContent = '\u2197 Opened preview for ' + d.file.split(/[\\\\/]/).pop();
          lastBot.querySelector('.files').appendChild(note);
        }
        return;
      }

      if (d.command === 'devServerReady') {
        runbtn.disabled = false;
        runbtn.textContent = '\u25B6 Run Dev Server';
        var lastBot = thread.querySelector('.msg.bot:last-child');
        if (lastBot) {
          var note2 = document.createElement('div');
          note2.style.cssText = 'font-size:10px;color:#6f6;margin-top:4px;';
          note2.textContent = '\u2197 Server live at localhost:3000';
          lastBot.querySelector('.files').appendChild(note2);
        }
        return;
      }

      if (d.command === 'devServerError') {
        runbtn.disabled = false;
        runbtn.textContent = '\u25B6 Run Dev Server';
        addActivity('Server error: ' + d.error);
        return;
      }

      if (d.command === 'showExpobtn') {
        expobtn.style.display = 'block';
        expobtn.disabled = false;
        expobtn.textContent = '\u{1F4F1} Run Expo';
        return;
      }

      if (d.command === 'expoReady') {
        expobtn.disabled = false;
        expobtn.textContent = '\u{1F4F1} Run Expo';
        var qrWrap = document.createElement('div');
        qrWrap.style.cssText = 'margin-top:8px;text-align:center;';
        var qrImg = document.createElement('img');
        qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(d.url) + '&size=160x160&margin=4';
        qrImg.alt = 'Expo QR Code';
        qrImg.style.cssText = 'border-radius:6px;background:#fff;padding:4px;display:block;margin:0 auto;';
        var qrNote = document.createElement('div');
        qrNote.style.cssText = 'font-size:10px;opacity:.7;margin-top:4px;';
        qrNote.textContent = 'Scan with Expo Go \xB7 ' + d.url;
        qrWrap.appendChild(qrImg);
        qrWrap.appendChild(qrNote);
        var lastBubble = thread.querySelector('.msg.bot:last-child .bubble');
        if (lastBubble) { lastBubble.appendChild(qrWrap); }
        return;
      }

      if (d.command === 'expoError') {
        expobtn.disabled = false;
        expobtn.textContent = '\u{1F4F1} Run Expo';
        addActivity('Expo error: ' + d.error);
        return;
      }

      if (d.command === 'cmdResult') {
        // Result of a runCmd shell execution \u2014 currently informational only
        if (!d.success) { addActivity('Command error: ' + d.output); }
        return;
      }

      if (d.command === 'fileList') {
        // File list response \u2014 consumed by callers that store the result; no UI action needed
        return;
      }

      if (d.command === 'filePicked') {
        if (d.file && d.file.content) {
          var existing = inp.value.trim();
          inp.value = existing
            ? existing + '\n\n[Attached file: ' + d.file.name + ']\n' + d.file.content
            : '[Attached file: ' + d.file.name + ']\n' + d.file.content;
          inp.dispatchEvent(new Event('input'));
        }
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

      if (d.command === 'showDeploySetup') {
        deploybtn.disabled = false;
        deploybtn.textContent = '\u2601 Deploy';
        deployStatus.style.display = 'block';
        deployStatus.innerHTML =
          '<b>One-time setup</b> &mdash; get a free Netlify token:<br>' +
          '<a id="netlifyLink" href="#">app.netlify.com/user/applications</a>' +
          '<br><input id="netlifyTokenInput" placeholder="Paste your Netlify personal access token\u2026"' +
          ' style="width:100%;margin-top:6px;padding:4px 6px;font-size:11px;' +
          'background:var(--vscode-input-background);color:var(--vscode-input-foreground);' +
          'border:1px solid var(--vscode-input-border,#555);border-radius:3px;">' +
          '<button id="netlifyTokenSave" style="margin-top:5px;width:100%;padding:5px;' +
          'background:var(--vscode-button-background);color:var(--vscode-button-foreground);' +
          'border:none;cursor:pointer;font-size:11px;border-radius:3px;font-weight:600;">' +
          'Save &amp; Deploy &rarr;</button>';
        document.getElementById('netlifyLink').addEventListener('click', function(e) {
          e.preventDefault();
          api.postMessage({ command: 'openBrowser', url: 'https://app.netlify.com/user/applications' });
        });
        document.getElementById('netlifyTokenSave').addEventListener('click', function() {
          var t = document.getElementById('netlifyTokenInput').value.trim();
          if (!t) { return; }
          deployStatus.textContent = 'Saving token and deploying\u2026';
          deploybtn.disabled = true;
          deploybtn.textContent = '\u23F3 Deploying\u2026';
          api.postMessage({ command: 'saveNetlifyToken', prompt: t });
        });
        return;
      }

      if (d.command === 'deployStatus') {
        deployStatus.style.display = 'block';
        deployStatus.textContent = d.msg;
        return;
      }

      if (d.command === 'deployDone') {
        deploybtn.disabled = false;
        deploybtn.textContent = '\u2601 Deployed \u2713';
        deployStatus.style.display = 'block';
        deployStatus.innerHTML =
          '&#127757; Live at <a id="deployLink" href="#">' + esc(d.url) + '</a>' +
          '&nbsp;<button id="copyUrl" style="font-size:10px;padding:1px 6px;cursor:pointer;' +
          'background:var(--vscode-button-secondaryBackground,#3a3d41);' +
          'color:var(--vscode-button-secondaryForeground,#ccc);' +
          'border:none;border-radius:3px;">Copy</button>';
        document.getElementById('deployLink').addEventListener('click', function(e) {
          e.preventDefault();
          api.postMessage({ command: 'openBrowser', url: d.url });
        });
        document.getElementById('copyUrl').addEventListener('click', function() {
          navigator.clipboard.writeText(d.url).catch(function() {});
          document.getElementById('copyUrl').textContent = 'Copied!';
        });
        return;
      }

      if (d.command === 'deployError') {
        deploybtn.disabled = false;
        deploybtn.textContent = '\u2601 Deploy';
        deployStatus.style.display = 'block';
        deployStatus.textContent = 'Deploy failed: ' + d.msg;
        return;
      }
    });
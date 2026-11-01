/* eslint-disable */
// Cody webview JavaScript logic - Dual Mode: Assistant / Agent

var vscode = acquireVsCodeApi();

var messagesContainer = document.getElementById('messagesContainer');
var emptyState = document.getElementById('emptyState');
var emptyIcon = document.getElementById('emptyIcon');
var emptyTitle = document.getElementById('emptyTitle');
var emptyDesc = document.getElementById('emptyDesc');
var inputField = document.getElementById('inputField');
var sendBtn = document.getElementById('sendBtn');
var clearBtn = document.getElementById('clearBtn');
var attachBtn = document.getElementById('attachBtn');
var fileAttachArea = document.getElementById('fileAttachArea');
var errorContainer = document.getElementById('errorContainer');
var statusDot = document.getElementById('statusDot');
var statusText = document.getElementById('statusText');
var modeAssistant = document.getElementById('modeAssistant');
var modeAgent = document.getElementById('modeAgent');
var settingsBtn = document.getElementById('settingsBtn');
var settingsOverlay = document.getElementById('settingsOverlay');
var settingsClose = document.getElementById('settingsClose');
var settingsSave = document.getElementById('settingsSave');
var settingsReset = document.getElementById('settingsReset');
var settingsMessages = document.getElementById('settingsMessages');
var setApiBaseUrl = document.getElementById('setApiBaseUrl');
var setApiKey = document.getElementById('setApiKey');
var setCompletionApiBaseUrl = document.getElementById('setCompletionApiBaseUrl');
var setCompletionApiKey = document.getElementById('setCompletionApiKey');
var setCompletionModel = document.getElementById('setCompletionModel');
var setChatModel = document.getElementById('setChatModel');
var setChatThinkingFormat = document.getElementById('setChatThinkingFormat');
var setChatThinkingEnabled = document.getElementById('setChatThinkingEnabled');
var setCompletionThinkingFormat = document.getElementById('setCompletionThinkingFormat');
var setCompletionMode = document.getElementById('setCompletionMode');
var setChatSystemPrompt = document.getElementById('setChatSystemPrompt');
var setMaxAgentRounds = document.getElementById('setMaxAgentRounds');
var setAgentMaxTokens = document.getElementById('setAgentMaxTokens');
var setAgentTemperature = document.getElementById('setAgentTemperature');
var editModeBadge = document.getElementById('editModeBadge');
var rollbackBtn = document.getElementById('rollbackBtn');

// Token 统计面板元素
var statsPanel = document.getElementById('statsPanel');
var statsHeader = document.getElementById('statsHeader');
var statsArrow = document.getElementById('statsArrow');
var statsSummary = document.getElementById('statsSummary');
var statChatRequests = document.getElementById('statChatRequests');
var statCached = document.getElementById('statCached');
var statUncached = document.getElementById('statUncached');
var statCompletion = document.getElementById('statCompletion');
var statCompRequests = document.getElementById('statCompRequests');
var statCompTokens = document.getElementById('statCompTokens');
var statCacheRate = document.getElementById('statCacheRate');
var statTotalTokens = document.getElementById('statTotalTokens');
var statsTimer = document.getElementById('statsTimer');
var approvalContainer = document.getElementById('approvalContainer');
var confirmOverlay = document.getElementById('confirmOverlay');
var confirmTempList = document.getElementById('confirmTempList');
var confirmTempCount = document.getElementById('confirmTempCount');
var agentActionBar = document.getElementById('agentActionBar');
var agentPauseBtn = document.getElementById('agentPauseBtn');
var agentResumeBtn = document.getElementById('agentResumeBtn');
var agentStopBtn = document.getElementById('agentStopBtn');

// ============ 双模式状态 ============
// 当前激活模式：'assistant' | 'agent'
var currentMode = 'assistant';
// Assistant 模式的消息历史（独立保存）
var assistantMessages = [];
// Agent 模式的消息历史（独立保存）
var agentMessages = [];
var isStreaming = false;
var hasApiKey = false;
var currentAssistantMessage = '';
var attachedFiles = [];

// ============ 从 VSCode State 恢复 ============
var prevState = vscode.getState();
if (prevState) {
  assistantMessages = prevState.assistantMessages || [];
  agentMessages = prevState.agentMessages || [];
  hasApiKey = prevState.hasApiKey || false;
  attachedFiles = prevState.attachedFiles || [];
  if (prevState.currentMode === 'agent' || prevState.currentMode === 'assistant') {
    currentMode = prevState.currentMode;
  }
}
// 根据当前模式渲染对应历史
renderAllMessages();
updateModeUI();
updateStatus();
updateSendButton();
updateFileAttachUI();

// ============ 获取当前模式的消息数组 ============
function getCurrentMessages() {
  return currentMode === 'agent' ? agentMessages : assistantMessages;
}

function setCurrentMessages(arr) {
  if (currentMode === 'agent') {
    agentMessages = arr;
  } else {
    assistantMessages = arr;
  }
}

// ============ 模式切换 ============
function switchMode(newMode) {
  if (newMode === currentMode || isStreaming) { return; }
  currentMode = newMode;
  updateModeUI();
  // 切换时渲染目标模式的历史消息
  renderAllMessages();
  updateEmptyState();
  saveState();
  // 通知 extension 切换模式
  vscode.postMessage({ command: 'switchMode', mode: currentMode });
}

function updateModeUI() {
  if (currentMode === 'assistant') {
    modeAssistant.classList.add('active');
    modeAgent.classList.remove('active');
  } else {
    modeAgent.classList.add('active');
    modeAssistant.classList.remove('active');
  }
  updateEmptyState();
}

function updateEmptyState() {
  if (getCurrentMessages().length === 0) {
    if (currentMode === 'assistant') {
      emptyIcon.textContent = '\uD83D\uDD0D';
      emptyTitle.textContent = 'Assistant 模式';
      emptyDesc.textContent = '每次提问独立分析，不保留上下文';
    } else {
      emptyIcon.textContent = '\uD83D\uDCAC';
      emptyTitle.textContent = 'Agent 模式';
      emptyDesc.textContent = '保留完整对话历史，支持多轮追问';
    }
  }
}

// ============ 监听来自 extension 的消息 ============
window.addEventListener('message', function(event) {
  var message = event.data;
  switch (message.command) {
    case 'addMessage':
      addMessage(message.role, message.content);
      break;
    case 'streamChunk':
      appendToAssistantMessage(message.content);
      break;
    case 'streamEnd':
      endStreaming();
      break;
    case 'streamError':
      showError(message.content);
      endStreaming();
      break;
    case 'apiKeyStatus':
      hasApiKey = message.hasKey;
      updateStatus();
      updateSendButton();
      break;
    case 'clearChat':
      clearCurrentModeMessages();
      break;
    case 'attachFileResult':
      handleAttachFileResult(message.file);
      break;
    case 'settingsLoaded':
      loadSettingsToUI(message.settings);
      break;
    case 'settingsSaved':
      showSettingsMessage('success', '设置已保存，即时生效');
      hasApiKey = message.settings.apiKey && message.settings.apiKey.length > 0;
      updateStatus();
      updateSendButton();
      break;
    case 'settingsError':
      showSettingsMessage('error', message.content || '保存设置失败');
      break;
    case 'showApproval':
      showApprovalCard(message.toolCalls || []);
      break;
    case 'snapshotUpdate':
      rollbackBtn.disabled = (message.count || 0) === 0;
      break;
    case 'editModeChanged':
      updateEditModeBadge(message.mode);
      break;
    case 'prepareAgentStream':
      // Agent 下一轮开始前，创建新的流式消息槽位
      isStreaming = true;
      currentAssistantMessage = '';
      addAssistantTypingPlaceholder();
      updateSendButton();
      updateStatus();
      break;
    case 'agentToolResult':
      // 工具执行结果作为独立消息展示
      if (message.details) {
        addExpandableAgentResult(message.summary, message.details);
      } else if (message.content) {
        addMessage('assistant', message.content);
      }
      break;
    case 'replaceLastAssistant':
      replaceLastAssistantContent(message.content);
      break;
    case 'collapseMessage':
      collapseLastAssistantMessage(message.filePath || '');
      break;
    case 'showClearConfirm':
      showClearConfirmDialog(message.tempFiles || [], message.tempDir || '');
      break;
    case 'agentStatus':
      updateAgentActionBar(message.running, message.paused);
      // 代理停止时确保清理 streaming 占位符和状态
      if (!message.running) {
        if (isStreaming) {
          isStreaming = false;
          currentAssistantMessage = '';
          removeTypingPlaceholder();
          updateSendButton();
          updateStatus();
        }
      }
      break;
    case 'tokenStats':
      updateTokenStats(message);
      break;
    case 'skillsLoaded':
      renderSkillsList(message.skills || []);
      break;
  }
});

function handleAttachFileResult(file) {
  if (!file || !file.fileName) { return; }
  for (var i = 0; i < attachedFiles.length; i++) {
    if (attachedFiles[i].fileName === file.fileName) {
      attachedFiles[i] = file;
      updateFileAttachUI();
      saveState();
      return;
    }
  }
  attachedFiles.push(file);
  updateFileAttachUI();
  saveState();
}

// ============ 发送消息 ============
function sendMessage() {
  var text = inputField.value.trim();
  if (!text || isStreaming) { return; }

  var displayText = text;
  if (attachedFiles.length > 0) {
    var fileNames = attachedFiles.map(function(f) { return '\uD83D\uDCC4 ' + f.fileName; }).join('\n');
    displayText = fileNames + '\n\n' + text;
  }
  addMessage('user', displayText);
  inputField.value = '';
  autoResizeInput();

  // 发送模式 + 消息 + 附件
  vscode.postMessage({
    command: 'sendMessage',
    content: text,
    mode: currentMode,
    attachedFiles: attachedFiles.slice()
  });

  attachedFiles = [];
  updateFileAttachUI();

  isStreaming = true;
  currentAssistantMessage = '';
  addAssistantTypingPlaceholder();
  updateSendButton();
  updateStatus();
  hideError();
}

// ============ 消息操作 ============
function addMessage(role, content) {
  var msgs = getCurrentMessages();
  msgs.push({ role: role, content: content });
  saveState();
  renderMessage(role, content);
  hideEmptyState();
}

function appendToAssistantMessage(content) {
  currentAssistantMessage += content;
  var msgs = getCurrentMessages();
  var lastMsg = msgs[msgs.length - 1];
  if (lastMsg && lastMsg.role === 'assistant') {
    lastMsg.content = currentAssistantMessage;
  } else {
    msgs.push({ role: 'assistant', content: currentAssistantMessage });
  }
  saveState();

  var assistantMessages = messagesContainer.querySelectorAll('.message.assistant');
  var lastAssistantEl = assistantMessages[assistantMessages.length - 1];
  if (lastAssistantEl) {
    var contentEl = lastAssistantEl.querySelector('.message-content');
    if (contentEl) {
      contentEl.innerHTML = renderMarkdown(currentAssistantMessage);
    }
  }
  scrollToBottom();
}

function endStreaming() {
  isStreaming = false;
  currentAssistantMessage = '';
  removeTypingPlaceholder();
  updateSendButton();
  updateStatus();
}

/** 只清空当前模式的消息 */
function clearCurrentModeMessages() {
  setCurrentMessages([]);
  saveState();
  renderAllMessages();
  showEmptyState();
  updateEmptyState();
}

function renderAllMessages() {
  messagesContainer.innerHTML = '';
  var msgs = getCurrentMessages();
  if (msgs.length === 0) {
    showEmptyState();
    updateEmptyState();
  } else {
    hideEmptyState();
    msgs.forEach(function(msg) { renderMessage(msg.role, msg.content); });
  }
}

function renderMessage(role, content) {
  var msgDiv = document.createElement('div');
  msgDiv.className = 'message ' + role;

  var avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = role === 'user' ? '\uD83D\uDC64' : '\uD83E\uDD16';

  var contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  contentDiv.innerHTML = renderMarkdown(content);

  msgDiv.appendChild(avatar);
  msgDiv.appendChild(contentDiv);
  messagesContainer.appendChild(msgDiv);
  scrollToBottom();

  addCopyButtons(contentDiv);
}

// ============ Markdown 渲染（不变） ============
function renderMarkdown(text) {
  if (!text) { return ''; }

  var BT = String.fromCharCode(96);

  // 1. 先把代码块抽出来保护，避免反转义破坏代码内容
  var codeBlocks = [];
  var codeBlockRegex = new RegExp(BT + BT + BT + '(\\w*)\\n([\\s\\S]*?)' + BT + BT + BT, 'g');
  var processed = text.replace(codeBlockRegex, function(match, lang, code) {
    codeBlocks.push({ lang: lang, code: code });
    return '\x00CODEBLOCK' + (codeBlocks.length - 1) + '\x00';
  });

  // 2. HTML 转义 + 反转义（仅作用于非代码部分）
  var html = processed
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 反转义：把 AI 无法避免的 JSON 级转义序列还原为可读字符
  // 单次扫描，按需替换：\\ → \, \n → 换行, \t → tab, \" → ", \r → 移除
  html = html.replace(/\\(\\|n|t|"|r)/g, function(m, esc) {
    switch (esc) {
      case '\\': return '\\';
      case 'n':  return '\n';
      case 't':  return '\t';
      case '"':  return '"';
      case 'r':  return '';
      default:   return m;
    }
  });

  // 3. 把代码块放回去
  for (var i = 0; i < codeBlocks.length; i++) {
    var cb = codeBlocks[i];
    var code = cb.code;
    var langLabel = cb.lang || 'code';
    var blockHTML = '<div class="code-block-header"><span>' + langLabel +
      '</span><button class="copy-btn" data-code="' + encodeURIComponent(code) +
      '">复制</button></div><pre><code>' +
      code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</code></pre>';
    html = html.replace('\x00CODEBLOCK' + i + '\x00', blockHTML);
  }

  var inlineCodeRegex = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');
  html = html.replace(inlineCodeRegex, '<code>$1</code>');

  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = '<p>' + html + '</p>';

  return html;
}

function addCopyButtons(container) {
  container.querySelectorAll('.copy-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var code = decodeURIComponent(btn.getAttribute('data-code') || '');
      navigator.clipboard.writeText(code).then(function() {
        btn.textContent = '\u5df2\u590d\u5236!';
        setTimeout(function() { btn.textContent = '\u590d\u5236'; }, 2000);
      });
    });
  });
}

// ============ UI 辅助 ============
function addAssistantTypingPlaceholder() {
  var existing = messagesContainer.querySelector('.typing-placeholder');
  if (existing) { return; }
  var msgDiv = document.createElement('div');
  msgDiv.className = 'message assistant typing-placeholder';
  msgDiv.innerHTML = '<div class="message-avatar">\uD83E\uDD16</div>' +
    '<div class="message-content"><div class="typing-indicator">' +
    '<span></span><span></span><span></span></div></div>';
  messagesContainer.appendChild(msgDiv);
  scrollToBottom();
}

function removeTypingPlaceholder() {
  var placeholder = messagesContainer.querySelector('.typing-placeholder');
  if (placeholder) { placeholder.classList.remove('typing-placeholder'); }
}

function showError(errorText) {
  // 用 textContent 防止 API 错误信息中的 HTML 注入
  errorContainer.innerHTML = '';
  var errDiv = document.createElement('div');
  errDiv.className = 'error-message';
  errDiv.textContent = errorText;
  errorContainer.appendChild(errDiv);
}

function hideError() {
  errorContainer.innerHTML = '';
}

function showEmptyState() {
  if (emptyState) { emptyState.style.display = ''; }
}

function hideEmptyState() {
  if (emptyState) { emptyState.style.display = 'none'; }
}

function updateStatus() {
  if (isStreaming) {
    statusDot.className = 'dot loading';
    statusText.textContent = 'Cody 正在回复...';
  } else if (hasApiKey) {
    statusDot.className = 'dot connected';
    statusText.textContent = 'API 已连接 | ' + (currentMode === 'assistant' ? 'Assistant' : 'Agent');
  } else {
    statusDot.className = 'dot connected';
    statusText.textContent = 'API 就绪（免鉴权） | ' + (currentMode === 'assistant' ? 'Assistant' : 'Agent');
  }
}

function updateSendButton() {
  var hasText = inputField.value.trim().length > 0;
  sendBtn.disabled = isStreaming || !hasText;
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function autoResizeInput() {
  inputField.style.height = 'auto';
  inputField.style.height = Math.min(inputField.scrollHeight, 150) + 'px';
}

/** 持久化：保存双模式数据 */
function saveState() {
  vscode.setState({
    assistantMessages: assistantMessages,
    agentMessages: agentMessages,
    currentMode: currentMode,
    hasApiKey: hasApiKey,
    attachedFiles: attachedFiles
  });
}

// ============ 多文件附件 ============
function updateFileAttachUI() {
  fileAttachArea.innerHTML = '';

  if (attachedFiles.length === 0) {
    fileAttachArea.style.display = 'none';
    attachBtn.classList.remove('has-file');
    attachBtn.title = '附加当前编辑器文件';
    return;
  }

  fileAttachArea.style.display = '';
  attachBtn.classList.add('has-file');
  attachBtn.title = '附加更多文件（已附加 ' + attachedFiles.length + ' 个）';

  for (var i = 0; i < attachedFiles.length; i++) {
    (function(index) {
      var f = attachedFiles[index];
      var tag = document.createElement('div');
      tag.className = 'file-attach-tag';

      var icon = document.createElement('span');
      icon.className = 'file-attach-icon';
      icon.textContent = '\uD83D\uDCC4';

      var name = document.createElement('span');
      name.className = 'file-attach-name';
      name.textContent = f.fileName;

      var removeBtn = document.createElement('button');
      removeBtn.className = 'file-attach-remove';
      removeBtn.title = '移除 ' + f.fileName;
      removeBtn.textContent = '\u2715';
      removeBtn.addEventListener('click', function() {
        attachedFiles.splice(index, 1);
        updateFileAttachUI();
        saveState();
      });

      tag.appendChild(icon);
      tag.appendChild(name);
      tag.appendChild(removeBtn);
      fileAttachArea.appendChild(tag);
    })(i);
  }
}

function requestAttachFile() {
  vscode.postMessage({ command: 'attachFile' });
}

// ============ Event Listeners ============
sendBtn.addEventListener('click', sendMessage);

inputField.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

inputField.addEventListener('input', function() {
  autoResizeInput();
  updateSendButton();
});

clearBtn.addEventListener('click', function() {
  if (getCurrentMessages().length > 0) {
    // 先请求后端返回临时文件列表，再弹窗确认
    vscode.postMessage({ command: 'requestClearHistory' });
  }
});

attachBtn.addEventListener('click', requestAttachFile);

modeAssistant.addEventListener('click', function() { switchMode('assistant'); });
modeAgent.addEventListener('click', function() { switchMode('agent'); });

// ============ Agent 审批 + 回滚 + 编辑模式 ============

// ============ 清除确认弹窗 ============

function showClearConfirmDialog(tempFiles, tempDir) {
  confirmTempList.innerHTML = '';
  confirmTempCount.textContent = '';

  if (tempFiles.length > 0) {
    var countEl = document.createElement('p');
    countEl.style.cssText = 'font-size:11px;margin-bottom:6px;';
    countEl.textContent = `📂 以下 ${tempFiles.length} 个临时文件将被删除：`;
    confirmTempCount.appendChild(countEl);

    var listEl = document.createElement('div');
    listEl.style.cssText = 'max-height:120px;overflow-y:auto;font-size:11px;font-family:var(--vscode-editor-font-family);background:var(--bg-input);border-radius:4px;padding:6px 8px;margin-bottom:8px;';
    for (var i = 0; i < tempFiles.length; i++) {
      var line = document.createElement('div');
      line.style.cssText = 'padding:1px 0;';
      line.textContent = tempFiles[i];
      listEl.appendChild(line);
    }
    confirmTempList.appendChild(listEl);

    var dirEl = document.createElement('p');
    dirEl.style.cssText = 'font-size:10px;color:var(--text-secondary);';
    dirEl.textContent = '目录: ' + tempDir;
    confirmTempList.appendChild(dirEl);
  }

  confirmOverlay.classList.remove('hidden');
}

function closeConfirmDialog() {
  confirmOverlay.classList.add('hidden');
}

document.getElementById('confirmCancel').addEventListener('click', closeConfirmDialog);
document.getElementById('confirmDelete').addEventListener('click', function() {
  closeConfirmDialog();
  vscode.postMessage({ command: 'confirmClearHistory' });
});
confirmOverlay.addEventListener('click', function(e) {
  if (e.target === confirmOverlay) { closeConfirmDialog(); }
});

/**
 * 替换最后一条 assistant 消息内容（用于过长输出卸载后更新 UI）
 */
function replaceLastAssistantContent(content) {
  var msgs = getCurrentMessages();
  var lastMsg = msgs[msgs.length - 1];
  if (lastMsg && lastMsg.role === 'assistant') {
    lastMsg.content = content;
  }
  saveState();

  var assistantMessages = messagesContainer.querySelectorAll('.message.assistant');
  var lastEl = assistantMessages[assistantMessages.length - 1];
  if (lastEl) {
    var contentEl = lastEl.querySelector('.message-content');
    if (contentEl) {
      contentEl.innerHTML = renderMarkdown(content);
    }
  }
  scrollToBottom();
}

// ============ 视觉折叠：超过高度自动收起 ============
/** 消息高度阈值 */
var COLLAPSE_PX = 400;  // 超过此高度则折叠
var SCROLL_PX = 600;   // 展开后超过此高度则滚动

/**
 * 将最后一条 assistant 消息按视觉高度折叠：
 * - scrollHeight > 400px → 添加 .collapsed 类 + 渐隐遮罩
 * - 气泡右下角浮动「展开 ▼」按钮
 * - 超长文件链接浮动在左下角
 */
function collapseLastAssistantMessage(tempFilePath) {
  var assistantMessages = messagesContainer.querySelectorAll('.message.assistant');
  var lastEl = assistantMessages[assistantMessages.length - 1];
  if (!lastEl) return;

  var contentEl = lastEl.querySelector('.message-content');
  if (!contentEl) return;

  // 延迟一帧确保渲染完成再测高度
  requestAnimationFrame(function() {
    var scrollH = contentEl.scrollHeight;
    if (scrollH <= COLLAPSE_PX) return;

    // 清旧元素
    var old = lastEl.querySelector('.message-collapse-toggle');
    if (old) old.remove();
    var oldLink = lastEl.querySelector('.message-tempfile-link');
    if (oldLink) oldLink.remove();

    // 折叠
    contentEl.classList.add('collapsed');

    // 浮动按钮（absolute 定位在 message.assistant 右下角）
    var btn = document.createElement('button');
    btn.className = 'message-collapse-toggle visible';
    btn.textContent = '展开 ▼';
    btn.title = '展开完整内容';

    // 文件链接（浮动在左下角）
    var fileLink = null;
    if (tempFilePath) {
      fileLink = document.createElement('span');
      fileLink.className = 'message-tempfile-link visible';
      fileLink.textContent = '📄';
      fileLink.title = tempFilePath;
    }

    var isExpanded = false;
    btn.addEventListener('click', function() {
      if (isExpanded) {
        contentEl.classList.remove('expanded');
        contentEl.classList.add('collapsed');
        btn.textContent = '展开 ▼';
        btn.title = '展开完整内容';
        isExpanded = false;
      } else {
        contentEl.classList.remove('collapsed');
        contentEl.classList.add('expanded');
        btn.textContent = '收起 ▲';
        btn.title = '收起';
        isExpanded = true;
      }
    });

    lastEl.appendChild(btn);
    if (fileLink) { lastEl.appendChild(fileLink); }
    scrollToBottom();
  });
}

/**
 * 添加可展开的 Agent 工具结果消息
 * @param {string} summary 单行摘要
 * @param {string} details 完整 Markdown 详情
 */
function addExpandableAgentResult(summary, details) {
  hideEmptyState();

  var wrapper = document.createElement('div');
  wrapper.className = 'expandable-result';

  // 头部：摘要 + 展开/收起按钮
  var header = document.createElement('div');
  header.className = 'expandable-header';
  header.addEventListener('click', function() {
    var body = wrapper.querySelector('.expandable-body');
    var arrow = wrapper.querySelector('.expandable-arrow');
    if (body.classList.contains('hidden')) {
      body.classList.remove('hidden');
      arrow.textContent = '\u25BC';
    } else {
      body.classList.add('hidden');
      arrow.textContent = '\u25B6';
    }
  });

  var arrow = document.createElement('span');
  arrow.className = 'expandable-arrow';
  arrow.textContent = '\u25B6';

  var summaryEl = document.createElement('span');
  summaryEl.className = 'expandable-summary';
  summaryEl.innerHTML = renderMarkdown(summary);

  header.appendChild(arrow);
  header.appendChild(summaryEl);

  // 详情体（默认收起）
  var body = document.createElement('div');
  body.className = 'expandable-body hidden';
  body.innerHTML = renderMarkdown(details);

  wrapper.appendChild(header);
  wrapper.appendChild(body);
  messagesContainer.appendChild(wrapper);
  scrollToBottom();
}

function showApprovalCard(toolCalls) {
  // 清除旧审批卡片
  approvalContainer.innerHTML = '';

  var card = document.createElement('div');
  card.className = 'approval-card';

  var title = document.createElement('div');
  title.className = 'approval-title';
  title.textContent = '\uD83D\uDCCB Agent 即将执行以下操作：';

  var list = document.createElement('div');
  list.className = 'approval-list';

  var hasDangerous = false;
  for (var i = 0; i < toolCalls.length; i++) {
    var tc = toolCalls[i];
    var item = document.createElement('div');
    item.className = 'approval-item';
    if (tc.dangerous) { item.className += ' dangerous'; hasDangerous = true; }
    item.textContent = tc.summary;
    list.appendChild(item);
  }

  var actions = document.createElement('div');
  actions.className = 'approval-actions';

  var denyBtn = document.createElement('button');
  denyBtn.className = 'approval-deny';
  denyBtn.textContent = '\u2716 拒绝';
  denyBtn.addEventListener('click', function() {
    approvalContainer.innerHTML = '';
    vscode.postMessage({ command: 'approveActions', approved: false });
  });

  var approveBtn = document.createElement('button');
  approveBtn.className = 'approval-approve';
  approveBtn.textContent = '\u2714 批准执行';
  approveBtn.addEventListener('click', function() {
    approvalContainer.innerHTML = '';
    vscode.postMessage({ command: 'approveActions', approved: true });
  });

  actions.appendChild(denyBtn);
  actions.appendChild(approveBtn);

  card.appendChild(title);
  if (hasDangerous) {
    var warning = document.createElement('div');
    warning.className = 'approval-warning';
    warning.textContent = '\u26A0\uFE0F 部分操作为危险操作，请确认后执行';
    card.appendChild(warning);
  }
  card.appendChild(list);
  card.appendChild(actions);

  approvalContainer.appendChild(card);
  messagesContainer.scrollTop = messagesContainer.scrollHeight + 200;
}

// 回滚按钮
rollbackBtn.addEventListener('click', function() {
  if (getCurrentMessages().length > 0) {
    rollbackBtn.disabled = true;
    vscode.postMessage({ command: 'rollbackAgent' });
  }
});

// 编辑模式切换
var currentEditMode = 'normal';

function updateEditModeBadge(mode) {
  currentEditMode = mode || 'normal';
  editModeBadge.className = 'edit-mode-badge ' + currentEditMode;
  editModeBadge.textContent = currentEditMode === 'normal' ? '\uD83D\uDD10 一般' : '\u26A1 \u9AD8\u6548';
  editModeBadge.title = currentEditMode === 'normal'
    ? '\u7F16\u8F91\u524D\u9700\u5BA1\u6279\uFF0C\u70B9\u51FB\u5207\u6362\u4E3A\u9AD8\u6548\u6A21\u5F0F'
    : '\u76F4\u63A5\u6267\u884C\u7F16\u8F91\uFF0C\u70B9\u51FB\u5207\u6362\u4E3A\u4E00\u822C\u6A21\u5F0F';
}

editModeBadge.addEventListener('click', function() {
  vscode.postMessage({ command: 'toggleEditMode' });
});

function resetAgentUI() {
  approvalContainer.innerHTML = '';
  rollbackBtn.disabled = true;
  updateAgentActionBar(false, false);
}

// =============== Agent 操作栏 ===============

function updateAgentActionBar(running, paused) {
  if (running && paused) {
    agentActionBar.classList.add('visible');
    agentPauseBtn.style.display = 'none';
    agentResumeBtn.style.display = '';
  } else if (running) {
    agentActionBar.classList.add('visible');
    agentPauseBtn.style.display = '';
    agentResumeBtn.style.display = 'none';
  } else {
    agentActionBar.classList.remove('visible');
  }
}

agentPauseBtn.addEventListener('click', function() {
  vscode.postMessage({ command: 'pauseAgent' });
});

agentResumeBtn.addEventListener('click', function() {
  vscode.postMessage({ command: 'resumeAgent' });
});

agentStopBtn.addEventListener('click', function() {
  vscode.postMessage({ command: 'stopAgent' });
});

// 清空对话时重置 Agent UI
var origClearMessages = clearCurrentModeMessages;
clearCurrentModeMessages = function() {
  origClearMessages();
  resetAgentUI();
};

// ========== Token 统计面板 ==========

/** 展开/收起统计面板 */
statsHeader.addEventListener('click', function() {
  if (statsPanel.classList.contains('expanded')) {
    statsPanel.classList.remove('expanded');
    statsArrow.textContent = '▶';
  } else {
    statsPanel.classList.add('expanded');
    statsArrow.textContent = '▼';
  }
});

/** 更新统计面板数据 */
function updateTokenStats(data) {
  statChatRequests.textContent = data.chatRequests || 0;
  statCacheRate.textContent = (data.cacheRate || 0) + '%';
  statCached.textContent = formatNumber(data.cachedPromptTokens || 0);
  statUncached.textContent = formatNumber(data.uncachedPromptTokens || 0);
  statCompletion.textContent = formatNumber(data.completionTokens || 0);
  statCompRequests.textContent = data.compRequests || 0;
  var compTok = (data.compPromptTokens || 0) + (data.compCompletionTokens || 0);
  statCompTokens.textContent = formatNumber(compTok);
  statTotalTokens.textContent = formatNumber(data.totalTokens || 0);
  statsTimer.textContent = '运行时间: ' + (data.elapsedMin || 0) + ' 分钟';

  // 头部摘要：命中率🎯 缓存↘未命中↘ 输出↗ 补全📋
  statsSummary.textContent =
    '🎯' + (data.cacheRate || 0) + '%' +
    ' ↘' + formatNumber(data.cachedPromptTokens || 0) +
    '/' + formatNumber(data.uncachedPromptTokens || 0) +
    ' ↗' + formatNumber(data.completionTokens || 0) +
    ' 📋' + formatNumber(compTok);
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

updateStatus();

 updateSendButton();

// ============ 设置面板 ============

settingsBtn.addEventListener('click', function() {
  vscode.postMessage({ command: 'getSettings' });
});

settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', function(e) {
  if (e.target === settingsOverlay) { closeSettings(); }
});

settingsSave.addEventListener('click', function() {
  var settings = {
    apiBaseUrl: setApiBaseUrl.value.trim(),
    apiKey: setApiKey.value.trim(),
    completionApiBaseUrl: setCompletionApiBaseUrl.value.trim(),
    completionApiKey: setCompletionApiKey.value.trim(),
    completionModel: setCompletionModel.value.trim(),
    chatModel: setChatModel.value.trim(),
    chatThinkingFormat: setChatThinkingFormat.value,
    chatThinkingEnabled: setChatThinkingEnabled.value === 'true',
    completionThinkingFormat: setCompletionThinkingFormat.value,
    completionMode: setCompletionMode.value,
    chatSystemPrompt: setChatSystemPrompt.value.trim(),
    maxAgentRounds: parseInt(setMaxAgentRounds.value) || 10,
    agentMaxTokens: parseInt(setAgentMaxTokens.value) || 8000,
    agentTemperature: parseFloat(setAgentTemperature.value) ?? 0.2,
  };
  settingsSave.disabled = true;
  vscode.postMessage({ command: 'saveSettings', settings: settings });
});

settingsReset.addEventListener('click', function() {
  // 用推荐默认值填充表单（不自动保存，需手动点保存）
  if (window._settingsDefaults) {
    setApiBaseUrl.value = window._settingsDefaults.apiBaseUrl || '';
    setApiKey.value = window._settingsDefaults.apiKey || '';
    setCompletionApiBaseUrl.value = window._settingsDefaults.completionApiBaseUrl || '';
    setCompletionApiKey.value = window._settingsDefaults.completionApiKey || '';
    setCompletionModel.value = window._settingsDefaults.completionModel || '';
    setChatModel.value = window._settingsDefaults.chatModel || '';
    setChatThinkingFormat.value = window._settingsDefaults.chatThinkingFormat || 'minimax';
    setChatThinkingEnabled.value = window._settingsDefaults.chatThinkingEnabled !== false ? 'true' : 'false';
    setCompletionThinkingFormat.value = window._settingsDefaults.completionThinkingFormat || 'minimax';
    setCompletionMode.value = window._settingsDefaults.completionMode || 'both';
    setChatSystemPrompt.value = window._settingsDefaults.chatSystemPrompt || '';
    setMaxAgentRounds.value = window._settingsDefaults.maxAgentRounds || 10;
    setAgentMaxTokens.value = window._settingsDefaults.agentMaxTokens || 8000;
    setAgentTemperature.value = window._settingsDefaults.agentTemperature ?? 0.2;
  }
  settingsMessages.innerHTML = '';
  settingsSave.disabled = false;
});

function openSettings() {
  settingsOverlay.classList.remove('hidden');
  settingsMessages.innerHTML = '';
  settingsSave.disabled = false;
  // 默认切换到第一个标签页
  switchSettingsTab('page-api');
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
}

// 标签栏切换
function switchSettingsTab(pageId) {
  document.querySelectorAll('.settings-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.page === pageId);
  });
  document.querySelectorAll('.settings-tab-page').forEach(function(p) {
    p.classList.toggle('active', p.id === pageId);
  });
}
document.querySelectorAll('.settings-tab').forEach(function(tab) {
  tab.addEventListener('click', function() {
    switchSettingsTab(tab.dataset.page);
    // 打开 SKILL 页面时自动拉取列表
    if (tab.dataset.page === 'page-skills') {
      vscode.postMessage({ command: 'getSkills' });
    }
  });
});

// ========== SKILL 管理 ==========

var skillList = document.getElementById('skillList');
var skillImportBtn = document.getElementById('skillImportBtn');

skillImportBtn.addEventListener('click', function() {
  vscode.postMessage({ command: 'importSkill' });
});

function renderSkillsList(skills) {
  if (!skills || skills.length === 0) {
    skillList.innerHTML = '<div class="skill-empty">暂无 SKILL。点击下方按钮导入。</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < skills.length; i++) {
    var s = skills[i];
    var cls = s.enabled ? '' : ' disabled';
    var toggleClass = s.enabled ? 'on' : 'off';
    var preview = (s.content || '').replace(/[\n\r]+/g, ' ').substring(0, 60);
    var dateStr = new Date(s.importedAt).toLocaleString();
    html +=
      '<div class="skill-item' + cls + '">' +
        '<div class="skill-info">' +
          '<div class="skill-name" title="' + escapeHtml(s.name) + '">' + escapeHtml(s.name) + '</div>' +
          '<div class="skill-content-preview" title="' + escapeHtml(preview) + '">' + escapeHtml(preview) + '</div>' +
        '</div>' +
        '<button class="skill-toggle ' + toggleClass + '" data-id="' + escapeHtml(s.id) + '" title="' + (s.enabled ? '禁用' : '启用') + '"></button>' +
        '<button class="skill-remove" data-id="' + escapeHtml(s.id) + '" title="移除">✕</button>' +
      '</div>';
  }
  skillList.innerHTML = html;

  // 开关事件
  skillList.querySelectorAll('.skill-toggle').forEach(function(btn) {
    btn.addEventListener('click', function() {
      vscode.postMessage({ command: 'toggleSkill', id: btn.dataset.id });
    });
  });
  // 移除事件
  skillList.querySelectorAll('.skill-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      vscode.postMessage({ command: 'removeSkill', id: btn.dataset.id });
    });
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadSettingsToUI(payload) {
  var s = payload.settings || payload;
  setApiBaseUrl.value = s.apiBaseUrl || '';
  setApiKey.value = s.apiKey || '';
  setCompletionApiBaseUrl.value = s.completionApiBaseUrl || '';
  setCompletionApiKey.value = s.completionApiKey || '';
  setCompletionModel.value = s.completionModel || '';
  setChatModel.value = s.chatModel || '';
  setChatThinkingFormat.value = s.chatThinkingFormat || 'minimax';
  setChatThinkingEnabled.value = s.chatThinkingEnabled !== false ? 'true' : 'false';
  setCompletionThinkingFormat.value = s.completionThinkingFormat || 'minimax';
  setCompletionMode.value = s.completionMode || 'both';
  setChatSystemPrompt.value = s.chatSystemPrompt || '';
  setMaxAgentRounds.value = s.maxAgentRounds || 10;
  setAgentMaxTokens.value = s.agentMaxTokens || 8000;
  setAgentTemperature.value = s.agentTemperature ?? 0.2;
  // 缓存推荐默认值供「恢复默认」按钮使用
  if (payload.defaults) { window._settingsDefaults = payload.defaults; }
  openSettings();
}

function showSettingsMessage(type, text) {
  var bgColor = type === 'success'
    ? 'var(--vscode-inputValidation-infoBackground)'
    : 'var(--vscode-inputValidation-errorBackground)';
  var fgColor = type === 'success'
    ? 'var(--vscode-inputValidation-infoForeground)'
    : 'var(--vscode-inputValidation-errorForeground)';
  var borderColor = type === 'success'
    ? 'var(--vscode-inputValidation-infoBorder)'
    : 'var(--vscode-inputValidation-errorBorder)';
  settingsMessages.innerHTML = '';
  var msgDiv = document.createElement('div');
  msgDiv.style.background = bgColor;
  msgDiv.style.color = fgColor;
  msgDiv.style.border = '1px solid ' + borderColor;
  msgDiv.style.borderRadius = '6px';
  msgDiv.style.padding = '6px 10px';
  msgDiv.style.fontSize = '11px';
  msgDiv.style.textAlign = 'center';
  msgDiv.textContent = text;
  settingsMessages.appendChild(msgDiv);
  settingsSave.disabled = false;
}

updateStatus();
updateSendButton();
autoResizeInput();
inputField.focus();

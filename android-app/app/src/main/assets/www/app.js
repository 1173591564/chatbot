/* =========================================================
   DeepSeek 助手 · Android 前端
   - 纯客户端直连 api.deepseek.com
   - 官方全家桶：deepseek_web_search / deepseek_read_url / Files 文件解析
   - 零依赖，SSE 手写解析
   ========================================================= */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  var hasNative = typeof window.AndroidBridge !== 'undefined';

  /* ---------------- 本地存储 ---------------- */
  var LS = {
    get: function (k, d) {
      try {
        var v = localStorage.getItem('ds.' + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem('ds.' + k, JSON.stringify(v)); } catch (e) {}
    }
  };

  /* ---------------- 设置 ---------------- */
  var DEFAULTS = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    webSearch: true,
    thinking: false,
    readUrl: true,
    safety: false,
    autoTitle: true,
    systemPrompt: [
      '你是 DeepSeek 助手，可靠、直接、乐于助人。',
      '',
      '工作方式：',
      '- 遇到时效性、或你不确定的事实性问题时，先联网搜索再回答；引用来源由系统自动标号。',
      '- 用户消息里出现网址时，直接阅读该链接。',
      '- 不确定就明说，不要编造来源、链接或数据。',
      '- 默认用中文回答。',
      '- 代码用带语言标注的 Markdown 代码块；适合时用表格和列表。',
      '- 保持简洁，能三句说清就不写三段。'
    ].join('\n')
  };

  var settings = Object.assign({}, DEFAULTS, LS.get('settings', {}));

  function saveSettings() { LS.set('settings', settings); }

  /* ---------------- 图片：压缩 + 卸载大图 ---------------- */
  var MAX_IMG_SPAN = 1600;

  /** 把图片等比压到 1600px 内，避免请求体炸掉；解码卡住就直接用原图 */
  function shrinkImage(dataUrl, mime) {
    return new Promise(function (resolve) {
      if (typeof Image === 'undefined' || !document.createElement) { resolve(dataUrl); return; }
      if (!/^image\/(jpeg|png|webp)$/.test(mime || '')) { resolve(dataUrl); return; }

      var settled = false;
      function done(v) { if (!settled) { settled = true; resolve(v); } }
      var timer = setTimeout(function () { done(dataUrl); }, 2500);

      var img = new Image();
      img.onload = function () {
        clearTimeout(timer);
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { done(dataUrl); return; }
        var scale = Math.min(1, MAX_IMG_SPAN / Math.max(w, h));
        if (scale === 1 && dataUrl.length < 900000) { done(dataUrl); return; }
        var cw = Math.round(w * scale), ch = Math.round(h * scale);
        try {
          var canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
          done(canvas.toDataURL('image/jpeg', 0.86));
        } catch (e) { done(dataUrl); }
      };
      img.onerror = function () { clearTimeout(timer); done(dataUrl); };
      img.src = dataUrl;
    });
  }

  /** 写盘前把历史里体积大的图片换成占位说明，防止 localStorage 溢出 */
  function stripHeavyImages(list) {
    return list.map(function (m) {
      if (!m || !m.files || !m.files.length) return m;
      var files = m.files.map(function (f) {
        if (f.image && f.image.length > 200000) {
          return { name: f.name, size: f.size, imageDropped: true };
        }
        return f;
      });
      return Object.assign({}, m, { files: files });
    });
  }

  /** 会话消息统一存在 nodes 里；这里对两种历史格式都做瘦身 */
  function stripHeavySession(s) {
    var t = Object.assign({}, s);
    if (t.nodes) t.nodes = stripHeavyImages(t.nodes);
    if (t.messages) t.messages = stripHeavyImages(t.messages);
    return t;
  }

  /* ---------------- 会话 ---------------- */
  var sessions = LS.get('sessions', []);
  var currentId = LS.get('currentId', null);
  var messages = [];      // 当前会话的消息（由 leafId 派生，只读视图）
  var attachments = [];   // 待发送附件
  var streaming = false;
  var abortCtrl = null;
  var msgSeq = 0;         // 节点 id 的自增序号，配合时间戳保证唯一
  var regenParentId = null;  // 「重新生成 / 继续写」时新回答要挂的父节点；null=接在末尾用户提问后
  var editingId = null;      // 正在编辑的历史提问节点 id
  var viewCutId = null;      // 编辑态下视图临时截断到哪条消息（不含）

  function newSession() {
    // 当前会话还没说过话就复用它——否则每点一次 + 就攒一个空会话，抽屉被刷屏
    var cur = currentSession();
    if (cur && (!cur.nodes || !cur.nodes.length)) {
      messages = [];
      return cur;
    }
    var s = {
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nodes: [],          // 消息树：{ id, parentId, role, content, ... }
      leafId: null        // 当前正在看的分支末端
    };
    sessions.unshift(s);
    if (sessions.length > 60) sessions.length = 60;
    currentId = s.id;
    messages = [];
    persist();
    return s;
  }

  function currentSession() {
    for (var i = 0; i < sessions.length; i++) if (sessions[i].id === currentId) return sessions[i];
    return null;
  }

  /* ---------------- 消息树 ----------------
     每个会话存一棵树，同一个提问可以有多个版本（同父同角色的兄弟节点）。
     当前看到的内容 = 从 leafId 沿 parentId 回溯到根。
     编辑旧提问 = 在它父节点下再挂一个 user 节点，旧问答原样保留。
  ------------------------------------------ */

  /** 旧数据（一条 messages 直线）折叠成一条链；幂等，可反复调用 */
  function ensureTree(s) {
    if (!s) return s;
    if (Object.prototype.toString.call(s.nodes) === '[object Array]') return s;
    var nodes = [], parent = null;
    (s.messages || []).forEach(function (m) {
      if (!m || !m.role) return;
      var n = {
        id: 'n' + (++msgSeq) + '-' + Date.now().toString(36),
        parentId: parent,
        role: m.role,
        content: m.content || '',
        createdAt: Date.now()
      };
      if (m.reasoning) n.reasoning = m.reasoning;
      if (m.tools) n.tools = m.tools;
      if (m.annotations) n.annotations = m.annotations;
      if (m.serverCalls) n.serverCalls = m.serverCalls;
      if (m.files) n.files = m.files;
      if (m.model) n.model = m.model;
      if (m.truncated) n.truncated = m.truncated;
      nodes.push(n);
      parent = n.id;
    });
    s.nodes = nodes;
    s.leafId = parent;
    delete s.messages;
    return s;
  }

  function nodeById(s, id) {
    if (!s || !id) return null;
    for (var i = 0; i < s.nodes.length; i++) if (s.nodes[i].id === id) return s.nodes[i];
    return null;
  }

  /** 从 leaf 往上回溯，返回正序路径 */
  function pathOf(s, leafId) {
    var out = [], cur = nodeById(s, leafId === undefined ? s.leafId : leafId), guard = 0;
    while (cur && guard++ < 5000) {
      out.push(cur);
      cur = cur.parentId ? nodeById(s, cur.parentId) : null;
    }
    return out.reverse();
  }

  /** 同父同角色的兄弟节点（含自己），按创建顺序 */
  function siblingsOf(s, node) {
    if (!s || !node) return [];
    var p = node.parentId || null;
    return s.nodes.filter(function (n) {
      return (n.parentId || null) === p && n.role === node.role;
    }).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
  }

  /** 从某节点往下走最新的子节点，得到该分支末端 */
  function deepestLeaf(s, nodeId) {
    var cur = nodeById(s, nodeId), guard = 0;
    while (cur && guard++ < 5000) {
      var kids = s.nodes.filter(function (n) { return n.parentId === cur.id; })
        .sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      if (!kids.length) break;
      cur = kids[kids.length - 1];
    }
    return cur ? cur.id : nodeId;
  }

  function addNode(s, node) {
    if (!s) return null;
    // 父节点必须真实存在，否则会留下孤儿节点：沿 leafId 回溯的路径里
    // 直接断开，这条消息永远显示不出来，也删不掉。
    var pid = node.parentId || null;
    if (pid && !nodeById(s, pid)) pid = null;
    var n = {
      id: 'n' + (++msgSeq) + '-' + Date.now().toString(36),
      parentId: pid,
      role: node.role,
      content: node.content || '',
      createdAt: Date.now()
    };
    if (node.reasoning) n.reasoning = node.reasoning;
    if (node.tools && node.tools.length) n.tools = node.tools;
    if (node.annotations) n.annotations = node.annotations;
    if (node.serverCalls) n.serverCalls = node.serverCalls;
    if (node.files && node.files.length) n.files = node.files;
    if (node.model) n.model = node.model;
    if (node.truncated) n.truncated = node.truncated;
    s.nodes.push(n);
    s.updatedAt = Date.now();
    if (s.title === '新对话' && n.role === 'user' && n.content) {
      s.title = n.content.replace(/\s+/g, ' ').slice(0, 22) || '新对话';
    }
    return n;
  }

  /** 当前分支上每个「有多个版本」的节点的序号信息 */
  function branchInfo() {
    var s = currentSession();
    var out = {};
    if (!s) return out;
    pathOf(s).forEach(function (n) {
      var sibs = siblingsOf(s, n);
      if (sibs.length > 1) {
        var idx = 0;
        for (var i = 0; i < sibs.length; i++) if (sibs[i].id === n.id) idx = i;
        out[n.id] = { index: idx + 1, count: sibs.length };
      }
    });
    return out;
  }

  function persist() {
    var s = ensureTree(currentSession());
    if (s) { s.updatedAt = Date.now(); }
    // 旧版本存的是一条 messages 直线，落盘前统一转成树，下次启动就走新格式
    sessions = sessions.map(ensureTree);
    LS.set('sessions', sessions);
    LS.set('currentId', currentId);
  }

  /** 把 messages 重新算成「当前分支」的视图。切会话、切版本、加减节点后都要调 */
  function syncMessages() {
    var s = ensureTree(currentSession());
    messages = s ? pathOf(s) : [];
    return messages;
  }

  /** 当前正在接的那条消息（新提问/新回答挂它下面） */
  function leafNode() {
    var s = currentSession();
    return s ? nodeById(s, s.leafId) : null;
  }

  /** 保守写盘：先尝试完整保存，配额爆了再逐步丢图片 */
  function persistSafe() {
    try {
      persist();
    } catch (e) {
      sessions = sessions.map(stripHeavySession);
      try { persist(); } catch (e2) {
        // 还不行就只留最近 20 个会话的纯文本（图片与附件元数据都丢掉）
        function dropFiles(list) {
          return (list || []).map(function (m) {
            return Object.assign({}, m, {
              files: (m.files || []).map(function (f) {
                return { name: f.name, size: f.size, fileId: f.fileId, imageDropped: true };
              })
            });
          });
        }
        sessions = sessions.slice(0, 20).map(function (s) {
          var t = Object.assign({}, s);
          if (t.nodes) t.nodes = dropFiles(t.nodes);
          if (t.messages) t.messages = dropFiles(t.messages);
          return t;
        });
        try { persist(); } catch (e3) {}
      }
    }
  }

  /* ---------------- 主题 ---------------- */
  function applyTheme(t) {
    document.documentElement.dataset.theme = t === 'dark' ? 'dark' : 'light';
    LS.set('theme', document.documentElement.dataset.theme);
    // 让状态栏 / 导航栏图标跟着变
    if (hasNative) {
      try { window.AndroidBridge.setTheme(document.documentElement.dataset.theme); } catch (e) {}
    }
  }
  (function initTheme() {
    // index.html 里的内联脚本已经在首帧前定好主题（避免闪烁），这里只做同步与兜底
    var t = document.documentElement.dataset.theme;
    if (t !== 'dark' && t !== 'light') {
      var saved = LS.get('theme', null);
      if (saved) t = saved;
      else t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    // 不重复写 localStorage，只应用
    document.documentElement.dataset.theme = t;
    LS.set('theme', t);
    if (hasNative) {
      try { window.AndroidBridge.setTheme(t); } catch (e) {}
    }
  })();

  /* ---------------- 元素 ---------------- */
  var E = {
    scroll: $('#scroll'),
    messages: $('#messages'),
    input: $('#input'),
    btnSend: $('#btnSend'),
    hint: $('#hintText'),
    usage: $('#usageText'),
    attachStrip: $('#attachStrip'),
    sheet: $('#sheet'),
    sheetMask: $('#sheetMask'),
    sheetList: $('#sheetList'),
    actionSheet: $('#actionSheet'),
    actionMask: $('#actionMask'),
    actionTitle: $('#actionTitle'),
    actionBody: $('#actionBody'),
    settings: $('#settings'),
    settingsMask: $('#settingsMask'),
    toast: $('#toast'),
    toBottom: $('#btnToBottom'),
    sessionSearch: $('#sessionSearch'),
    btnThink: $('#btnThink'),
    btnSearch: $('#btnSearch'),
    btnEditCancel: $('#btnEditCancel'),
    composer: $('#composer'),
    sourcesSheet: $('#sourcesSheet'),
    sourcesMask: $('#sourcesMask'),
    sourcesBody: $('#sourcesBody'),
    sourcesCount: $('#sourcesCount')
  };

  /* ---------------- 工具函数 ---------------- */
  function toast(msg, isErr) {
    E.toast.textContent = msg;
    E.toast.className = 'toast show' + (isErr ? ' err' : '');
    E.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      E.toast.classList.remove('show');
      setTimeout(function () { E.toast.hidden = true; }, 220);
    }, 2400);
  }

  function fmtSize(n) {
    if (!n) return '';
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + 'KB';
    return (n / 1024 / 1024).toFixed(1) + 'MB';
  }

  function fmtTime(ts) {
    var d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function fmtNum(n) {
    if (!n) return '0';
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  function scrollBottom(force) {
    if (force) {
      E.scroll.scrollTop = E.scroll.scrollHeight;
      updateToBottom();
      return;
    }
    var near = E.scroll.scrollHeight - E.scroll.scrollTop - E.scroll.clientHeight < 200;
    if (near) E.scroll.scrollTop = E.scroll.scrollHeight;
    updateToBottom();
  }

  /** 离底部较远时露出「回到底部」按钮 */
  function updateToBottom() {
    if (!E.toBottom) return;
    var far = E.scroll.scrollHeight - E.scroll.scrollTop - E.scroll.clientHeight > 320;
    E.toBottom.hidden = !far;
    E.toBottom.classList.toggle('show', far);
  }

  /* ---------------- 渲染：欢迎页 ---------------- */
  function renderWelcome() {
    E.messages.innerHTML = '';
    var wrap = el('div', 'welcome');
    wrap.innerHTML =
      '<div class="welcome-mark">' +
      '<svg viewBox="0 0 28 28" width="34" height="34" fill="none">' +
      '<path d="M4.5 17.5c0-5.2 4.2-9.4 9.4-9.4 3.9 0 7.3 2.4 8.7 5.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
      '<path d="M4.5 17.5c2.6 0 3.7 1.7 5 3.1 1.4 1.4 3 2.6 5.7 2.6 3.1 0 5.1-1.6 6.3-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
      '<circle cx="19.6" cy="11.4" r="1.05" fill="currentColor"/>' +
      '</svg></div>' +
      '<h1>今天想聊点什么？</h1>' +
      '<p>' + (settings.apiKey
        ? (settings.webSearch ? '联网搜索已开启，遇到时效问题会自动去查。' : '联网搜索已关闭。')
        : '还差一步：填入 DeepSeek API Key 就能开始。') + '</p>' +
      (settings.apiKey ? '' :
        '<button class="onboard-btn" type="button">' +
        '<span>填入 API Key</span>' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>' +
        '</button>' +
        '<p class="onboard-hint">Key 只保存在本机，不会上传到任何第三方。</p>') +
      '<div class="suggests"></div>';

    var SUGGEST_ICONS = {
      news: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5S9.5 5.8 12 3.5Z"/>',
      link: '<path d="M10 13.5a3.6 3.6 0 0 0 5.1 0l2.2-2.2a3.6 3.6 0 0 0-5.1-5.1L11 7.4"/><path d="M14 10.5a3.6 3.6 0 0 0-5.1 0L6.7 12.7a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"/>',
      doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 16.5h4"/>',
      code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M13 4l-2 16"/>'
    };
    var data = [
      ['news', '查最新消息', '今天有什么值得关注的科技新闻？', '汇总今日要闻并附来源'],
      ['link', '读一篇网页', '帮我总结 https://nodejs.org/en/blog 最近一篇文章', '丢个链接，提炼重点'],
      ['doc', '解析文档', '', '点左下角 + 选 PDF / Word / 图片'],
      ['code', '写点代码', '用 Node.js 写一个带重试和超时的 fetch 封装', '写出可以直接用的实现']
    ];
    var onboard = wrap.querySelector('.onboard-btn');
    if (onboard) {
      onboard.addEventListener('click', function () { openSheet('settings'); });
    }

    var box = wrap.querySelector('.suggests');
    data.forEach(function (item) {
      var b = el('button', 'suggest');
      b.innerHTML =
        '<span class="s-ico"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        SUGGEST_ICONS[item[0]] + '</svg></span>' +
        '<span class="s-main"><b>' + MD.esc(item[1]) + '</b><span>' + MD.esc(item[3]) + '</span></span>' +
        '<span class="s-go" aria-hidden="true">›</span>';
      b.addEventListener('click', function () {
        if (item[0] === 'doc') { pickFile(); return; }
        E.input.value = item[2];
        autosize();
        updateSend();
        send();
      });
      box.appendChild(b);
    });
    E.messages.appendChild(wrap);
    E.usage.textContent = '';
  }

  /* ---------------- 渲染：消息 ---------------- */
  function addUserMessage(text, files, animate, nodeId) {
    var w = E.messages.querySelector('.welcome');
    if (w) w.remove();
    var msg = el('div', 'msg user' + (animate === false ? ' no-anim' : ''));
    if (nodeId) msg.dataset.id = nodeId;
    var body = el('div', 'msg-body');
    var bubble = el('div', 'bubble', text || '');
    var uActs = el('div', 'msg-actions user-actions');
    var btnEdit = el('button', 'act-edit');
    btnEdit.type = 'button';
    btnEdit.setAttribute('aria-label', '编辑提问');
    btnEdit.title = '编辑这条提问（发送后保留旧版本）';
    btnEdit.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17Z"/><path d="m14.5 7 3 3"/></svg>';
    uActs.appendChild(btnEdit);
    body.appendChild(bubble);
    body.appendChild(uActs);
    if (files && files.length) {
      var box = el('div', 'msg-files');
      files.forEach(function (f) {
        var chip = el('div', 'chip');
        chip.innerHTML = '<span class="c-name"></span><span class="c-size"></span>';
        chip.querySelector('.c-name').textContent = f.name;
        chip.querySelector('.c-size').textContent = f.imageDropped ? '已省略' : fmtSize(f.size);
        box.appendChild(chip);
      });
      body.appendChild(box);
    }
    msg.appendChild(body);
    E.messages.appendChild(msg);
    return msg;
  }

  function addAssistantMessage(initialContent, initialReasoning, toolLog, model, animate, nodeId) {
    var w = E.messages.querySelector('.welcome');
    if (w) w.remove();

    var msg = el('div', 'msg assistant' + (animate === false ? ' no-anim' : ''));
    if (nodeId) msg.dataset.id = nodeId;
    msg.innerHTML =
      '<div class="msg-avatar" aria-hidden="true"><svg viewBox="0 0 28 28" width="18" height="18" fill="none">' +
      '<path d="M4.5 17.5c0-5.2 4.2-9.4 9.4-9.4 3.9 0 7.3 2.4 8.7 5.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      '<path d="M4.5 17.5c2.6 0 3.7 1.7 5 3.1 1.4 1.4 3 2.6 5.7 2.6 3.1 0 5.1-1.6 6.3-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      '<circle cx="19.6" cy="11.4" r="1.3" fill="currentColor"/></svg></div>' +
      '<div class="msg-body">' +
      '<div class="msg-role"><span>DeepSeek</span><span class="model-tag"></span></div>' +
      '<div class="process-box open" hidden>' +
      '<button class="process-head" type="button">' +
      '<span class="spinner"></span>' +
      '<span class="p-title">思考中…</span>' +
      '<span class="p-meta"></span>' +
      '<svg class="caret" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>' +
      '<span class="p-more">收起</span>' +
      '</button>' +
      '<div class="process-body">' +
      '<div class="reasoning" hidden>' +
      '<button class="reasoning-head" type="button">' +
      '<span class="r-title">思考过程</span>' +
      '<svg class="caret" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>' +
      '<span class="r-more">收起</span>' +
      '</button>' +
      '<div class="reasoning-body"></div>' +
      '</div>' +
      '<div class="tool-stack"></div>' +
      '</div>' +
      '</div>' +
      '<div class="prose"><p><span class="caret-blink"></span></p></div>' +
      '<div class="sources-slot"></div>' +
      '<div class="msg-actions">' +
      '<button class="act-copy" type="button" title="复制回答" aria-label="复制回答">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>' +
      '<span class="act-label">复制</span></button>' +
      '<button class="act-regen" type="button" title="重新生成（保留旧版本）" aria-label="重新生成">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-1.5 6.5"/><path d="M20 5v6h-6"/></svg>' +
      '<span class="act-label">重新生成</span></button>' +
      '<button class="act-cont" type="button" title="接着写" aria-label="继续写" hidden>' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>' +
      '<span class="act-label">继续写</span></button>' +
      '</div>' +
      '</div>';

    var roleTag = msg.querySelector('.model-tag');
    roleTag.textContent = (model || '').replace('deepseek-', '');
    var processBox = msg.querySelector('.process-box');
    var processHead = processBox.querySelector('.process-head');
    var processTitle = processBox.querySelector('.p-title');
    var processMeta = processBox.querySelector('.p-meta');
    var processMore = processBox.querySelector('.p-more');
    var toolStack = processBox.querySelector('.tool-stack');
    var reasonEl = processBox.querySelector('.reasoning');
    var reasonHead = reasonEl.querySelector('.reasoning-head');
    var reasonBody = reasonEl.querySelector('.reasoning-body');
    var reasonMore = reasonEl.querySelector('.r-more');
    var prose = msg.querySelector('.prose');
    var sourcesSlot = msg.querySelector('.sources-slot');
    var actions = msg.querySelector('.msg-actions');
    var btnCopy = actions.querySelector('.act-copy');
    var btnRegen = actions.querySelector('.act-regen');
    var btnContinue = actions.querySelector('.act-cont');
    E.messages.appendChild(msg);

    var raw = initialContent || '';
    var think = initialReasoning || '';
    var dirty = false, timer = null;
    var assistantRecord = null;
    var toolCount = 0;
    var api = { node: msg, done: false };

    processHead.addEventListener('click', function () {
      processBox.classList.toggle('open');
      processMore.textContent = processBox.classList.contains('open') ? '收起' : '展开';
    });
    reasonHead.addEventListener('click', function () {
      reasonEl.classList.toggle('open');
      reasonMore.textContent = reasonEl.classList.contains('open') ? '收起' : '展开';
    });

    function updateProcessHeader(finished) {
      var hasThink = !!think;
      if (!finished) {
        if (toolCount > 0 && hasThink) processTitle.textContent = '正在思考与检索…';
        else if (toolCount > 0) processTitle.textContent = '正在执行操作…';
        else processTitle.textContent = '思考中…';
        processMeta.textContent = toolCount > 0 ? toolCount + ' 步' : '';
        return;
      }
      if (hasThink && toolCount > 0) {
        processTitle.textContent = '思考与执行过程';
        processMeta.textContent = toolCount + ' 步操作';
      } else if (toolCount > 0) {
        processTitle.textContent = '执行过程';
        processMeta.textContent = toolCount + ' 步操作';
      } else if (hasThink) {
        processTitle.textContent = '思考过程';
        processMeta.textContent = '';
      }
    }

    /** 流结束 / 历史消息统一收尾：折叠两层面板、去 spinner、更新摘要 */
    function finalizeProcess() {
      if (processBox.hidden || processBox.dataset.finished) return;
      processBox.dataset.finished = '1';
      var sp = processHead.querySelector('.spinner');
      if (sp) sp.remove();
      processBox.classList.remove('open');
      processMore.textContent = '展开';
      if (!reasonEl.hidden) {
        reasonEl.classList.remove('open');
        reasonMore.textContent = '展开';
      }
      updateProcessHeader(true);
    }

    function ensureReasoning() {
      processBox.hidden = false;
      if (reasonEl.hidden) {
        reasonEl.hidden = false;
        reasonEl.classList.add('open');
        reasonMore.textContent = '收起';
      }
      updateProcessHeader(false);
    }

    api.setReasoning = function (text) {
      think = text;
      ensureReasoning();
      reasonBody.textContent = think;
      reasonBody.scrollTop = reasonBody.scrollHeight;
    };

    /** 工具卡片统一走这里：计入步数并确保过程面板可见 */
    api.addTool = function (tool) {
      toolCount += 1;
      processBox.hidden = false;
      updateProcessHeader(false);
      return addToolCard(toolStack, tool);
    };

    api.setContent = function (text) {
      raw = text;
      if (dirty) return;
      dirty = true;
      if (timer) return;
      timer = setTimeout(flush, 55);
    };

    var anns = null;
    var srcList = null;

    function flush() {
      timer = null;
      dirty = false;
      var html = MD.render(raw);
      prose.__raw = raw;
      prose.innerHTML = html || '<p><span class="caret-blink"></span></p>';
      if (anns && anns.length) {
        srcList = applyAnnotations(prose, anns, function (idx) {
          openSourcesDrawer(srcList, idx);
        });
        renderSourcesTrigger(sourcesSlot, srcList);
      }
      if (state_done()) {
        var c = prose.querySelector('.caret-blink');
        if (c) c.remove();
      }
    }

    api.setAnnotations = function (list) {
      anns = list;
      if (!timer) flush();
    };

    api.getAnnotations = function () { return anns; };

    function state_done() { return api.done || !streaming; }

    api.finish = function () {
      api.done = true;
      if (dirty || timer) { clearTimeout(timer); timer = null; flush(); }
      var c = prose.querySelector('.caret-blink');
      if (c) c.remove();
      finalizeProcess();
    };

    /** 红色错误块（请求失败） */
    api.fail = function (message) {
      var c = prose.querySelector('.caret-blink');
      if (c) c.remove();
      var box = el('div', 'err-box');
      box.appendChild(el('span', 'err-text', message));
      var retry = el('button', 'err-retry', '重试');
      retry.addEventListener('click', function () {
        box.remove();
        resendLast();
      });
      box.appendChild(retry);
      actions.parentNode.insertBefore(box, actions);
    };

    /** 中性提示块（截断 / 中止 / 内容拦截），不丢已生成内容 */
    api.notice = function (message, kind) {
      var c = prose.querySelector('.caret-blink');
      if (c) c.remove();
      var box = el('div', 'notice-box' + (kind === 'warn' ? ' warn' : ''), message);
      actions.parentNode.insertBefore(box, actions);
    };

    api.tools = toolStack;
    api.resetTools = function () { toolCount = 0; toolStack.innerHTML = ''; };
    api.getContent = function () { return raw; };
    api.getReasoning = function () { return think; };

    btnCopy.addEventListener('click', function () {
      copyText(prose.innerText);
    });
    /** 重新生成：同一个提问再答一次。旧回答不删，留作分支的另一版 */
    btnRegen.addEventListener('click', function () {
      if (streaming) { toast('正在生成，请先停止', true); return; }
      if (!assistantRecord) { toast('这条回答还没保存', true); return; }
      var s = currentSession();
      if (!s || messages.indexOf(assistantRecord) < 0) { toast('找不到这条回答', true); return; }
      // 本次回答接在它前面那条提问下面；旧回答仍在树里，用 ‹ 1/2 › 切回
      regenParentId = assistantRecord.parentId || null;
      runRequest(true, '');
    });

    /** 继续写：把已有内容作为前缀，让模型接着补 */
    btnContinue.addEventListener('click', function () {
      if (streaming) return;
      if (!assistantRecord) return;
      if (messages.indexOf(assistantRecord) < 0) return;
      var carried = assistantRecord.content;
      regenParentId = assistantRecord.parentId || null;
      runRequest(false, carried);
    });

    api.setContinue = function (show) { btnContinue.hidden = !show; };

    /** 绑定这条 DOM 对应的数据记录，供重新生成/继续写定位 */
    api.bindRecord = function (rec) {
      assistantRecord = rec;
      btnContinue.hidden = !(rec && rec.truncated);
    };

    if (toolLog && toolLog.length) {
      toolLog.forEach(function (t) { api.addTool(t); });
    }
    if (think) api.setReasoning(think);
    if (raw) api.setContent(raw);
    return api;
  }

  function renderMessages() {
    E.messages.innerHTML = '';
    if (!messages.length) { renderWelcome(); return; }
    var list = messages;
    if (viewCutId) {
      var cut = -1;
      for (var ci = 0; ci < messages.length; ci++) if (messages[ci].id === viewCutId) cut = ci;
      if (cut >= 0) list = messages.slice(0, cut);
    }
    if (!list.length) { renderWelcome(); return; }
    list.forEach(function (m) {
      if (m.role === 'user') addUserMessage(m.content, m.files, false, m.id);
      else if (m.role === 'assistant') {
        var a = addAssistantMessage(m.content, m.reasoning, m.tools, m.model, false, m.id);
        if (m.annotations && m.annotations.length) a.setAnnotations(m.annotations);
        a.bindRecord(m);
        if (m.truncated) a.notice('这条回答曾因长度上限被截断', 'warn');
        a.finish();
        a.done = true;
      }
    });
    paintBranches();
    scrollBottom(true);
  }

  /** 给「同一位置有多个版本」的消息挂上 ‹ 1/2 › */
  function paintBranches() {
    var btns = E.messages.querySelectorAll('.branch-switch');
    for (var i = 0; i < btns.length; i++) btns[i].remove();
    var info = branchInfo();
    Object.keys(info).forEach(function (id) {
      var msg = E.messages.querySelector('.msg[data-id="' + id + '"]');
      if (!msg) return;
      var it = info[id];
      var sw = el('span', 'branch-switch');
      var prev = el('button', 'b-prev', '‹');
      var count = el('span', 'b-count', it.index + ' / ' + it.count);
      var next = el('button', 'b-next', '›');
      prev.type = 'button'; next.type = 'button';
      prev.disabled = it.index <= 1;
      next.disabled = it.index >= it.count;
      prev.addEventListener('click', function (e) { e.stopPropagation(); switchBranch(id, -1); });
      next.addEventListener('click', function (e) { e.stopPropagation(); switchBranch(id, 1); });
      sw.appendChild(prev); sw.appendChild(count); sw.appendChild(next);
      var role = msg.querySelector('.msg-role');
      if (role) role.appendChild(sw);
    });
  }

  /** 切到同一提问的上一版 / 下一版。只挪当前分支末端，不动任何内容 */
  function switchBranch(nodeId, delta) {
    if (streaming) { toast('正在生成，先停止再切换版本', true); return; }
    var s = currentSession();
    var node = nodeById(s, nodeId);
    if (!s || !node) return;
    var sibs = siblingsOf(s, node);
    var idx = -1;
    for (var i = 0; i < sibs.length; i++) if (sibs[i].id === node.id) idx = i;
    var target = sibs[idx + delta];
    if (!target) return;
    s.leafId = deepestLeaf(s, target.id);
    syncMessages();
    persistSafe();
    renderMessages();
    renderSessions();
  }

  /* ---------------- 引用角标 ----------------
     官方 annotations 的 start_index / end_index 是「Unicode 码点」偏移。
     这里把纯文本原文映射到 DOM 文本节点上，在被引用的片段后面插入可点角标，
     并在正文末尾追加「来源」列表。映射失败（含 Markdown 标记）时只渲染来源列表。
  --------------------------------------------------- */
  /** 官方 annotations 的元素形如
   *  {type:"url_citation", url_citation:{url,title,start_index,end_index}}
   *  也有把字段摊平的实现，这里两种都兼容。 */
  function normCite(a) {
    if (!a) return null;
    var c = a.type === 'url_citation' ? (a.url_citation || a) : (a.url_citation || a);
    if (!c || !c.url) return null;
    return {
      url: c.url,
      title: c.title || '',
      start_index: typeof c.start_index === 'number' ? c.start_index : (typeof a.start_index === 'number' ? a.start_index : null),
      end_index: typeof c.end_index === 'number' ? c.end_index : (typeof a.end_index === 'number' ? a.end_index : null)
    };
  }

  function applyAnnotations(container, anns, onOpenSource) {
    var seen = {}, sources = [];
    (anns || []).forEach(function (raw) {
      var a = normCite(raw);
      if (!a) return;
      var k = a.url;
      if (!seen[k]) { seen[k] = sources.length + 1; sources.push(a); }
    });
    if (!sources.length) return sources;

    // 官方给的是「模型原始输出」的码点偏移，里面含换行、** 、表格竖线这些
    // 渲染时被吃掉的字符。所以不能要求 DOM 文本与原文等长，
    // 改用双指针对齐：沿途跳过原文里那些在 DOM 中不存在的字符，
    // 得到「DOM 码点 → 原文码点」的映射。
    var SKIP = { '\n': 1, '\r': 1, ' ': 1, '\t': 1, '*': 1, '`': 1, '#': 1, '>': 1, '|': 1, '_': 1, '~': 1, '-': 1, '\u2026': 1 };
    var domChars = [], n;
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    while ((n = walker.nextNode())) {
      var pn = n.parentNode;
      if (pn.closest && pn.closest('.code-head, button, .cite, .sources, .caret-blink')) continue;
      var cps = Array.from(n.nodeValue);
      for (var i = 0; i < cps.length; i++) domChars.push({ node: n, offset: i, ch: cps[i] });
    }
    var srcCps = Array.from(String(container.__raw || ''));

    var map = new Array(domChars.length);
    var ri = 0, matched = 0;
    for (var di = 0; di < domChars.length; di++) {
      var ch = domChars[di].ch;
      var guard = 0;
      while (ri < srcCps.length && srcCps[ri] !== ch && guard < 400) { ri++; guard++; }
      if (ri >= srcCps.length) break;
      map[di] = ri; ri++; matched++;
    }
    if (!matched || matched < domChars.length * 0.85) {
      return sources;
    }

    (anns || [])
      .map(normCite)
      .filter(function (a) { return a && a.url && typeof a.end_index === 'number'; })
      // 从后往前插，避免前面的插入影响后面的 DOM 结构
      .sort(function (a, b) { return b.end_index - a.end_index; })
      .forEach(function (a) {
        // 角标要贴在「被引用片段的最后一个字符」后面
        var di = -1;
        for (var k = 0; k < map.length; k++) {
          if (map[k] >= 0 && map[k] < a.end_index) di = k;
          else if (map[k] >= a.end_index) break;
        }
        if (di < 0) return;
        var at = domChars[di];
        var par = at.node.parentNode;
        if (par.closest && par.closest('pre, code, sup')) return;

        var val = at.node.nodeValue;
        var cps2 = Array.from(val);
        var before = cps2.slice(0, at.offset + 1).join('');
        var after = cps2.slice(at.offset + 1).join('');

        var sup = document.createElement('sup');
        sup.className = 'cite';
        sup.textContent = seen[a.url];
        sup.title = a.title || a.url;
        (function (num) {
          sup.addEventListener('click', function (e) {
            e.stopPropagation();
            if (onOpenSource) onOpenSource(num);
          });
        })(seen[a.url]);

        at.node.nodeValue = before;
        par.insertBefore(sup, at.node.nextSibling);
        if (after) par.insertBefore(document.createTextNode(after), sup.nextSibling);
      });

    return sources;
  }

  /** 回答末尾的来源入口胶囊：点开右侧抽屉，不在正文里铺链接 */
  function renderSourcesTrigger(slot, sources) {
    slot.innerHTML = '';
    if (!sources || !sources.length) return;
    var btn = el('button', 'sources-trigger');
    btn.type = 'button';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 13.5a3.6 3.6 0 0 0 5.1 0l2.2-2.2a3.6 3.6 0 0 0-5.1-5.1L11 7.4"/><path d="M14 10.5a3.6 3.6 0 0 0-5.1 0L6.7 12.7a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"/></svg>' +
      '<span>参考来源 · ' + sources.length + '</span>' +
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>';
    btn.addEventListener('click', function () { openSourcesDrawer(sources, null); });
    slot.appendChild(btn);
  }

  function openSourcesDrawer(sources, highlightNum) {
    if (!sources || !sources.length) return;
    E.sourcesCount.textContent = '· ' + sources.length + ' 条';
    E.sourcesBody.innerHTML = '';
    var hitCard = null;
    sources.forEach(function (c, idx) {
      var num = idx + 1;
      var safe = safeUrl(c.url);
      var card = safe ? el('a', 'source-card') : el('div', 'source-card');
      if (safe) { card.href = safe; card.target = '_blank'; card.rel = 'noopener'; }
      if (highlightNum === num) { card.classList.add('hit'); hitCard = card; }
      card.appendChild(el('span', 'source-idx', String(num)));
      var main = el('div', 'source-main');
      main.appendChild(el('span', 'source-title', c.title || c.url));
      var host = c.url;
      try { host = new URL(c.url).hostname; } catch (e) {}
      main.appendChild(el('span', 'source-url', host));
      card.appendChild(main);
      E.sourcesBody.appendChild(card);
    });
    E.sourcesMask.hidden = false;
    E.sourcesSheet.classList.add('open');
    E.sourcesSheet.setAttribute('aria-hidden', 'false');
    if (hitCard) {
      requestAnimationFrame(function () {
        hitCard.scrollIntoView({ block: 'nearest' });
      });
    }
  }

  function closeSourcesDrawer() {
    E.sourcesMask.hidden = true;
    E.sourcesSheet.classList.remove('open');
    E.sourcesSheet.setAttribute('aria-hidden', 'true');
  }

  /* ---------------- 工具卡片 ---------------- */
  var ICON = {
    search: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="m19.5 19.5-4.2-4.2"/></svg>',
    read: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 13.5a3.6 3.6 0 0 0 5.1 0l2.2-2.2a3.6 3.6 0 0 0-5.1-5.1L11 7.4"/><path d="M14 10.5a3.6 3.6 0 0 0-5.1 0L6.7 12.7a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"/></svg>',
    page: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>'
  };

  function addToolCard(stack, tool) {
    var card = el('div', 'tool-card');
    var head = el('button', 'tool-head');
    head.type = 'button';
    var kind = tool.kind || 'search';
    var statusText = tool.status === 'failed' ? '失败' : tool.status === 'running' ? '进行中' : '';
    head.innerHTML =
      '<span class="tool-ico">' + (ICON[kind] || ICON.search) + '</span>' +
      '<span class="tool-label"></span>' +
      '<span class="tool-meta">' + statusText + '</span>';
    head.querySelector('.tool-label').textContent = tool.label || '搜索';
    var body = el('div', 'tool-body');
    head.addEventListener('click', function () { card.classList.toggle('open'); });
    card.appendChild(head);
    card.appendChild(body);

    var h = { card: card, body: body, head: head, label: tool.label, kind: kind };
    Object.defineProperty(h, 'status', {
      set: function (v) {
        card.classList.remove('ok', 'fail', 'running');
        card.classList.add(v === 'failed' ? 'fail' : v === 'running' ? 'running' : 'ok');
        head.querySelector('.tool-meta').textContent =
          v === 'failed' ? '失败' : v === 'running' ? '进行中' : '';
      }
    });
    h.status = tool.status || 'running';

    card.classList.add('open');
    if (tool.sources && tool.sources.length) {
      tool.sources.forEach(function (s) { body.appendChild(buildResult(s)); });
    }
    if (tool.page) body.appendChild(buildPage(tool.page));
    if (tool.error) body.appendChild(el('div', 'tool-err', tool.error));
    stack.appendChild(card);
    return h;
  }

  function buildPage(page) {
    var a = el('a', 'tool-result');
    var pu = safeUrl(page.url);
    if (pu) { a.href = pu; a.target = '_blank'; a.rel = 'noopener'; }
    else { a.setAttribute('role', 'text'); a.style.cursor = 'default'; }
    a.innerHTML = '<span class="r-title"></span><span class="r-url"></span>';
    a.querySelector('.r-title').textContent = page.title || '网页';
    a.querySelector('.r-url').textContent = page.url || '';
    return a;
  }

  /** 工具调用完成：就地填充来源 / 页面 / 错误 */
  function fillToolCard(h, call) {
    var status = call.status || 'completed';
    h.status = status;
    h.body.innerHTML = '';
    var hasContent = false;

    (call.sources || []).forEach(function (s) {
      h.body.appendChild(buildResult(s));
      hasContent = true;
    });
    if (call.page) { h.body.appendChild(buildPage(call.page)); hasContent = true; }

    // 图片搜索的图片结果
    if (call.images && call.images.length) {
      var grid = el('div', 'img-grid');
      call.images.forEach(function (im) {
        var a = el('a');
        var iu = safeImgUrl(im.url);
        if (iu) { a.href = iu; a.target = '_blank'; a.rel = 'noopener'; }
        a.innerHTML = '<img alt="">';
        a.querySelector('img').src = safeImgUrl(im.thumbnail) || iu;
        grid.appendChild(a);
      });
      h.body.appendChild(grid);
      hasContent = true;
    }

    if (call.error) {
      h.body.appendChild(el('div', 'tool-err', call.error.message || call.error.code || '调用失败'));
      hasContent = true;
    }
    if (!hasContent) h.body.appendChild(el('div', 'tool-empty', '已完成'));
    return { kind: h.kind, label: h.label, status: status, sources: call.sources, page: call.page };
  }

  function buildResult(s) {
    var a = el('a', 'tool-result');
    var safe = safeUrl(s.url);
    if (safe) { a.href = safe; a.target = '_blank'; a.rel = 'noopener'; }
    else { a.setAttribute('role', 'text'); a.style.cursor = 'default'; }
    a.target = '_blank';
    a.rel = 'noopener';
    a.innerHTML = '<span class="r-title"></span><span class="r-url"></span><span class="r-snip"></span>';
    a.querySelector('.r-title').textContent = s.title || s.url || '';
    a.querySelector('.r-url').textContent = (s.site_name ? s.site_name + ' · ' : '') + (s.url || '');
    a.querySelector('.r-snip').textContent = s.snippet || '';
    return a;
  }

  /* ---------------- 输入 ---------------- */
  function autosize() {
    E.input.style.height = 'auto';
    E.input.style.height = Math.min(E.input.scrollHeight, 132) + 'px';
  }

  /** 进入编辑态：把那条提问放回输入框，发送时在原位置长出新的版本 */
  function startEdit(nodeId) {
    if (streaming) { toast('正在生成，先停止再编辑', true); return; }
    var s = ensureTree(currentSession());
    var node = nodeById(s, nodeId);
    if (!node || node.role !== 'user') { toast('这条提问还没保存', true); return; }
    editingId = nodeId;
    E.input.value = node.content || '';
    autosize();
    updateSend();
    // 就地编辑：先把视图截到这条提问之前，后面的内容暂时收起，
    // 发送后新版本接在这里；想回看旧内容点「取消」或切分支。
    viewCutId = nodeId;
    renderMessages();
    E.hint.textContent = '修改这条提问，发送后成为新版本，旧回答保留（‹ › 可切回）';
    E.btnEditCancel.hidden = false;
    E.input.focus();
    try { E.input.setSelectionRange(E.input.value.length, E.input.value.length); } catch (e) {}
    // 滚到输入框附近
    E.scroll.scrollTop = E.scroll.scrollHeight;
  }

  function cancelEdit() {
    if (!editingId) return;
    editingId = null;
    viewCutId = null;
    E.input.value = '';
    autosize();
    updateSend();
    E.hint.textContent = '内容由 DeepSeek 生成，请注意核实';
    E.btnEditCancel.hidden = true;
    renderMessages();
  }

  function updateSend() {
    var ready = attachments.filter(function (f) { return f.fileId || f.image; }).length;
    var pending = attachments.some(function (f) { return f.uploading; });
    var has = E.input.value.trim().length > 0 || ready > 0;
    E.btnSend.disabled = streaming ? false : (!has || (pending && !E.input.value.trim()));
    E.btnSend.classList.toggle('stop', streaming);
  }

  function renderAttachments() {
    E.attachStrip.innerHTML = '';
    if (!attachments.length) { E.attachStrip.hidden = true; return; }
    E.attachStrip.hidden = false;
    attachments.forEach(function (f, idx) {
      var chip = el('div', 'chip' + (f.uploading ? ' uploading' : ''));
      var nameEl = el('span', 'c-name');
      nameEl.textContent = f.name;
      chip.appendChild(nameEl);
      if (f.image) chip.classList.add('is-image');
      if (f.error) chip.classList.add('is-error');
      if (f.uploading) {
        if (f.parsing) {
          chip.appendChild(el('span', 'c-size', '解析中'));
        } else if (f.progress > 0 && f.progress < 1) {
          chip.appendChild(el('span', 'c-size', Math.round(f.progress * 100) + '%'));
        } else {
          chip.appendChild(el('span', 'mini-spin'));
        }
      } else if (f.error) {
        chip.appendChild(el('span', 'c-size', '失败'));
      } else {
        chip.appendChild(el('span', 'c-size', fmtSize(f.size)));
      }
      var x = el('button', 'c-x');
      x.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      x.addEventListener('click', function () {
        if (f.cancel) { try { f.cancel(); } catch (e) {} }
        attachments.splice(idx, 1);
        renderAttachments();
        updateSend();
      });
      chip.appendChild(x);
      E.attachStrip.appendChild(chip);
    });
  }

  /* ---------------- 下滑关闭手势 ---------------- */
  /** 只在内容滚动到顶部时才接管向下拖拽，避免和内部滚动冲突 */
  function bindSwipeDown(panel, onClose) {
    if (!panel) return;
    var startY = 0, startX = 0, dy = 0, active = false, decided = false, fromTop = false;

    panel.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      startY = t.clientY;
      startX = t.clientX;
      dy = 0;
      active = true;
      decided = false;
      // 面板内可滚动区滚到顶时才允许拖拽关闭
      var sc = e.target.closest ? e.target.closest('.sheet-body, .sheet-list') : null;
      fromTop = !sc || sc.scrollTop <= 0;
      panel.style.transition = 'none';
    }, { passive: true });

    panel.addEventListener('touchmove', function (e) {
      if (!active) return;
      var t = e.touches[0];
      dy = t.clientY - startY;
      var dx = Math.abs(t.clientX - startX);

      if (!decided) {
        // 第一次移动就判断方向，横向手势交还给内部滚动
        if (Math.abs(dy) < 6 && dx < 6) return;
        decided = true;
        if (dx > Math.abs(dy) || dy < 0 || !fromTop) { active = false; return; }
      }
      if (dy <= 0) return;
      // 阻尼：往下拖得越远越费力
      var shift = Math.min(dy * 0.65, panel.offsetHeight * 0.5);
      panel.style.transform = 'translateY(' + shift + 'px)';
      if (e.cancelable) e.preventDefault();
    }, { passive: false });

    panel.addEventListener('touchend', function () {
      if (!active) { panel.style.transform = ''; panel.style.transition = ''; return; }
      active = false;
      panel.style.transition = '';
      panel.style.transform = '';
      if (dy > 90) onClose();
      dy = 0;
    });
  }

  /* ---------------- 打开/关闭面板 ---------------- */
  function openSheet(which) {
    if (which === 'sessions') {
      if (E.sessionSearch) E.sessionSearch.value = '';
      renderSessions();
      E.sheet.hidden = false;
      E.sheetMask.hidden = false;
    } else if (which === 'settings') {
      fillSettings();
      E.settings.hidden = false;
      E.settingsMask.hidden = false;
    }
  }

  function closeAll() {
    E.sheet.hidden = true;
    E.sheetMask.hidden = true;
    E.settings.hidden = true;
    E.settingsMask.hidden = true;
    E.actionSheet.hidden = true;
    E.actionMask.hidden = true;
    closeSourcesDrawer();
  }

  function showActions(title, items) {
    E.actionTitle.textContent = title;
    E.actionBody.innerHTML = '';
    items.forEach(function (it) {
      var b = el('button', 'action-item' + (it.danger ? ' danger' : ''), it.label);
      if (it.icon) b.insertAdjacentHTML('afterbegin', it.icon);
      b.addEventListener('click', function () {
        closeAll();
        it.run();
      });
      E.actionBody.appendChild(b);
    });
    E.actionSheet.hidden = false;
    E.actionMask.hidden = false;
  }

  function renderSessions() {
    E.sheetList.innerHTML = '';
    if (!sessions.length) {
      E.sheetList.appendChild(el('div', 'empty', '还没有会话\n点右上角 + 开始'));
      return;
    }

    var q = (E.sessionSearch && E.sessionSearch.value || '').trim().toLowerCase();
    var list = sessions;
    if (q) {
      list = sessions.filter(function (s) {
        if ((s.title || '').toLowerCase().indexOf(q) >= 0) return true;
        // 也搜正文，找不到标题就翻内容
        var pool = ensureTree(s).nodes || [];
        return pool.some(function (m) {
          return m.role === 'user' && (m.content || '').toLowerCase().indexOf(q) >= 0;
        });
      });
      if (!list.length) {
        E.sheetList.appendChild(el('div', 'empty', '没有匹配「' + q + '」的会话'));
        return;
      }
    }

    // 按更新时间分成 今天/更早 两组，找旧会话不用在长列表里翻
    var todayStr = new Date().toDateString();
    var groups = { '今天': [], '更早': [] };
    list.forEach(function (s) {
      groups[new Date(s.updatedAt).toDateString() === todayStr ? '今天' : '更早'].push(s);
    });
    ['今天', '更早'].forEach(function (label) {
      var arr = groups[label];
      if (!arr.length) return;
      E.sheetList.appendChild(el('div', 'sess-group', label));
      arr.forEach(addSessRow);
    });
  }

  function addSessRow(s) {
      var row = el('div', 'sess' + (s.id === currentId ? ' active' : ''));
      var t = el('span', 's-title');
      t.textContent = s.title || '新对话';
      var time = el('span', 's-time', fmtTime(s.updatedAt));
      var del = el('button', 's-del');
      del.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (streaming && currentId === s.id) stopStream();
        sessions = sessions.filter(function (x) { return x.id !== s.id; });
        if (currentId === s.id) {
          currentId = sessions.length ? sessions[0].id : null;
          if (!currentId) newSession();
          else LS.set('currentId', currentId);
          syncMessages();
          renderMessages();
        }
        persist();
        renderSessions();
      });
      row.appendChild(t);
      row.appendChild(time);
      row.appendChild(del);
      row.addEventListener('click', function () {
        // 切走之前必须停掉正在进行的流，否则会在后台继续烧 token
        if (streaming) stopStream();
        currentId = s.id;
        ensureTree(s);
        syncMessages();
        LS.set('currentId', currentId);
        renderMessages();
        closeAll();
      });
      E.sheetList.appendChild(row);
  }

  /* =========================================================
     DeepSeek API
     ========================================================= */

  function apiUrl(path) {
    var base = (settings.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');
    return base + path;
  }

  function authHeaders(extra) {
    return Object.assign({
      'Authorization': 'Bearer ' + settings.apiKey
    }, extra || {});
  }

  /** 官方约束：服务端联网工具与文件解析都要求 deepseek-flash */
  function modelSupportsTools() { return settings.model === 'deepseek-flash'; }

  function buildTools() {
    var tools = [];
    if (!modelSupportsTools()) return tools;
    if (settings.webSearch) tools.push({ type: 'deepseek_web_search' });
    if (settings.readUrl) tools.push({ type: 'deepseek_read_url' });
    return tools;
  }

  function buildBody(msgs, stream) {
    var body = {
      model: settings.model,
      messages: msgs,
      stream: !!stream
    };
    if (stream) body.stream_options = { include_usage: true };
    body.thinking = { type: settings.thinking ? 'enabled' : 'disabled' };
    if (settings.safety) body.safety_check = { level: 'high' };
    if (settings.autoTitle) body.title = { enabled: true };

    var tools = buildTools();
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    return body;
  }

  /** 按 purpose / 文件名判断是不是图片附件 */
  function isImageAttachment(f) {
    if (!f) return false;
    if (f.purpose === 'text_recognition') return true;
    return /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(String(f.name || ''));
  }

  /**
   * 把历史消息整理成 API 格式。
   * inlineImages=true 只用于「本轮刚发出去的这一条」——历史轮次里图片
   * 一律退化成 file_id 引用，否则每轮都会把几十 MB 的 base64 重新塞一遍，
   * 手机上又慢又容易被运营商/代理掐断。
   */
  function todayLine() {
    var d = new Date();
    return '今天的日期是 ' + d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate()
      + ' 日（星期' + '日一二三四五六'.charAt(d.getDay()) + '）。'
      + '回答涉及时效性的问题（如"今天""最新""近期"）时，以此日期为准。';
  }

  function toApiMessages(prefix, upToId) {
    var out = [];
    // 模型不知道"今天"是几号，必须客户端注入——否则问时效性问题它按训练数据里的旧日期答
    out.push({ role: 'system', content: todayLine() });
    if (settings.systemPrompt) out.push({ role: 'system', content: settings.systemPrompt });
    // upToId：只带到这条消息为止（编辑旧提问时不能把它后面的内容也塞给模型）
    var src = messages;
    if (upToId) {
      var idx = -1;
      for (var i = 0; i < messages.length; i++) if (messages[i].id === upToId) idx = i;
      if (idx >= 0) src = messages.slice(0, idx + 1);   // 含这条提问本身
    }
    // 只有最后这一条（刚发出的那个提问）值得带原图 base64；
    // 更早的轮次一律用 file_id，否则历史越长请求体越离谱。
    var lastUserId = null;
    for (var k = src.length - 1; k >= 0; k--) {
      if (src[k] && src[k].role === 'user') { lastUserId = src[k].id; break; }
    }
    src.forEach(function (m) {
      if (m.role === 'user') {
        if (m.files && m.files.length) {
          var parts = [];
          var notes = [];
          m.files.forEach(function (f) {
            // 本轮：图片走 image_url（data URL）保住原图
            if (m.id === lastUserId && f.image) {
              parts.push({ type: 'image_url', image_url: { url: f.image } });
            } else if (f.fileId && !isImageAttachment(f)) {
              // 文档交给官方解析
              parts.push({ type: 'file', file_id: f.fileId });
            } else if (isImageAttachment(f)) {
              // 历史轮次的图片：base64 已剥掉；拿图片的 file_id 当文档喂会被官方拒绝，
              // 所以只留一句占位说明，别让整个请求 400。
              notes.push('（之前发过一张图片' + (f.name ? '：' + f.name : '') + '）');
            }
          });
          var bodyText = m.content || (parts.length ? '请看看这些内容。' : '');
          if (notes.length) bodyText += (bodyText ? '\n' : '') + notes.join('\n');
          if (!parts.length) { out.push({ role: 'user', content: bodyText }); return; }
          parts.push({ type: 'text', text: bodyText || '请看看这些内容。' });
          out.push({ role: 'user', content: parts });
        } else {
          out.push({ role: 'user', content: m.content });
        }
      } else if (m.role === 'assistant' && m.content) {
        var am = { role: 'assistant', content: m.content };
        // 官方要求：上一轮的 server_tool_calls / annotations 原样回传，
        // 否则模型会重复搜索、或引用编号对不上。
        if (m.serverCalls) am.server_tool_calls = m.serverCalls;
        if (m.annotations) am.annotations = m.annotations;
        out.push(am);
      }
    });
    // 继续写：把已有内容作为助手前缀，引导模型接着补而不是重写
    if (prefix) out.push({ role: 'assistant', content: prefix });
    return out;
  }

  /* ---------------- 文件上传 ---------------- */
  var uploadSeq = 0;

  function pickFile() {
    closeAll();
    if (hasNative) {
      showActions('添加附件', [
        { label: '选择文件（PDF / Word / 图片…）', icon: ICON.page, run: function () { nativePick('file'); } },
        { label: '拍照', icon: ICON.read, run: function () { nativePick('photo'); } }
      ]);
    } else {
      // 浏览器调试环境
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '*/*';
      inp.addEventListener('change', function () {
        if (inp.files && inp.files[0]) browserPick(inp.files[0]);
      });
      inp.click();
    }
  }

  function nativePick(kind) {
    var cbId = 'cb' + (++uploadSeq);
    window.__nativeCallbacks = window.__nativeCallbacks || {};
    window.__nativeCallbacks[cbId] = function (res) {
      delete window.__nativeCallbacks[cbId];
      if (!res.ok) { if (res.error && res.error !== '已取消') toast(res.error, true); return; }

      // 多选取回：逐个入队
      if (res.payloads) {
        res.payloads.forEach(handlePicked);
        return;
      }
      handlePicked(res.payload);
    };
    if (kind === 'photo') window.AndroidBridge.takePhoto(cbId);
    else window.AndroidBridge.pickFile(cbId);
  }

  /** 处理一个被选中的文件 */
  function handlePicked(p) {
    if (!p) return;

    // 图片直接内联成 data URL 交给模型看图，不走文件解析
    if (/^image\//.test(p.mime || '') && p.data) {
      if (p.size > 40 * 1024 * 1024) { toast('图片太大，请压缩后再试', true); return; }
      var raw = 'data:' + p.mime + ';base64,' + p.data;
      shrinkImage(raw, p.mime).then(function (small) {
        addImageAttachment(p.name, p.mime, Math.round(small.length * 0.75), small);
      });
      return;
    }
    if (p.chunked) {
      uploadFile({ name: p.name, mime: p.mime, size: p.size, chunkedPath: p.path });
    } else {
      uploadFile({ name: p.name, mime: p.mime, size: p.size, bytes: base64ToBytes(p.data) });
    }
  }

  /** 图片附件：本地立即就绪，不经过 /files */
  function addImageAttachment(name, mime, size, dataUrl) {
    var item = {
      name: name,
      size: size,
      mime: mime,
      uploading: true,
      image: dataUrl,       // 本轮直接内联发出去
      fileId: null
    };
    attachments.push(item);
    renderAttachments();
    updateSend();

    // 同时上传一份换取 file_id：图片只存在内存里的话，
    // 一旦刷新页面这张图就彻底没了（历史里也只剩一句占位）。
    // 注意 Files API 只有 deepseek-flash 支持（v4-pro 没有 tools/files 能力）。
    if (settings.model !== 'deepseek-flash') {
      item.uploading = false;
      renderAttachments();
      updateSend();
      toast('图片已添加（当前模型不支持文件接口，仅本次可用）', true);
      return;
    }

    var purpose = purposeFor(name, mime);
    var fd = new FormData();
    fd.append('purpose', purpose);          // 官方要求 purpose 排在 file 前
    fd.append('file', dataUrlToBlob(dataUrl), name || 'photo.jpg');
    postFile(fd).then(function (data) {
      item.fileId = data.id;
      item.purpose = purpose;
      item.uploading = false;
      renderAttachments();
      updateSend();
      toast('图片已就绪');
    }).catch(function (err) {
      // 传不上去也不影响本轮（image_url 还在），只是以后轮次看不到原图
      item.fileId = null;
      item.uploading = false;
      renderAttachments();
      updateSend();
      toast('图片已添加（仅本次可用）：' + (err.message || ''), true);
    });
  }

  /** data:image/...;base64,xxx → Blob */
  function dataUrlToBlob(dataUrl) {
    try {
      var comma = String(dataUrl).indexOf(',');
      var head = dataUrl.slice(0, comma);
      var mime = (/data:([^;]+)/.exec(head) || [])[1] || 'image/jpeg';
      var bin = atob(dataUrl.slice(comma + 1));
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    } catch (e) {
      return new Blob([''], { type: 'application/octet-stream' });
    }
  }

  window.__nativeResolve = function (cbId, result) {
    var fn = (window.__nativeCallbacks || {})[cbId];
    if (fn) fn(result);
  };

  function browserPick(file) {
    var reader = new FileReader();
    reader.onload = function () {
      uploadFile({
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        bytes: new Uint8Array(reader.result)
      });
    };
    reader.readAsArrayBuffer(file);
  }

  function base64ToBytes(b64) {
    if (!b64) return new Uint8Array(0);
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** purpose 判定：PDF/Office/扫描件走 text_recognition，文本与图片走 user_data */
  /** 以文字为主的文档走 text_recognition；文本/表格/电子书走 user_data（不计费） */
  /**
   * 官方三种 purpose：
   *   user_data             纯文本/表格/电子书（不计费）
   *   rich_layout_recognition  PDF / Office（保留版式与图）
   *   text_recognition       图片
   * 注意：文档用 text_recognition 是「按图片 OCR」的意思，版式会丢；
   * 图片用 user_data 会直接解析失败。以前这里的映射是错的。
   */
  function purposeFor(name, mime) {
    var ext = (String(name || '').split('.').pop() || '').toLowerCase();
    if (['pdf', 'doc', 'docx', 'ppt', 'pptx'].indexOf(ext) >= 0) return 'rich_layout_recognition';
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'].indexOf(ext) >= 0) return 'text_recognition';
    if (/^image\//.test(mime || '')) return 'text_recognition';
    return 'user_data';
  }

  /** 把私有目录里的大文件分块读成 Blob */
  /**
   * 分块读取大文件（走 Java 侧 RandomAccessFile，避免一次读进内存）。
   * 每块转成 Uint8Array 后就交给 Blob 托管——Blob 由浏览器自己管内存，
   * 比一直攒一堆 ArrayBuffer 省得多；上传时也能直接当作 FormData 的 body。
   */
  function readChunkedFile(path, size, onProgress) {
    var CHUNK = 4 * 1024 * 1024;
    var parts = [];
    var offset = 0;
    return new Promise(function (resolve, reject) {
      (function step() {
        try {
          if (offset >= size) { resolve(new Blob(parts)); return; }
          var len = Math.min(CHUNK, size - offset);
          var b64 = window.AndroidBridge.readChunk(path, offset, len);
          if (!b64) { reject(new Error('读取文件失败')); return; }
          parts.push(new Blob([base64ToBytes(b64)]));
          offset += len;
          if (onProgress) onProgress(offset / size);
          setTimeout(step, 0);
        } catch (e) {
          reject(new Error(e && e.message ? e.message : '读取文件失败'));
        }
      })();
    });
  }

  function uploadFile(file) {
    if (!modelSupportsTools()) {
      toast('文件解析仅支持 DeepSeek Flash，请先切换模型', true);
      return;
    }
    var item = {
      name: file.name,
      size: file.size,
      mime: file.mime,
      uploading: true,
      progress: 0,
      fileId: null
    };
    attachments.push(item);
    renderAttachments();
    updateSend();

    var prep = file.chunkedPath
      ? readChunkedFile(file.chunkedPath, file.size, function (p) {
          item.progress = p;
          renderAttachments();
        }).then(function (blob) {
          try { window.AndroidBridge.deleteTemp(file.chunkedPath); } catch (e) {}
          return blob;
        })
      : Promise.resolve(new Blob([file.bytes]));

    var purpose = purposeFor(file.name, file.mime);

    item.parsing = false;

    prep.then(function (blob) {
      var fd = new FormData();
      // 官方要求：purpose 必须排在 file 前面
      fd.append('purpose', purpose);
      fd.append('file', blob, file.name);
      item.parsing = true;
      item.progress = 1;
      renderAttachments();
      return postFile(fd, function (cancel) {
        item.cancel = cancel;
      });
    }).then(function (data) {
      item.uploading = false;
      item.fileId = data.id;
      item.purpose = purpose;
      renderAttachments();
      updateSend();
      toast('已解析：' + file.name);
    }).catch(function (err) {
      item.uploading = false;
      item.error = err.message;
      renderAttachments();
      updateSend();
      toast(err.message, true);
    });
  }

  /** 上传 + 解析的超时上限。官方限制：上传 120s、解析 120s，留些余量。 */
  var UPLOAD_TIMEOUT = 260000;

  function postFile(fd, onAbortAvailable) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort('timeout'); }, UPLOAD_TIMEOUT);
    if (onAbortAvailable) onAbortAvailable(function () { ctrl.abort('cancel'); });

    return fetch(apiUrl('/files'), {
      method: 'POST',
      headers: authHeaders(),
      body: fd,
      signal: ctrl.signal
    }).catch(function (err) {
      if (err.name === 'AbortError') {
        throw new Error(ctrl.signal.reason === 'timeout'
          ? '解析超时（超过 4 分钟），请换更小的文件重试'
          : '已取消上传');
      }
      throw err;
    }).then(function (res) {
      clearTimeout(timer);
      return res;
    }).then(function (res) {
      return res.text().then(function (t) {
        if (!res.ok) {
          var msg = '上传失败 ' + res.status;
          try { msg = (JSON.parse(t).error || {}).message || msg; } catch (e) {}
          throw new Error(msg);
        }
        return JSON.parse(t);
      });
    });
  }

  /* ---------------- 发送 & 流式接收 ---------------- */
  /** 用户按发送：把输入框内容变成一条用户消息，然后发请求 */
  function send() {
    if (streaming) { stopStream(); return; }
    var text = E.input.value.trim();
    var files = attachments.filter(function (f) { return f.fileId || f.image; });
    if (!text && !files.length) return;

    // 编辑历史提问：新提问挂到那条提问的父节点下，旧问答整枝保留。
    // 注意 parentId 可能本来就是 null（编辑第一句），所以「是否在编辑」
    // 必须单独用布尔量记，不能用锚点真假来判断。
    var isEditing = !!editingId;
    var editAnchor = null;
    if (isEditing) {
      var se = ensureTree(currentSession());
      var en = nodeById(se, editingId);
      editAnchor = en ? (en.parentId || null) : null;
      editingId = null;
      viewCutId = null;
      E.hint.textContent = '正在生成…';
    }

    if (!settings.apiKey) {
      toast('请先在设置里填入 API Key', true);
      openSheet('settings');
      return;
    }

    E.input.value = '';
    autosize();
    attachments = [];
    renderAttachments();
    updateSend();

    var userMsg = {
      role: 'user',
      content: text,
      files: files.map(function (f) {
        return {
          name: f.name,
          size: f.size,
          fileId: f.fileId,
          purpose: f.purpose,
          image: f.image
        };
      })
    };
    var sTree = ensureTree(currentSession());
    var parent = isEditing ? (editAnchor ? nodeById(sTree, editAnchor) : null) : leafNode();
    var newNode = addNode(sTree, {
      parentId: parent ? parent.id : null,
      role: 'user',
      content: text,
      files: userMsg.files
    });
    if (!newNode) { toast('保存提问失败', true); return; }
    // 当前分支必须立刻移到这条新提问上，否则后面 toApiMessages 拿到的是旧路径，
    // 请求体里会没有用户刚说的这句话（曾经踩过）。
    sTree.leafId = newNode.id;
    userMsg.id = newNode.id;
    userMsg.parentId = newNode.parentId;
    if (sTree && sTree.nodes.length === 1) {
      sTree.title = (text || (files[0] && files[0].name) || '新对话').replace(/\s+/g, ' ').slice(0, 22);
    }
    syncMessages();
    // 重画整条分支：编辑态可能截断过视图，这里要一次性补齐
    renderMessages();
    persistSafe();

    runRequest(false, '');
  }

  /** 发一次请求。prefix 非空时表示「继续写」，把已有内容当助手前缀交给模型。 */
  function runRequest(isRetry, prefix, attempt) {
    attempt = attempt || 0;
    if (streaming) return;
    if (!settings.apiKey) {
      toast('请先在设置里填入 API Key', true);
      openSheet('settings');
      return;
    }

    // 本次回答挂在谁下面：
    //  - 重新生成/继续写：明确指定（那条回答的父节点=对应提问）
    //  - 普通发送：刚写进树里的末尾提问
    var sTree = ensureTree(currentSession());
    var parentNode = regenParentId
      ? nodeById(sTree, regenParentId)
      : (sTree ? sTree.nodes[sTree.nodes.length - 1] : null);
    var answerParentId = parentNode ? parentNode.id : null;
    regenParentId = null;

    var handle = addAssistantMessage('', '', [], settings.model, true);
    var toolLog = [];
    var toolHandles = {};   // step-index → handle
    var content = '';
    var reasoning = '';
    var usage = null;
    var serverCalls = null;
    var annotations = null;
    var finishReason = null;
    var generatedTitle = '';
    var isFirstAnswer = !sTree || !sTree.nodes.some(function (n) { return n.role === 'assistant'; });
    var aborted = false;

    streaming = true;
    updateSend();
    E.hint.textContent = '正在生成…';
    scrollBottom(true);

    // 记下这次请求属于哪个会话：结果回写前要校验，否则切换会话后内容会串
    var ownerSessionId = currentId;

    var ctrl = new AbortController();
    abortCtrl = ctrl;

    function doFetch() {
      // 每次重试都清空累计，避免内容重复
      content = '';
      reasoning = '';
      toolLog.length = 0;
      handle.resetTools();
      toolHandles = {};
      annotations = null;
      serverCalls = null;
      finishReason = null;
      generatedTitle = '';

      return fetch(apiUrl('/chat/completions'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }),
        body: JSON.stringify(buildBody(toApiMessages(prefix, answerParentId), true)),
        signal: ctrl.signal
      });
    }

    doFetch().then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var msg = 'HTTP ' + res.status;
          try { msg = (JSON.parse(t).error || {}).message || msg; } catch (e) {}
          if (res.status === 401) msg = 'API Key 无效，请检查设置';
          if (res.status === 402) msg = '账户余额不足';
          throw new Error(msg);
        });
      }
      if (!res.body) throw new Error('设备不支持流式读取');

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';

      function consume(line) {
        line = line.replace(/\r$/, '').trim();
        if (line.indexOf('data:') !== 0) return;
        var payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        var chunk;
        try { chunk = JSON.parse(payload); } catch (e) { return; }
        handleChunk(chunk);
      }

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            // 流结束时缓冲区可能还剩最后一帧（没有尾随换行），不能丢
            buf += decoder.decode();
            if (buf.trim()) {
              buf.split('\n').forEach(consume);
              buf = '';
            }
            return;
          }
          buf += decoder.decode(r.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            var line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            consume(line);
          }
          scrollBottom();
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      if (err.name === 'AbortError') {
        aborted = true;
        if (content.trim()) handle.notice('已停止生成，保留当前内容');
        return;
      }
      // 网络层错误自动重试一次（HTTP 4xx/5xx 不重试，重试也没用）
      var retryable = err.name === 'TypeError' || /network|failed to fetch|load failed/i.test(err.message || '');
      if (retryable && attempt < 1 && content === '') {
        E.hint.textContent = '连接中断，正在重试…';
        handle.notice('连接中断，正在重试一次…');
        setTimeout(function () {
          streaming = false;
          abortCtrl = null;
          handle.node.remove();
          runRequest(isRetry, prefix, attempt + 1);
        }, 900);
        return 'retried';
      }
      handle.fail(err.message || '请求失败');
    }).then(function (r) {
      if (r === 'retried') return;
      // 先复位 streaming，再刷新按钮 —— 否则 updateSend 仍按"生成中"渲染成停止态
      if (abortCtrl === ctrl) { streaming = false; abortCtrl = null; }
      handle.finish();
      updateSend();
      E.hint.textContent = '内容由 DeepSeek 生成，请注意核实';

      // 输出被截断：明确告诉用户，而不是假装答完了
      if (finishReason === 'length' && !aborted) {
        handle.notice('回答达到长度上限被截断', 'warn');
        handle.setContinue(true);
      }

      if (usage) {
        var bits = ['输入 ' + fmtNum(usage.prompt_tokens), '输出 ' + fmtNum(usage.completion_tokens)];
        if (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) {
          bits.push('思考 ' + fmtNum(usage.completion_tokens_details.reasoning_tokens));
        }
        // 官方按次计费：搜索/抓取各 5 元 / 1000 次
        var stu = usage.server_tool_use;
        if (stu) {
          var n = (stu.tool_search || 0) + (stu.tool_fetch || 0) + (stu.tool_image_search || 0);
          if (n > 0) bits.push('工具 ' + n + ' 次');
        }
        E.usage.textContent = bits.join(' · ');
        if (stu) E.usage.title = '搜索 ' + (stu.tool_search || 0) + ' · 抓取 ' + (stu.tool_fetch || 0) +
          ' · 图片 ' + (stu.tool_image_search || 0);
      }

      // 会话已被切换/删除：内容不能写进别的会话
      if (ownerSessionId !== currentId) {
        if (abortCtrl === ctrl) { streaming = false; abortCtrl = null; }
        updateSend();
        return;
      }
      // 中止时也把已生成的部分留下
      var rec = null;
      if (content.trim()) {
        if (generatedTitle && isFirstAnswer) sTree.title = generatedTitle;
        rec = addNode(sTree, {
          parentId: answerParentId,
          role: 'assistant',
          content: content,
          reasoning: reasoning || undefined,
          tools: toolLog.length ? toolLog : undefined,
          annotations: annotations || undefined,
          serverCalls: serverCalls || undefined,
          truncated: (finishReason === 'length' || aborted) || undefined,
          model: settings.model
        });
        // 当前分支移到新回答上；同一提问下的旧回答自动成为可切换的版本
        if (rec) sTree.leafId = rec.id;
        syncMessages();
        handle.bindRecord(rec);
        if (rec && rec.id) handle.node.dataset.id = rec.id;
      }
      persistSafe();
      renderSessions();
      paintBranches();
      scrollBottom();
    });

    function handleChunk(chunk) {
      if (chunk.usage) usage = chunk.usage;

      var choice = chunk.choices && chunk.choices[0];

      // 流式工具事件：choice 级扩展字段（chunk 级兜底）
      var ev = (choice && choice.server_tool_event) || chunk.server_tool_event;
      if (ev) {
        if (ev.type === 'call_started') {
          var call = ev.call || {};
          var desc = describeCall(call);
          var key = ev.step + ':' + (call.index || 0);
          var h = handle.addTool({ kind: desc.kind, label: desc.label, status: 'running' });
          toolHandles[key] = h;
          toolLog.push({ kind: desc.kind, label: desc.label, status: 'running' });
          E.hint.textContent = desc.label + '…';
        } else if (ev.type === 'call_completed') {
          var call2 = ev.call || {};
          var desc2 = describeCall(call2);
          var key2 = ev.step + ':' + (call2.index || 0);
          var hh = toolHandles[key2];
          if (!hh) {
            // 没有收到 start（例如中途接管），直接补一张
            hh = handle.addTool({ kind: desc2.kind, label: desc2.label, status: 'running' });
            toolHandles[key2] = hh;
            toolLog.push({ kind: desc2.kind, label: desc2.label, status: 'running' });
          }
          var done = fillToolCard(hh, call2);
          for (var i = toolLog.length - 1; i >= 0; i--) {
            if (toolLog[i].status === 'running') { toolLog[i] = done; break; }
          }
          E.hint.textContent = '已获取资料，正在整理…';
        } else if (ev.type === 'step_reasoning_done') {
          E.hint.textContent = '搜索完成，继续思考…';
        }
        scrollBottom();
        return;
      }

      if (!choice) return;
      var delta = choice.delta || {};

      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        handle.setReasoning(reasoning);
      }
      if (delta.content) {
        content += delta.content;
        handle.setContent(content);
      }
      // 完整结果只在带 finish_reason 的最后一个 chunk 里给一次
      if (delta.server_tool_calls) serverCalls = delta.server_tool_calls;
      if (delta.annotations) {
        annotations = delta.annotations;
        handle.setAnnotations(annotations);
      }
      if (typeof delta.title === 'string' && delta.title.trim()) {
        generatedTitle = delta.title.trim();
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (choice.finish_reason === 'content_filter') {
        handle.notice('内容被安全策略拦截，仅供参考');
      }
    }
  }

  function describeCall(call) {
    var action = call.action || {};
    if (action.type === 'search') {
      var q = (action.queries || []).join('、');
      return { kind: 'search', label: q ? '搜索「' + q + '」' : '搜索' };
    }
    if (action.type === 'open_page' || action.type === 'read_link') {
      var u = shortUrl(action.url);
      return { kind: action.type === 'read_link' ? 'read' : 'page', label: (action.type === 'read_link' ? '阅读 ' : '打开 ') + u };
    }
    if (action.type === 'find_in_page') {
      return { kind: 'page', label: '页内查找「' + (action.pattern || '') + '」' };
    }
    if (call.kind === 'image_search' || call.kind === 'deep_image_search') {
      return { kind: 'search', label: '图片搜索' };
    }
    return { kind: 'search', label: '联网' };
  }

  function shortUrl(u) {
    if (!u) return '';
    try {
      var url = new URL(u);
      return url.hostname + (url.pathname.length > 1 ? url.pathname.slice(0, 20) : '');
    } catch (e) { return u; }
  }

  /** 停止当前流。立刻复位 streaming 状态，不等 abort 回调，
      否则切会话后按钮会卡在"停止"态，导致新会话发不出消息。 */
  function stopStream() {
    if (abortCtrl) { try { abortCtrl.abort(); } catch (e) {} }
    abortCtrl = null;
    streaming = false;
    updateSend();
    E.hint.textContent = '内容由 DeepSeek 生成，请注意核实';
  }

  /** 网络失败后重试：不新增用户消息，直接挂到最后一条提问上重发 */
  function resendLast() {
    if (streaming) return;
    var lastUser = null;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUser = messages[i]; break; }
    }
    if (!lastUser) return;
    regenParentId = lastUser.id;
    runRequest(true, '');
  }

  /* ---------------- 设置面板 ---------------- */
  function fillSettings() {
    $('#apiKeyInput').value = settings.apiKey || '';
    $('#apiKeyInput').placeholder = 'sk-…';
    $('#sysPrompt').value = settings.systemPrompt || '';
    $('#swSearch').checked = !!settings.webSearch;
    $('#swThinking').checked = !!settings.thinking;
    $('#swReadUrl').checked = !!settings.readUrl;
    $('#swSafety').checked = !!settings.safety;
    $('#swAutoTitle').checked = settings.autoTitle !== false;
    Array.prototype.forEach.call($('#modelSeg').children, function (b) {
      b.classList.toggle('on', b.dataset.model === settings.model);
    });
    $('#aboutText').innerHTML =
      'DeepSeek 助手 ' + (hasNative ? 'v' + nativeVersion() : 'Web') +
      '<br>纯本地运行 · 密钥仅存于此设备<br>' +
      '联网与文件解析由 DeepSeek 官方服务端完成<br>' +
      '<code>api.deepseek.com</code>';
    updateModelName();
  }

  function nativeVersion() {
    try { return window.AndroidBridge.getVersionName(); } catch (e) { return '1.0.0'; }
  }

  function updateModelName() {
    var m = settings.model;
    var label = m === 'deepseek-v4-pro' ? 'DeepSeek V4 Pro' : 'DeepSeek Flash';
    $('#modelName').textContent = label;
  }

  /** 输入区的深度思考/联网 pill 与设置项是同一个状态，双向同步 */
  function syncPills() {
    E.btnThink.setAttribute('aria-pressed', String(!!settings.thinking));
    E.btnSearch.setAttribute('aria-pressed', String(!!settings.webSearch));
    E.btnThink.title = '深度思考：' + (settings.thinking ? '开启' : '关闭');
    E.btnSearch.title = '联网搜索：' + (settings.webSearch ? '开启' : '关闭');
  }

  /* ---------------- URL 安全 ---------------- */
  /** 只放行 http/https。api 返回的 sources/page/图片地址一律先过这里，
      否则模型可以返回 javascript: 或 data: 注入。 */
  function safeUrl(u) {
    if (!u) return '';
    var s = String(u).trim();
    if (/^https?:\/\//i.test(s)) return s;
    return '';
  }

  function safeImgUrl(u) {
    if (!u) return '';
    var s = String(u).trim();
    if (/^https?:\/\//i.test(s)) return s;
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) return s;
    return '';
  }

  /* ---------------- 打开链接 ---------------- */
  function openLink(url) {
    if (!url) return;
    if (hasNative && /^https?:/i.test(url)) {
      try { window.AndroidBridge.openUrl(url); return; } catch (e) {}
    }
    window.open(url, '_blank');
  }

  /* ---------------- 复制 ---------------- */
  function copyText(text) {
    if (hasNative) {
      try { window.AndroidBridge.copyText(text); return; } catch (e) {}
    }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制');
    }
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    E.input.addEventListener('input', function () { autosize(); updateSend(); });
    E.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.ctrlKey) {
        e.preventDefault();
        if (!streaming) send();
      }
      // Esc 退出编辑态（外接键盘）
      if (e.key === 'Escape' && editingId) {
        e.preventDefault();
        cancelEdit();
      }
    });
    E.btnSend.addEventListener('click', function () {
      if (streaming) stopStream();
      else send();
    });

    // 键盘弹起期间锁死页面滚动：打字和拉动只能二选一，
    // 否则下拉会把整个 .app 拖偏，输入框脱离键盘上沿。
    // 判定用「键盘实际可见 + 焦点在输入框」——WebView 里按返回键
    // 收键盘输入框仍持有 DOM focus，单靠 focus 状态不可靠。
    function updateTypingLock() {
      var vv = window.visualViewport;
      var kbOpen = vv ? (window.innerHeight - vv.height) > 100 : false;
      var a = document.activeElement;
      var field = a && a.matches && a.matches('input, textarea');
      document.body.classList.toggle('typing', !!(kbOpen && field));
    }
    document.addEventListener('focusin', updateTypingLock);
    document.addEventListener('focusout', function () { setTimeout(updateTypingLock, 0); });
    window.addEventListener('safearea', updateTypingLock);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateTypingLock);
      window.visualViewport.addEventListener('scroll', updateTypingLock);
    }

    $('#btnMenu').addEventListener('click', function () { openSheet('sessions'); });

    // 中部右滑拉出会话抽屉。起势点让开左缘 40px——那段是系统返回手势区，
    // 不抢；落在可横向滚动元素上（代码块已滚过的）也不抢
    var edgeSwipe = null;
    document.addEventListener('touchstart', function (e) {
      edgeSwipe = null;
      if (e.touches.length !== 1) return;
      if (!E.sheet.hidden || !E.settings.hidden) return;
      var t = e.touches[0];
      if (t.clientX <= 40 || t.clientX > window.innerWidth * 0.7) return;
      for (var p = e.target; p && p !== document.body; p = p.parentElement) {
        if (p.scrollWidth > p.clientWidth + 8 && p.scrollLeft > 4) return;
      }
      edgeSwipe = { x: t.clientX, y: t.clientY, id: t.identifier };
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!edgeSwipe) return;
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier !== edgeSwipe.id) continue;
        var dx = t.clientX - edgeSwipe.x;
        var dy = t.clientY - edgeSwipe.y;
        if (dx > 72 && dx > Math.abs(dy) * 1.5) {
          openSheet('sessions');
          edgeSwipe = null;
        }
      }
    }, { passive: true });
    document.addEventListener('touchend', function () { edgeSwipe = null; }, { passive: true });
    document.addEventListener('touchcancel', function () { edgeSwipe = null; }, { passive: true });
    $('#btnCloseSheet').addEventListener('click', closeAll);
    E.sheetMask.addEventListener('click', closeAll);

    $('#btnSettings').addEventListener('click', function () { openSheet('settings'); });
    $('#btnCloseSettings').addEventListener('click', closeAll);
    E.settingsMask.addEventListener('click', closeAll);

    $('#btnNew').addEventListener('click', function () {
      if (streaming) stopStream();
      newSession();
      renderWelcome();
      renderSessions();
      closeAll();
      toast('已新建对话');
    });

    $('#btnTheme').addEventListener('click', function () {
      var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      var meta = document.querySelector('meta[name=theme-color]');
      if (meta) meta.setAttribute('content', next === 'dark' ? '#17150f' : '#f7f5f0');
    });

    $('#btnAttach').addEventListener('click', pickFile);
    E.actionMask.addEventListener('click', closeAll);
    $('#actionCancel').addEventListener('click', closeAll);

    // 深度思考 / 联网搜索 pill：改的是设置里的同一个开关
    E.btnThink.addEventListener('click', function () {
      settings.thinking = !settings.thinking;
      saveSettings();
      syncPills();
    });
    E.btnSearch.addEventListener('click', function () {
      settings.webSearch = !settings.webSearch;
      saveSettings();
      syncPills();
      toast(settings.webSearch ? '联网搜索已开启' : '联网搜索已关闭');
    });

    // 来源抽屉
    E.sourcesMask.addEventListener('click', closeAll);
    $('#btnCloseSources').addEventListener('click', closeAll);

    // 编辑态的「取消」
    E.btnEditCancel.addEventListener('click', cancelEdit);

    $('#btnModel').addEventListener('click', function () {
      showActions('选择模型', [
        { label: 'DeepSeek Flash · 快速，支持联网与文件', run: function () { settings.model = 'deepseek-flash'; saveSettings(); updateModelName(); toast('已切换到 Flash'); } },
        { label: 'DeepSeek V4 Pro · 复杂推理', run: function () { settings.model = 'deepseek-v4-pro'; saveSettings(); updateModelName(); toast('已切换到 V4 Pro'); } }
      ]);
    });

    // 设置项
    Array.prototype.forEach.call($('#modelSeg').children, function (b) {
      b.addEventListener('click', function () {
        settings.model = b.dataset.model;
        Array.prototype.forEach.call($('#modelSeg').children, function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      });
    });

    $('#btnToggleKey').addEventListener('click', function () {
      var inp = $('#apiKeyInput');
      var isPw = inp.type === 'password';
      inp.type = isPw ? 'text' : 'password';
      $('#btnToggleKey').textContent = isPw ? '隐藏' : '显示';
    });

    $('#btnSave').addEventListener('click', function () {
      settings.apiKey = $('#apiKeyInput').value.trim();
      settings.systemPrompt = $('#sysPrompt').value;
      settings.webSearch = $('#swSearch').checked;
      settings.thinking = $('#swThinking').checked;
      settings.readUrl = $('#swReadUrl').checked;
      settings.safety = $('#swSafety').checked;
      settings.autoTitle = $('#swAutoTitle').checked;
      saveSettings();
      updateModelName();
      syncPills();
      closeAll();
      toast('设置已保存');
      if (!messages.length) renderWelcome();
    });

    $('#btnTest').addEventListener('click', function () {
      var key = $('#apiKeyInput').value.trim();
      var btn = $('#btnTest');
      btn.textContent = '测试中…';
      fetch(apiUrl('/models'), { headers: { 'Authorization': 'Bearer ' + (key || settings.apiKey) } })
        .then(function (r) {
          if (r.status === 401) throw new Error('Key 无效');
          if (!r.ok) throw new Error('HTTP ' + r.status);
          toast('连接正常 ✓');
        })
        .catch(function (e) { toast(e.message, true); })
        .then(function () { setTimeout(function () { btn.textContent = '测试连接'; }, 1500); });
    });

    // 链接统一走 openLink（WebView 里 window.open / target=_blank 不生效）
    E.messages.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[href]') : null;
      if (a && /^https?:/i.test(a.getAttribute('href') || '')) {
        e.preventDefault();
        openLink(a.getAttribute('href'));
        return;
      }
    });

    // 编辑历史提问：点「编辑」按钮，或长按气泡（移动端手感）
    E.messages.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.act-edit') : null;
      if (!btn) return;
      var msg = btn.closest('.msg');
      if (msg && msg.dataset.id) startEdit(msg.dataset.id);
    });
    var pressTimer = null;
    E.messages.addEventListener('touchstart', function (e) {
      var bubble = e.target.closest ? e.target.closest('.msg.user .bubble') : null;
      if (!bubble) return;
      var msg = bubble.closest('.msg');
      pressTimer = setTimeout(function () {
        pressTimer = null;
        if (msg && msg.dataset.id) startEdit(msg.dataset.id);
      }, 550);
    }, { passive: true });
    function cancelPress() { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }
    E.messages.addEventListener('touchend', cancelPress);
    E.messages.addEventListener('touchmove', cancelPress, { passive: true });
    E.messages.addEventListener('touchcancel', cancelPress);

    // Markdown 里的复制按钮
    E.messages.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.copy-code') : null;
      if (!btn) return;
      var code = btn.closest('pre').querySelector('code');
      copyText(code ? code.textContent : '');
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = '复制'; }, 1300);
    });

    // 回到底部
    E.scroll.addEventListener('scroll', updateToBottom, { passive: true });
    E.toBottom.addEventListener('click', function () { scrollBottom(true); });

    // 会话搜索
    E.sessionSearch.addEventListener('input', renderSessions);

    /* 下滑关闭：底部动作面板和设置页支持向下拖拽收起 */
    bindSwipeDown(E.actionSheet, closeAll);
    bindSwipeDown(E.settings, closeAll);

    // 粘贴：截图或复制的图片直接变成附件
    E.input.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      var found = false;
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
          var f = items[i].getAsFile();
          if (!f) continue;
          found = true;
          var reader = new FileReader();
          reader.onload = function () {
            var dataUrl = reader.result;
            shrinkImage(dataUrl, f.type).then(function (small) {
              addImageAttachment(f.name || '粘贴的图片.png', f.type, Math.round(small.length * 0.75), small);
            });
          };
          reader.readAsDataURL(f);
        }
      }
      if (found) e.preventDefault();
    });

    // 键盘遮挡：只有原本就在底部时才贴底，否则保持用户当前的阅读位置
    window.addEventListener('safearea', function () {
      var nearBottom = E.scroll.scrollHeight - E.scroll.scrollTop - E.scroll.clientHeight < 120;
      if (nearBottom) setTimeout(function () { scrollBottom(true); }, 60);
      else setTimeout(updateToBottom, 60);
    });

    // 返回键：层级关闭
    window.__handleBack = function () {
      if (!E.actionSheet.hidden) { closeAll(); return true; }
      if (!E.settings.hidden) { closeAll(); return true; }
      if (E.sourcesSheet.classList.contains('open')) { closeAll(); return true; }
      if (!E.sheet.hidden) { closeAll(); return true; }
      // 编辑态优先退出编辑，而不是直接关 App
      if (editingId) { cancelEdit(); return true; }
      return false;
    };

    // Java 侧 onPause 会调它：退到后台时立刻把内存里的会话写盘，
    // 进程随后被系统回收也不会丢最近的对话。
    window.__flushStorage = function () {
      try { persistSafe(); } catch (e) {}
    };
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    updateModelName();
    syncPills();
    bind();
    autosize();
    updateSend();

    // 老版本存的是 messages 直线：启动时统一升级成 nodes 树并写回
    var migrated = false;
    for (var i = 0; i < sessions.length; i++) {
      if (Object.prototype.toString.call(sessions[i].nodes) !== '[object Array]') migrated = true;
      ensureTree(sessions[i]);
    }
    if (migrated) { try { LS.set('sessions', sessions); } catch (e) {} }

    // 老版本点 + 攒下的空会话（没发过消息的）清掉，只留当前草稿
    var kept = sessions.filter(function (s) {
      return s.id === currentId || (s.nodes && s.nodes.length);
    });
    if (kept.length !== sessions.length) {
      sessions = kept;
      try { LS.set('sessions', sessions); } catch (e) {}
    }

    if (!currentId && !sessions.length) newSession();
    if (!currentId && sessions.length) currentId = sessions[0].id;
    syncMessages();
    if (messages.length) renderMessages();
    else renderWelcome();

    // 首次引导已在欢迎页呈现，不再用 toast 打扰
  }

  init();
})();

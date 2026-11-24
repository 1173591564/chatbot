/* =========================================================
   DeepSeek 聊天助手 — 前端逻辑
   零依赖：Markdown 渲染、SSE 解析、会话管理都手写
   ========================================================= */

/* ============ 1. Markdown 渲染 ============ */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ESCAPE_MAP[c]);

/* --- 代码高亮（轻量 tokenizer，支持 js/ts/py/json/html/css/bash 等常见语言） --- */
const KEYWORDS = new Set(
  `const let var function return if else for while do break continue class extends new this super
   import from export default async await try catch finally throw typeof instanceof in of delete void
   yield static get set switch case default null undefined true false NaN Infinity
   def elif except lambda pass raise with as assert del global nonlocal and or not is None True False
   self print range len int str float list dict set tuple bool
   public private protected interface implements enum package namespace struct func go defer chan select map
   fn mut impl trait pub use mod match Some None Ok Err Some where loop unsafe ref
   echo cd ls cat grep sed awk curl wget sudo apt npm yarn node python pip git docker exit export source`
    .split(/\s+/)
    .filter(Boolean)
);

const HIGHLIGHT_RE =
  /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|--[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\$]|\\.)*`)|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/g;

function highlight(code, lang = '') {
  const l = String(lang || '').toLowerCase();
  const isMarkup = /html|xml|svg/.test(l);
  const isCss = /css|scss|less/.test(l);
  const out = [];
  let last = 0;

  if (isMarkup) {
    // 标记语言：标签名 + 属性名简单着色
    return escapeHtml(code)
      .replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="tok-f">$2</span>')
      .replace(/([\w-]+)=(&quot;|&#39;|")/g, '<span class="tok-n">$1</span>=$2');
  }
  if (isCss) {
    return escapeHtml(code)
      .replace(/\/\*[\s\S]*?\*\//g, (m) => `<span class="tok-c">${m}</span>`)
      .replace(/([{;]\s*)([\w-]+)(\s*:)/g, '$1<span class="tok-f">$2</span>$3')
      .replace(/(#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|fr|deg)?\b)/g, '<span class="tok-n">$1</span>');
  }

  HIGHLIGHT_RE.lastIndex = 0;
  let m;
  while ((m = HIGHLIGHT_RE.exec(code))) {
    if (m.index > last) out.push(escapeHtml(code.slice(last, m.index)));
    const [full, comment, str, num, word] = m;
    if (comment) out.push(`<span class="tok-c">${escapeHtml(comment)}</span>`);
    else if (str) out.push(`<span class="tok-s">${escapeHtml(str)}</span>`);
    else if (num) out.push(`<span class="tok-n">${escapeHtml(num)}</span>`);
    else if (word) {
      const cls = KEYWORDS.has(word) ? 'tok-k' : /^[A-Z]/.test(word) ? 'tok-f' : '';
      out.push(cls ? `<span class="${cls}">${escapeHtml(word)}</span>` : escapeHtml(word));
    }
    last = m.index + full.length;
  }
  if (last < code.length) out.push(escapeHtml(code.slice(last)));
  return out.join('');
}

/* --- 行内元素 --- */
function renderInline(text) {
  const codes = [];
  // 先把行内代码挖出来，避免里面的 * 被当成强调
  let s = String(text).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  s = escapeHtml(s);

  // 图片 ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, url) => {
    const safe = sanitizeUrl(url);
    return safe ? `<img src="${safe}" alt="${alt}" loading="lazy" style="max-width:100%;border-radius:8px">` : alt;
  });
  // 链接 [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, label, url) => {
    const safe = sanitizeUrl(url);
    return safe
      ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : label;
  });
  // 裸链接
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)）]+)/g, (_, pre, url) => {
    const trimmed = url.replace(/[.,;:!?]+$/, '');
    const tail = url.slice(trimmed.length);
    return `${pre}<a href="${sanitizeUrl(trimmed)}" target="_blank" rel="noopener noreferrer">${trimmed}</a>${tail}`;
  });

  s = s
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__([^_]+)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>');

  // 还原行内代码
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)] || '');
  return s;
}

/** 只放行 http(s)，用于 <a>/<img>/window.open；返回未转义的 URL 或 '' */
function safeUrl(url = '') {
  const u = String(url).trim();
  return /^https?:\/\//i.test(u) ? u : '';
}

function sanitizeUrl(url = '') {
  const u = String(url).trim().replace(/&amp;/g, '&');
  if (/^(https?:|mailto:|data:image\/)/i.test(u)) return escapeHtml(u).replace(/"/g, '%22');
  if (/^[./#]/.test(u)) return escapeHtml(u);
  return '';
}

/* --- 块级解析 --- */
export function renderMarkdown(src = '') {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;

  const isFence = (l) => /^\s*(```|~~~)(.*)$/.exec(l);
  const isBlank = (l) => !l.trim();

  while (i < lines.length) {
    const line = lines[i];

    /* 代码块 */
    const fence = isFence(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2].trim().split(/\s+/)[0] || '';
      const buf = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏（流式未闭合时 i 已越界，安全）
      const code = buf.join('\n');
      html.push(
        `<pre><div class="code-head"><span>${escapeHtml(lang || 'text')}</span>` +
          `<button class="copy-code" type="button">复制</button></div>` +
          `<code class="lang-${escapeHtml(lang || 'text')}">${highlight(code, lang)}</code></pre>`
      );
      continue;
    }

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    /* 分割线 */
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html.push('<hr>');
      i += 1;
      continue;
    }

    /* 标题 */
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      html.push(`<h${level}>${renderInline(h[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    /* 引用 */
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    /* 表格 */
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]*-[\s|:-]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const parseRow = (l) =>
        l
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const head = parseRow(line);
      const align = parseRow(lines[i + 1]).map((c) =>
        /^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : ''
      );
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && !isBlank(lines[i])) {
        rows.push(parseRow(lines[i]));
        i += 1;
      }
      const th = head.map((c, k) => `<th${align[k] ? ` style="text-align:${align[k]}"` : ''}>${renderInline(c)}</th>`).join('');
      const tb = rows
        .map(
          (r) =>
            `<tr>${r
              .map((c, k) => `<td${align[k] ? ` style="text-align:${align[k]}"` : ''}>${renderInline(c)}</td>`)
              .join('')}</tr>`
        )
        .join('');
      html.push(`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }

    /* 列表 */
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        const indent = m[1].replace(/\t/g, '    ').length;
        items.push({ indent, ordered: /\d/.test(m[2]), text: m[3] });
        i += 1;
        // 列表项的续行（缩进更深且不是新列表项）
        while (i < lines.length && !isBlank(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && /^\s{2,}/.test(lines[i])) {
          items[items.length - 1].text += ' ' + lines[i].trim();
          i += 1;
        }
      }
      html.push(buildList(items));
      continue;
    }

    /* 段落 */
    const buf = [];
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !isFence(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    if (buf.length) html.push(`<p>${renderInline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
    else i += 1;
  }

  return html.join('');
}

function buildList(items) {
  // 按缩进构建嵌套列表
  let out = '';
  const stack = [];
  for (const it of items) {
    const tag = it.ordered ? 'ol' : 'ul';
    if (!stack.length) {
      stack.push({ indent: it.indent, tag });
      out += `<${tag}>`;
    } else if (it.indent > stack[stack.length - 1].indent + 1) {
      stack.push({ indent: it.indent, tag });
      out += `<${tag}>`;
    } else {
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) {
        out += `</li></${stack.pop().tag}>`;
      }
      if (stack[stack.length - 1].tag !== tag) {
        out += `</li></${stack.pop().tag}><${tag}>`;
        stack.push({ indent: it.indent, tag });
      } else {
        out += '</li>';
      }
    }
    out += `<li>${renderInline(it.text)}`;
  }
  while (stack.length) out += `</li></${stack.pop().tag}>`;
  return out;
}

/* ============ 2. 工具函数 ============ */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const uid = () => Math.random().toString(36).slice(2, 10);
const fmtTime = (ts) => {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : `${d.getMonth() + 1}/${d.getDate()}`;
};
const fmtNum = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/* ============ 3. 状态 ============ */

const state = {
  config: null,
  sessions: [],
  sessionId: null,
  messages: [],
  model: 'deepseek-flash',
  streaming: false,
  streamToken: 0,      // 每发起/放弃一条流就 +1，用来判定「这条流是否还属于当前视图」
  abortCtrl: null,
  useSearch: true,
  thinking: false,
  branches: {},        // nodeId → { index, count, ids }
  editing: null,       // { nodeId, parentId } 正在编辑的旧提问
  attachments: [],     // 待发送的附件（已上传到官方 Files API）
};

const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`ds.${k}`);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`ds.${k}`, JSON.stringify(v));
    } catch {
      /* 忽略 */
    }
  },
};

/* ============ 4. 初始化 ============ */

const els = {
  app: $('#app'),
  sidebar: $('#sidebar'),
  scrim: $('#scrim'),
  sessionList: $('#sessionList'),
  messages: $('#messages'),
  scroll: $('#scroll'),
  input: $('#input'),
  btnSend: $('#btnSend'),
  modelSelect: $('#modelSelect'),
  btnSearch: $('#btnSearch'),
  chatTitle: $('#chatTitle'),
  composer: $('#composer'),
  usageText: $('#usageText'),
  hintText: $('#hintText'),
  settingsModal: $('#settingsModal'),
  apiKeyInput: $('#apiKeyInput'),
  baseUrlInput: $('#baseUrlInput'),
  sysPromptInput: $('#sysPromptInput'),
  searchCheck: $('#searchCheck'),
  searchStatus: $('#searchStatus'),
  readUrlCheck: $('#readUrlCheck'),
  thinkingCheck: $('#thinkingCheck'),
  safetyCheck: $('#safetyCheck'),
  titleCheck: $('#titleCheck'),
  attachStrip: $('#attachStrip'),
  filePicker: $('#filePicker'),
  btnAttach: $('#btnAttach'),
  keyDot: $('#keyDot'),
  toast: $('#toast'),
  btnEditCancel: $('#btnEditCancel'),
  btnThink: $('#btnThink'),
  btnJumpLatest: $('#btnJumpLatest'),
  sourcesScrim: $('#sourcesScrim'),
  sourcesDrawer: $('#sourcesDrawer'),
  sourcesCount: $('#sourcesCount'),
  sourcesBody: $('#sourcesBody'),
  btnCloseSources: $('#btnCloseSources'),
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, isErr = false) {
  els.toast.textContent = msg;
  els.toast.className = `toast show${isErr ? ' err' : ''}`;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => (els.toast.hidden = true), 260);
  }, 2600);
}

/* ---------- 主题 ---------- */
function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  LS.set('theme', t);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#17150f' : '#f7f5f0');
}

async function init() {
  // 一次性迁移：旧版本收起后没有任何入口能展开，这里强制恢复为展开并清掉旧状态，
  // 用户之后可以正常用汉堡按钮收起。
  if (LS.get('collapsedMigrated', false) !== true) {
    LS.set('collapsed', false);
    LS.set('collapsedMigrated', true);
  }
  els.app.classList.toggle('collapsed', LS.get('collapsed', false));
  state.model = LS.get('model', 'deepseek-flash');
  // 老版本存下来的已停用模型名，直接兜底到新模型
  if (!['deepseek-flash', 'deepseek-v4-pro'].includes(state.model)) state.model = 'deepseek-flash';
  els.modelSelect.value = state.model;

  await loadConfig();
  await loadSessions();

  const last = LS.get('sessionId', null);
  if (last && state.sessions.some((s) => s.id === last)) {
    await openSession(last);
  } else {
    renderWelcome();
  }

  bindEvents();
  autosize();
  els.input.focus();
}

async function loadConfig() {
  try {
    state.config = await api('/api/config');
    state.useSearch = state.config.webSearch;
    state.thinking = state.config.thinking;
    syncSearchBtn();
    syncThinkBtn();
    els.keyDot.classList.toggle('ok', state.config.hasKey);
    els.keyDot.title = state.config.hasKey ? `已配置 ${state.config.keyHint}` : 'API Key 未配置';
    fillSettingsForm();
  } catch (err) {
    toast(`读取配置失败：${err.message}`, true);
  }
}

async function loadSessions() {
  try {
    const { sessions } = await api('/api/sessions');
    state.sessions = sessions;
    renderSessionList();
  } catch (err) {
    console.warn(err);
  }
}

/* ============ 5. 会话列表 ============ */

function renderSessionList() {
  els.sessionList.innerHTML = '';
  if (!state.sessions.length) {
    els.sessionList.append(el('div', 'session-empty', '还没有对话记录\n点上面「开启新对话」开始'));
    return;
  }
  const groups = { 今天: [], 更早: [] };
  const today = new Date().toDateString();
  for (const s of state.sessions) {
    (new Date(s.updatedAt).toDateString() === today ? groups['今天'] : groups['更早']).push(s);
  }
  for (const [label, list] of Object.entries(groups)) {
    if (!list.length) continue;
    els.sessionList.append(el('div', 'session-group-label', label));
    for (const s of list) {
      const item = el('div', `session-item${s.id === state.sessionId ? ' active' : ''}`);
      item.dataset.id = s.id;
      item.append(el('span', 's-title', s.title || '新对话'));
      if (s.model === 'deepseek-v4-pro') item.append(el('span', 's-badge', 'Pro'));
      const del = el('button', 's-del');
      del.title = '删除对话';
      del.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>`;
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`删除「${s.title}」？`)) return;
        await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
        state.sessions = state.sessions.filter((x) => x.id !== s.id);
        if (state.sessionId === s.id) {
          state.streamToken += 1;
          state.sessionId = null;
          state.messages = [];
          LS.set('sessionId', null);
          renderWelcome();
        }
        renderSessionList();
        toast('已删除');
      });
      item.append(del);
      item.addEventListener('click', () => {
        openSession(s.id);
        els.app.classList.remove('mobile-open');
      });
      els.sessionList.append(item);
    }
  }
}

async function openSession(id) {
  if (state.streaming) stopStreaming();
  state.streamToken += 1;   // 让旧会话里在途的流作废
  try {
    const { session } = await api(`/api/sessions/${id}`);
    state.sessionId = session.id;
    state.messages = session.messages || [];
    state.branches = session.branches || {};
    state.model = session.model || state.model;
    els.modelSelect.value = state.model;
    LS.set('sessionId', id);
    LS.set('model', state.model);
    els.chatTitle.textContent = session.title || '';
    renderMessages();
    renderSessionList();
    scrollToBottom(true);
  } catch (err) {
    toast(`打开会话失败：${err.message}`, true);
  }
}

/* ============ 6. 消息渲染 ============ */

function renderWelcome() {
  state.sessionId = null;
  LS.set('sessionId', null);
  els.chatTitle.textContent = '';
  els.usageText.textContent = '';
  els.messages.innerHTML = '';

  const wrap = el('div', 'welcome');
  wrap.innerHTML = `
    <div class="welcome-mark">
      <svg viewBox="0 0 28 28" width="40" height="40" fill="none">
        <path d="M4.5 17.5c0-5.2 4.2-9.4 9.4-9.4 3.9 0 7.3 2.4 8.7 5.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M4.5 17.5c2.6 0 3.7 1.7 5 3.1 1.4 1.4 3 2.6 5.7 2.6 3.1 0 5.1-1.6 6.3-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        <circle cx="19.6" cy="11.4" r="1.05" fill="currentColor"/>
      </svg>
    </div>
    <h1>今天想聊点什么？</h1>
    <p class="welcome-sub">问问题、查资料、读文档，或让它帮你写代码。${state.config?.webSearch ? '需要最新消息时会自动联网。' : ''}</p>
    <div class="suggests"></div>`;

  const suggests = [
    ['news', '查一下最新消息', '今天科技圈有什么值得关注的新闻？帮我汇总一下', '汇总今日要闻并附来源'],
    ['book', '解释一个概念', '用打比方的方式解释什么是「向量数据库」', '用打比方的方式讲清抽象概念'],
    ['code', '写点代码', '用 Node.js 写一个带重试和超时的 fetch 封装', '写出可以直接用的实现'],
    ['link', '读一篇网页', '帮我总结 https://nodejs.org/en/blog 最近一篇文章的要点', '丢个链接，提炼重点'],
  ];
  const icons = {
    news: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5S9.5 5.8 12 3.5Z"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z"/><path d="M4 5.5v15M8 7h8M8 11h6"/>',
    code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M13 4l-2 16"/>',
    link: '<path d="M10 13.5a3.6 3.6 0 0 0 5.1 0l2.2-2.2a3.6 3.6 0 0 0-5.1-5.1L11 7.4"/><path d="M14 10.5a3.6 3.6 0 0 0-5.1 0L6.7 12.7a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"/>',
  };
  const box = wrap.querySelector('.suggests');
  for (const [icon, title, text, desc] of suggests) {
    const b = el('button', 'suggest');
    b.innerHTML = `<span class="s-ico"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icons[icon]}</svg></span><span class="s-main"><b>${escapeHtml(title)}</b><span>${escapeHtml(desc)}</span></span><span class="s-go" aria-hidden="true">↗</span>`;
    b.addEventListener('click', () => {
      els.input.value = text;
      autosize();
      updateSendState();
      send();
    });
    box.append(b);
  }

  els.messages.append(wrap);
}

function renderMessages() {
  els.messages.innerHTML = '';
  if (!state.messages.length) {
    renderWelcome();
    return;
  }
  for (const m of state.messages) {
    if (m.role === 'user') addUserMessage(m.content, m.id, m.files);
    else if (m.role === 'assistant')
      addAssistantMessage(m.content, m.reasoning, m.tools, m.model, m.id, m.annotations || null);
  }
  paintBranches();
}

/** 给每条消息挂上「同一位置有几个版本」的切换器 */
/** node id 只含 [\w-]，但仍做一次转义：CSS.escape 在旧 WebView 上不存在 */
function cssEscape(v) {
  return String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function paintBranches() {
  els.messages.querySelectorAll('.branch-switch').forEach((n) => n.remove());
  for (const m of state.messages) {
    const info = state.branches?.[m.id];
    if (!info || info.count < 2) continue;
    const msg = els.messages.querySelector(`.msg[data-id="${cssEscape(m.id)}"]`);
    if (!msg) continue;
    const sw = el('div', 'branch-switch');
    sw.innerHTML = `
      <button class="b-prev" type="button" aria-label="上一个版本">‹</button>
      <span class="b-count"></span>
      <button class="b-next" type="button" aria-label="下一个版本">›</button>`;
    sw.querySelector('.b-count').textContent = `${info.index} / ${info.count}`;
    sw.querySelector('.b-prev').disabled = info.index <= 1;
    sw.querySelector('.b-next').disabled = info.index >= info.count;
    sw.addEventListener('click', (e) => {
      const dir = e.target.closest('.b-prev') ? 'prev' : e.target.closest('.b-next') ? 'next' : null;
      if (dir) switchBranch(m.id, dir);
    });
    msg.querySelector('.msg-role')?.append(sw);
  }
}

/**
 * 同一个提问位置存了多个版本，左右翻页。
 * 只挪「当前看的分支末端」，不动消息内容本身，所以旧回答一直都在。
 */
async function switchBranch(nodeId, dir) {
  if (state.streaming) {
    toast('正在生成，先停止再切换版本');
    return;
  }
  if (!state.sessionId) return;
  try {
    await api(`/api/sessions/${state.sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ leafId: dir, leafIdFrom: nodeId }),
    });
    await openSession(state.sessionId);
  } catch (err) {
    toast(`切换版本失败：${err.message}`, true);
  }
}

function addUserMessage(text, nodeId, files) {
  els.messages.querySelector('.welcome')?.remove();
  const msg = el('div', 'msg user');
  if (nodeId) msg.dataset.id = nodeId;
  msg.innerHTML = `
    <div class="msg-body">
      <div class="bubble"></div>
      <div class="msg-files"></div>
      <div class="msg-actions user-actions">
        <button class="act-edit" type="button" title="编辑这条提问（发送后保留旧版本）" aria-label="编辑提问">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17Z"/><path d="m14.5 7 3 3"/></svg>
        </button>
      </div>
    </div>`;
  msg.querySelector('.bubble').textContent = text;
  if (files && files.length) {
    const box = msg.querySelector('.msg-files');
    for (const f of files) {
      const chip = el('div', 'chip');
      chip.append(el('span', 'c-name', f.name || '文件'));
      if (f.fileId) chip.append(el('span', 'c-size', f.image ? '图片' : '已解析'));
      else if (f.imageDropped) chip.append(el('span', 'c-size', '已省略'));
      box.append(chip);
    }
  } else {
    msg.querySelector('.msg-files')?.remove();
  }
  els.messages.append(msg);
  return msg;
}

/** 把某个位置上的提问收进输入框里改，用户改完按发送 */
function startEdit(nodeId) {
  const m = state.messages.find((x) => x.id === nodeId);
  if (!m) return;
  state.editing = { nodeId, parentId: m.parentId || null };
  els.input.value = m.content;
  autosize();
  updateSendState();
  els.input.focus();
  els.input.setSelectionRange(m.content.length, m.content.length);
  els.hintText.textContent = '修改这条提问，发送后会作为新的版本，旧回答仍保留（‹ 1/2 › 可切回）';
  els.btnEditCancel.hidden = false;
  els.composer.classList.add('editing');
}

function cancelEdit() {
  state.editing = null;
  els.input.value = '';
  autosize();
  updateSendState();
  els.btnEditCancel.hidden = true;
  els.composer.classList.remove('editing');
  els.hintText.textContent = '内容由 AI 生成，请注意核实';
  els.input.focus();
}

/**
 * 创建助手消息容器，返回操作句柄
 */
function addAssistantMessage(text = '', reasoning = '', tools = [], model = '', nodeId = '', annotationList = null) {
  els.messages.querySelector('.welcome')?.remove();
  const msg = el('div', 'msg assistant');
  if (nodeId) msg.dataset.id = nodeId;
  msg.innerHTML = `
    <div class="msg-avatar" aria-hidden="true"><svg viewBox="0 0 28 28" width="19" height="19" fill="none">
      <path d="M4.5 17.5c0-5.2 4.2-9.4 9.4-9.4 3.9 0 7.3 2.4 8.7 5.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M4.5 17.5c2.6 0 3.7 1.7 5 3.1 1.4 1.4 3 2.6 5.7 2.6 3.1 0 5.1-1.6 6.3-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="19.6" cy="11.4" r="1.3" fill="currentColor"/>
    </svg></div>
    <div class="msg-body">
      <div class="msg-role"><span>DeepSeek</span>${model === 'deepseek-v4-pro' ? '<span class="model-tag">V4 Pro</span>' : '<span class="model-tag">Flash</span>'}</div>
      <div class="process-box open" hidden>
        <button class="process-head" type="button">
          <span class="spinner"></span>
          <span class="p-title">思考中…</span>
          <span class="p-meta"></span>
          <svg class="caret" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>
          <span class="p-more">收起</span>
        </button>
        <div class="process-body">
          <div class="reasoning" hidden>
            <button class="reasoning-head" type="button">
              <span class="r-title">思考过程</span>
              <svg class="caret" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>
              <span class="r-more">收起</span>
            </button>
            <div class="reasoning-body"></div>
          </div>
          <div class="tool-stack"></div>
        </div>
      </div>
      <div class="prose"><p class="caret-blink"></p></div>
      <div class="sources-slot"></div>
      <div class="msg-actions">
        <button class="act-copy" type="button" title="复制回答" aria-label="复制回答">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>
          <span class="act-label">复制</span>
        </button>
        <button class="act-regen" type="button" title="重新生成（保留旧版本）" aria-label="重新生成">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-1.5 6.5"/><path d="M20 5v6h-6"/></svg>
          <span class="act-label">重新生成</span>
        </button>
      </div>
    </div>`;
  els.messages.append(msg);

  const prose = msg.querySelector('.prose');
  const processBox = msg.querySelector('.process-box');
  const processHead = processBox.querySelector('.process-head');
  const processTitle = processBox.querySelector('.p-title');
  const processMeta = processBox.querySelector('.p-meta');
  const processMore = processBox.querySelector('.p-more');
  const toolStack = processBox.querySelector('.tool-stack');
  const reasoningEl = processBox.querySelector('.reasoning');
  const reasoningHead = reasoningEl.querySelector('.reasoning-head');
  const reasoningBody = reasoningEl.querySelector('.reasoning-body');
  const reasoningMore = reasoningEl.querySelector('.r-more');
  const sourcesSlot = msg.querySelector('.sources-slot');
  const actions = msg.querySelector('.msg-actions');

  let raw = text;
  let think = reasoning;
  let anns = null;
  let renderTimer = null;
  let dirty = false;
  let toolCount = 0;

  processHead.addEventListener('click', () => {
    processBox.classList.toggle('open');
    processMore.textContent = processBox.classList.contains('open') ? '收起' : '展开';
  });
  reasoningHead.addEventListener('click', () => {
    reasoningEl.classList.toggle('open');
    reasoningMore.textContent = reasoningEl.classList.contains('open') ? '收起' : '展开';
  });

  const api = {
    node: msg,
    setContent(t) {
      raw = t;
      schedule();
    },
    setReasoning(t) {
      think = t;
      ensureReasoning();
      reasoningBody.textContent = think;
      reasoningBody.scrollTop = reasoningBody.scrollHeight;
    },
    addTool(tool) {
      toolCount += 1;
      processBox.hidden = false;
      updateProcessHeader(false);
      return addToolCard(toolStack, tool);
    },
    finish() {
      flush();
      prose.querySelector('.caret-blink')?.remove();
      finalizeProcess();
    },
    fail(msg2) {
      prose.querySelector('.caret-blink')?.remove();
      const box = el('div', 'err-box', msg2);
      msg.querySelector('.msg-body').insertBefore(box, actions);
    },
    /** 中止：保留已生成的内容，只在末尾标一句「已停止」 */
    notice(text2) {
      prose.querySelector('.caret-blink')?.remove();
      if (!msg.querySelector('.stop-note')) {
        msg.querySelector('.msg-body').insertBefore(el('div', 'stop-note', text2), actions);
      }
    },
    getContent: () => raw,
    setAnnotations(list) {
      anns = list;
      if (list && list.length) {
        dirty = true;
        if (!renderTimer) flush();
      }
    },
    tools: toolStack,
    actions,
  };

  function ensureReasoning() {
    processBox.hidden = false;
    if (reasoningEl.hidden) {
      reasoningEl.hidden = false;
      reasoningEl.classList.add('open');
      reasoningMore.textContent = '收起';
    }
    updateProcessHeader(false);
  }

  function updateProcessHeader(finished) {
    const hasThink = !!think;
    if (!finished) {
      if (toolCount > 0 && hasThink) processTitle.textContent = '正在思考与检索…';
      else if (toolCount > 0) processTitle.textContent = '正在执行操作…';
      else processTitle.textContent = '思考中…';
      processMeta.textContent = toolCount > 0 ? `${toolCount} 步` : '';
      return;
    }
    if (hasThink && toolCount > 0) {
      processTitle.textContent = '思考与执行过程';
      processMeta.textContent = `${toolCount} 步操作`;
    } else if (toolCount > 0) {
      processTitle.textContent = '执行过程';
      processMeta.textContent = `${toolCount} 步操作`;
    } else if (hasThink) {
      processTitle.textContent = '思考过程';
      processMeta.textContent = '';
    }
  }

  /** 流结束或历史消息落库后统一收尾：折叠总面板与内嵌思考、去 spinner、更新摘要。 */
  function finalizeProcess() {
    if (processBox.hidden || processBox.dataset.finished) return;
    processBox.dataset.finished = '1';
    processBox.querySelector('.process-head .spinner')?.remove();
    processBox.classList.remove('open');
    processMore.textContent = '展开';
    if (!reasoningEl.hidden) {
      reasoningEl.classList.remove('open');
      reasoningMore.textContent = '展开';
    }
    updateProcessHeader(true);
  }

  function schedule() {
    dirty = true;
    if (renderTimer) return;
    renderTimer = setTimeout(flush, 60);
  }

  function flush() {
    if (!dirty) return;
    dirty = false;
    clearTimeout(renderTimer);
    renderTimer = null;
    prose.innerHTML = renderMarkdown(raw) || '<p class="caret-blink"></p>';
    if (anns && anns.length) {
      const sources = applyAnnotations(prose, anns, raw, (idx) => openSourcesDrawer(sources, idx));
      renderSourcesTrigger(sourcesSlot, sources);
    }
    if (!state.streaming || api._done) prose.querySelector('.caret-blink')?.remove();
  }

  if (reasoning) {
    ensureReasoning();
    reasoningBody.textContent = reasoning;
  }
  if (tools?.length) {
    tools.forEach((t) => api.addTool(t));
  }
  if (reasoning || tools?.length) {
    finalizeProcess();
  }
  if (text) api.setContent(text);
  if (annotationList && annotationList.length) api.setAnnotations(annotationList);

  return api;
}

/* --- 工具卡片 --- */
const TOOL_ICONS = {
  search_web: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="m19.5 19.5-4.2-4.2"/></svg>`,
  fetch_url: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 13.5a3.6 3.6 0 0 0 5.1 0l2.2-2.2a3.6 3.6 0 0 0-5.1-5.1L11 7.4"/><path d="M14 10.5a3.6 3.6 0 0 0-5.1 0L6.7 12.7a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"/></svg>`,
};

/**
 * 引用角标：把官方 annotations 映射成正文里的上标数字 + 末尾来源列表。
 * 官方结构：{type:"url_citation", url_citation:{url,title,start_index,end_index}}
 * start_index / end_index 是「Unicode 码点」偏移。
 */
function normCite(a) {
  if (!a) return null;
  const c = a.url_citation || a;
  if (!c || !c.url) return null;
  return {
    url: String(c.url),
    title: c.title || '',
    start_index: typeof c.start_index === 'number' ? c.start_index : null,
    end_index: typeof c.end_index === 'number' ? c.end_index : null,
  };
}

function applyAnnotations(container, anns, raw, onOpenSource) {
  container.querySelectorAll('.cite, .cite-sources').forEach((n) => n.remove());

  const seen = new Map();
  const sources = [];
  for (const rawCite of anns || []) {
    const c = normCite(rawCite);
    if (!c) continue;
    if (!seen.has(c.url)) {
      seen.set(c.url, sources.length + 1);
      sources.push(c);
    }
  }
  if (!sources.length) return;

  // 偏移必须建立在「渲染后的全部文本」上，否则前面有代码块时会整体错位。
  // 但只有当渲染文本与原文一致时才敢插角标：Markdown 会吞掉标记符号
  //（`**`、`#`、`|` 等），长度对不上就只显示末尾来源列表。
  // 官方给的是「模型原始输出」的码点偏移，含换行、`**`、表格竖线这些
  // 渲染时被吃掉的字符，所以不能要求 DOM 文本与原文等长。
  // 做法：把 DOM 文本与原文做一次双指针对齐——沿途跳过原文里那些
  // 在 DOM 中不存在的字符（空白 / Markdown 标记），得到「DOM 位置 → 原文码点」的映射。
  const SKIP = new Set(['\n', '\r', ' ', '\t', '*', '`', '#', '>', '|', '_', '~', '-', '…']);
  const domChars = []; // [{node, offset}] 每个码点一项，装饰性节点除外
  {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      if (n.parentNode.closest?.('.code-head, button, .cite, .cite-sources, .caret-blink')) continue;
      const cps = Array.from(n.nodeValue);
      // 注意：offset 必须按「码点」记，取字符也要用同一个码点数组取，
      // 不能拿它当 UTF-16 下标——一个 emoji 占两个 UTF-16 单元，
      // 混用会让整段对齐失败，角标全部消失。
      for (let i = 0; i < cps.length; i += 1) domChars.push({ node: n, offset: i, ch: cps[i] });
    }
  }
  const srcCps = Array.from(String(raw || ''));

  // map[i] = 第 i 个 DOM 码点对应的原文码点下标（找不到则为 -1）
  const map = new Array(domChars.length).fill(-1);
  let ri = 0;
  let skipped = 0;
  for (let di = 0; di < domChars.length; di += 1) {
    const ch = domChars[di].ch;
    let guard = 0;
    while (ri < srcCps.length && srcCps[ri] !== ch && guard < 400) {
      if (SKIP.has(srcCps[ri])) skipped += 1;
      ri += 1;
      guard += 1;
    }
    if (ri >= srcCps.length) break;
    map[di] = ri;
    ri += 1;
  }
  // 对齐失败（没对上几个字）就放弃正文角标，只留来源列表。
  // 注意别拿「跳过了多少字符」当门槛：表格和代码块的标记本来就占大半原文，
  // 只要剩下的 DOM 字符能一路对齐，就是可信的。
  const matched = map.filter((v) => v >= 0).length;
  const canInline = matched > 0 && matched >= domChars.length * 0.85;

  if (canInline) {
    const valid = (anns || [])
      .map(normCite)
      .filter((c) => c && c.url && c.start_index !== null && c.end_index !== null)
      // 从后往前插，避免前面的插入影响后面的 DOM 结构
      .sort((a, b) => b.end_index - a.end_index);

    for (const c of valid) {
      // 角标要贴在「被引用片段的最后一个字符」后面，
      // 而不是下一个字符前面——否则跨段落时会被塞进下一段开头。
      let di = -1;
      for (let i = 0; i < map.length; i += 1) {
        if (map[i] >= 0 && map[i] < c.end_index) di = i;
        else if (map[i] >= c.end_index) break;
      }
      if (di < 0) continue;
      const at = domChars[di];
      if (at.node.parentNode.closest?.('pre, code, sup')) continue;

      const num = seen.get(c.url);
      const sup = el('sup', 'cite');
      sup.textContent = String(num);
      sup.title = c.title || c.url;
      sup.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onOpenSource) onOpenSource(num);
      });
      const val = at.node.nodeValue;
      const cps = Array.from(val);
      const before = cps.slice(0, at.offset + 1).join(''); // 含被引用的最后一个字
      const after = cps.slice(at.offset + 1).join('');
      const parent = at.node.parentNode;
      at.node.nodeValue = before;
      parent.insertBefore(sup, at.node.nextSibling);
      if (after) parent.insertBefore(document.createTextNode(after), sup.nextSibling);
    }
  }

  return sources;
}

function renderSourcesTrigger(slot, sources) {
  slot.innerHTML = '';
  if (!sources || !sources.length) return;
  const btn = el('button', 'sources-trigger');
  btn.type = 'button';
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 13.5a3.6 3.6 0 0 0 5.1 0l2.2-2.2a3.6 3.6 0 0 0-5.1-5.1L11 7.4"/><path d="M14 10.5a3.6 3.6 0 0 0-5.1 0L6.7 12.7a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"/></svg><span>参考来源 · ${sources.length}</span><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>`;
  btn.addEventListener('click', () => openSourcesDrawer(sources, null));
  slot.append(btn);
}

function openSourcesDrawer(sources, highlightNum) {
  if (!sources || !sources.length) return;
  els.sourcesCount.textContent = String(sources.length);
  els.sourcesBody.innerHTML = '';
  let hitCard = null;
  sources.forEach((c, idx) => {
    const num = idx + 1;
    const safe = safeUrl(c.url);
    const card = safe ? el('a', 'source-card') : el('div', 'source-card');
    if (safe) {
      card.href = safe;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
    }
    if (highlightNum === num) {
      card.classList.add('hit');
      hitCard = card;
    }
    card.append(el('span', 'source-idx', String(num)));
    const main = el('div', 'source-main');
    main.append(el('span', 'source-title', c.title || c.url));
    main.append(el('span', 'source-url', c.url));
    card.append(main);
    els.sourcesBody.append(card);
  });
  els.sourcesScrim.classList.add('open');
  els.sourcesDrawer.classList.add('open');
  els.sourcesDrawer.setAttribute('aria-hidden', 'false');
  if (hitCard) {
    requestAnimationFrame(() => hitCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
}

function closeSourcesDrawer() {
  els.sourcesScrim.classList.remove('open');
  els.sourcesDrawer.classList.remove('open');
  els.sourcesDrawer.setAttribute('aria-hidden', 'true');
}

function addToolCard(stack, tool = {}) {
  const card = el('div', 'tool-card');
  const head = el('button', 'tool-head');
  head.type = 'button';
  head.innerHTML = `
    <span class="tool-ico">${TOOL_ICONS[tool.tool] || ''}</span>
    <span class="tool-label"></span>
    <span class="tool-meta"><span class="spinner"></span></span>`;
  const body = el('div', 'tool-body');
  head.querySelector('.tool-label').textContent = tool.label || (tool.tool === 'fetch_url' ? '打开网页' : '搜索');
  head.addEventListener('click', () => card.classList.toggle('open'));
  card.append(head, body);
  stack.append(card);

  const handle = { card, head, body };
  // 历史重画时把已保存的结果直接补上，否则卡片会一直停在「转圈」
  if (tool.status && tool.status !== 'running') {
    fillToolResult(handle, {
      ok: tool.status === 'ok',
      ms: tool.ms || 0,
      items: tool.items,
      page: tool.page,
      error: tool.error,
    });
  }
  return handle;
}

function fillToolResult(handle, evt) {
  const { card, body, head } = handle;
  const meta = head.querySelector('.tool-meta');
  const spinner = meta.querySelector('.spinner');
  spinner?.remove();
  card.classList.add(evt.ok ? 'ok' : 'fail');
  meta.textContent = evt.ok ? (evt.ms > 0 ? `${(evt.ms / 1000).toFixed(1)}s` : '完成') : '失败';

  body.innerHTML = '';
  if (!evt.ok) {
    body.append(el('div', 'tool-err', evt.error || '调用失败'));
    return;
  }
  if (evt.items?.length) {
    for (const it of evt.items) {
      const a = el('a', 'tool-result');
      const safeIt = sanitizeUrl(it.url);
      if (safeIt) { a.href = safeIt; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      a.innerHTML = `<span class="r-title"></span><span class="r-url"></span><span class="r-snip"></span>`;
      a.querySelector('.r-title').textContent = it.title || it.url;
      a.querySelector('.r-url').textContent = it.url;
      a.querySelector('.r-snip').textContent = it.snippet || '';
      body.append(a);
    }
  }
  if (evt.page) {
    const pageHref = sanitizeUrl(evt.page.url) || '#';
    body.innerHTML = `<a class="tool-result" href="${escapeHtml(pageHref)}" target="_blank" rel="noopener noreferrer">
      <span class="r-title">${escapeHtml(evt.page.title || '网页正文')}</span>
      <span class="r-url">${escapeHtml(evt.page.url)}</span>
      <span class="r-snip">${evt.page.chars ? `已读取 ${evt.page.chars} 字符` : '已读取网页'}${evt.page.truncated ? '（已截断）' : ''}</span>
    </a>`;
  }
}

/* ============ 6.5 附件（官方 Files API） ============ */

const PURPOSE_MAP = [
  // 纯文本/表格/电子书：不计费，传 user_data
  { re: /\.(txt|md|markdown|csv|json|js|ts|py|java|c|cpp|go|rs|html|css|xml|yml|yaml|log)$/i, purpose: 'user_data' },
  { re: /\.(xlsx|xls|epub|mobi)$/i, purpose: 'user_data' },
  // 需要解析的文档
  { re: /\.(pdf|doc|docx|ppt|pptx)$/i, purpose: 'rich_layout_recognition' },
  // 图片
  { re: /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i, purpose: 'text_recognition' },
];

function purposeFor(name, type) {
  for (const { re, purpose } of PURPOSE_MAP) if (re.test(name)) return purpose;
  if (/^image\//.test(type || '')) return 'text_recognition';
  return 'text_recognition';
}

function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 上传一个文件：把原始字节发给后端，后端转发到官方 /files */
async function uploadFile(file) {
  const purpose = purposeFor(file.name, file.type);
  const res = await fetch('/api/files', {
    method: 'POST',
    headers: {
      'X-Filename': encodeURIComponent(file.name),
      'X-Purpose': purpose,
      'Content-Type': 'application/octet-stream',
    },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderAttachments() {
  if (!els.attachStrip) return;
  els.attachStrip.innerHTML = '';
  if (!state.attachments.length) {
    els.attachStrip.hidden = true;
    return;
  }
  els.attachStrip.hidden = false;
  state.attachments.forEach((f, idx) => {
    const chip = el('div', `chip${f.uploading ? ' uploading' : ''}${f.error ? ' is-error' : ''}`);
    chip.append(el('span', 'c-name', f.name));
    chip.append(el('span', 'c-size', f.error ? '失败' : f.uploading ? '解析中…' : fmtSize(f.size)));
    const x = el('button', 'c-x');
    x.type = 'button';
    x.setAttribute('aria-label', '移除附件');
    x.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    x.addEventListener('click', () => {
      state.attachments.splice(idx, 1);
      renderAttachments();
      updateSendState();
    });
    chip.append(x);
    els.attachStrip.append(chip);
  });
}

const MAX_UPLOAD = 100 * 1024 * 1024;

async function addFiles(fileList) {
  for (const file of Array.from(fileList)) {
    if (!file) continue;
    if (file.size > MAX_UPLOAD) {
      toast(`「${file.name}」超过 100MB，官方接口收不了`, true);
      continue;
    }
    const item = { name: file.name, size: file.size, purpose: purposeFor(file.name, file.type), uploading: true };
    state.attachments.push(item);
    renderAttachments();
    try {
      const r = await uploadFile(file);
      item.fileId = r.fileId;
      item.purpose = r.purpose;
      item.uploading = false;
      // 图片额外存一份 data URL 用于 image_url 引用。
      // 必须先压缩：手机照片动辄 3~8MB，base64 后能到 10MB，
      // 而 /api/chat 的请求体上限是 2MB，不压就会「上传成功但一发送就 413」。
      if (/^image\//.test(file.type || '')) {
        let url = await shrinkImage(file);
        if (!url) url = await fileToDataUrl(file);
        if (url) {
          // 仍然过大就放弃内联，只靠已上传的 fileId（服务端会按文档解析）
          const bytes = Math.round((url.length * 3) / 4);
          if (bytes > 1.2 * 1024 * 1024) {
            item.imageTooBig = true;
            item.image = undefined;
          } else {
            item.image = url;
          }
        }
      }
    } catch (err) {
      item.uploading = false;
      item.error = err.message;
      toast(`「${file.name}」上传失败：${err.message}`, true);
    }
    renderAttachments();
    updateSendState();
  }
}

/** 图片等比压到 1600px 内并转 JPEG，避免 base64 撑爆请求体（服务端上限 2MB） */
function shrinkImage(file, maxSpan = 1600, quality = 0.86) {
  return new Promise((resolve) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type || '')) return resolve(null);
    if (typeof createImageBitmap !== 'function') return resolve(null);
    const timer = setTimeout(() => resolve(null), 4000);
    createImageBitmap(file)
      .then((bmp) => {
        const scale = Math.min(1, maxSpan / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
        bmp.close?.();
        const url = canvas.toDataURL('image/jpeg', quality);
        clearTimeout(timer);
        resolve(url);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
}

/* ============ 7. 发送 / 流式接收 ============ */

function updateSendState() {
  const has = els.input.value.trim().length > 0 || state.attachments.some((f) => f.fileId && !f.error);
  els.btnSend.disabled = state.streaming ? false : !has;
  els.btnSend.classList.toggle('stop', state.streaming);
  els.btnSend.title = state.streaming ? '停止生成' : '发送';
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
}

function scrollToBottom(force = false) {
  const near = els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight < 180;
  if (force || near) els.scroll.scrollTop = els.scroll.scrollHeight;
  syncJumpLatest();
}

/**
 * regenNodeId：只给「重新生成」用。传入一个提问节点 id 时，
 * 不新增提问，直接让模型对同一句提问再答一次，结果作为该提问的另一个回答版本。
 */
async function send(regenNodeId = null) {
  if (state.streaming) {
    stopStreaming();
    return;
  }
  const text = regenNodeId
    ? (state.messages.find((m) => m.id === regenNodeId)?.content || '')
    : els.input.value.trim();
  const files = regenNodeId ? [] : state.attachments.filter((f) => f.fileId && !f.error);
  if (state.attachments.some((f) => f.uploading)) {
    toast('还有文件在上传，稍等一下', true);
    return;
  }
  if (!text && !files.length) return;

  // 编辑旧提问：这条提问会被「新版本」取代显示，旧问答作为另一条分支留在树里
  const editing = regenNodeId ? null : state.editing;
  // 编辑第一句时 parentId 本来就是 null（挂在根上），
  // 所以「有没有 parentId 字段」必须单独判断，不能看值真假。
  const parentId = editing ? editing.parentId ?? null : null;
  const keepCount = editing ? state.messages.findIndex((m) => m.id === editing.nodeId) : state.messages.length;
  if (editing) {
    state.editing = null;
    els.btnEditCancel.hidden = true;
    els.composer.classList.remove('editing');
    els.hintText.textContent = '正在生成…';
    // 只保留到被编辑提问之前的消息，后面的先不显示
    state.messages = state.messages.slice(0, keepCount < 0 ? state.messages.length : keepCount);
    renderMessages();
  }

  els.input.value = '';
  state.attachments = [];
  renderAttachments();
  autosize();
  updateSendState();

  let userMsg = null;
  let localUser = { id: null, role: 'user', content: text, files: files.length ? files : undefined };
  if (regenNodeId) {
    // 复用原来那条提问，只把它后面的回答收起来（视图层）
    const idx = state.messages.findIndex((m) => m.id === regenNodeId);
    if (idx >= 0) {
      localUser = state.messages[idx];
      state.messages = state.messages.slice(0, idx + 1);
      renderMessages();
    }
  } else {
    userMsg = addUserMessage(text, null, files);
    state.messages.push(localUser);
  }

  const handle = addAssistantMessage('', '', [], state.model);
  const toolsSeen = [];

  let currentTool = null;
  let citeList = null;
  let wasAborted = false;
  let roundBreak = false;   // 本轮流式块已经遇到过工具调用，下一段正文要另起段落
  let content = '';
  let reasoning = '';
  let usage = null;

  state.streaming = true;
  updateSendState();
  els.hintText.textContent = '正在生成…';
  scrollToBottom(true);

  const ctrl = new AbortController();
  state.abortCtrl = ctrl;
  // 这次请求属于哪条流、回答落库后是哪条节点，都记下来用于收尾校验。
  // 不能用 sessionId 判断：新会话第一句时它还是 null，服务端随后才回填。
  const ownerToken = ++state.streamToken;
  let endAssistantId = null;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        sessionId: state.sessionId,
        message: text,
        model: state.model,
        useSearch: state.useSearch,
        thinking: state.thinking,
        ...(editing ? { parentId } : {}),
        ...(regenNodeId ? { regenFrom: regenNodeId } : {}),
        ...(files.length
          ? { files: files.map((f) => ({ name: f.name, fileId: f.fileId, image: f.image || undefined })) }
          : {}),
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('浏览器不支持流式读取');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const rawEvent = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of rawEvent.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let evt;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          handleEvent(evt);
        }
      }
      scrollToBottom();
    }

    function handleEvent(evt) {
      switch (evt.type) {
        case 'session':
          if (!state.sessionId) {
            state.sessionId = evt.sessionId;
            LS.set('sessionId', evt.sessionId);
          }
          break;
        case 'user':
          // 服务端已经把这句提问写进消息树，前端补上 id 当作分支锚点
          if (evt.id) {
            localUser.id = evt.id;
            localUser.parentId = evt.parentId || null;
            if (userMsg) userMsg.dataset.id = evt.id;
          }
          break;
        case 'reasoning':
          reasoning += evt.text;
          handle.setReasoning(reasoning);
          break;
        case 'content':
          // 工具调用之后模型会开启新一轮输出，补两个换行让 Markdown 分段
          if (roundBreak && !/\n\s*\n$/.test(content)) {
            content = content.replace(/\s+$/, '') + '\n\n';
            roundBreak = false;
          }
          content += evt.text;
          els.hintText.textContent = '正在生成…';
          handle.setContent(content);
          break;
        case 'tool_start': {
          roundBreak = true;
          const label = evt.label || '联网';
          currentTool = handle.addTool({ tool: evt.tool, label });
          toolsSeen.push({ tool: evt.tool, label, status: 'running' });
          scrollToBottom();
          break;
        }
        case 'tool_result': {
          if (currentTool) {
            fillToolResult(currentTool, evt);
            const last = toolsSeen[toolsSeen.length - 1];
            if (last) {
              last.status = evt.ok ? 'ok' : 'fail';
              if (evt.items && evt.items.length) last.items = evt.items.slice(0, 6);
              if (evt.page) last.page = evt.page;
              if (evt.error) last.error = evt.error;
              last.ms = evt.ms;
            }
            currentTool = null;
          }
          els.hintText.textContent = evt.ok ? '已获取资料，正在整理…' : '资料获取失败，继续回答…';
          break;
        }
        case 'annotations':
          if (evt.list?.length) {
            handle.setAnnotations(evt.list);
            citeList = evt.list;
          }
          break;
        case 'step_done':
          break;
        case 'notice':
          toast(evt.text);
          break;
        case 'error':
          handle.fail(evt.message);
          els.hintText.textContent = '生成中断';
          break;
        case 'done':
          usage = evt.usage;
          break;
        case 'title':
          els.chatTitle.textContent = evt.title;
          loadSessions();
          break;
        case 'end':
          if (evt.assistantId) endAssistantId = evt.assistantId;
          break;
        default:
          break;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      wasAborted = true;
      handle.notice('已停止生成');
    } else {
      handle.fail(err.message);
    }
  } finally {
    state.streaming = false;
    state.abortCtrl = null;
    handle.finish();
    updateSendState();

    // 只有「这条流已经不是当前流」时才丢弃（切了会话/开了新会话会 +1 token）
    const staleSession = ownerToken !== state.streamToken;

    if (content.trim()) {
      const id = endAssistantId || null;
      state.messages.push({
        id,
        parentId: localUser.id || null,
        role: 'assistant',
        content,
        reasoning: reasoning || undefined,
        tools: toolsSeen.length ? toolsSeen : undefined,
        model: state.model,
        annotations: citeList || undefined,
      });
      if (id) handle.node.dataset.id = id;
    }
    if (usage) {
      const bits = [`输入 ${fmtNum(usage.prompt_tokens)}`, `输出 ${fmtNum(usage.completion_tokens)}`];
      if (usage.reasoning_tokens) bits.push(`思考 ${fmtNum(usage.reasoning_tokens)}`);
      els.usageText.textContent = `${bits.join(' · ')} tokens`;
    }
    els.hintText.textContent = '内容由 AI 生成，请注意核实';

    // 本地同步一条，避免刷新后丢失标题
    if (state.sessionId && content.trim()) {
      state.sessions = state.sessions.map((s) =>
        s.id === state.sessionId
          ? { ...s, updatedAt: Date.now(), title: s.title === '新对话' ? text.slice(0, 24) : s.title }
          : s
      );
      if (!state.sessions.some((s) => s.id === state.sessionId)) {
        state.sessions.unshift({
          id: state.sessionId,
          title: text.slice(0, 24),
          model: state.model,
          updatedAt: Date.now(),
        });
      }
      renderSessionList();
      els.chatTitle.textContent = state.sessions.find((s) => s.id === state.sessionId)?.title || '';
    }
    // 分支角标只有服务端知道完整信息：拉一次真实状态重画（长会话会有点开销，
    // 但只在回答结束后发生，且不打断阅读位置）。
    // ① 中止时服务端还在收尾（写节点、setLeaf），要等一会儿再拉，
    //    否则会拉到「有提问、没 leafId」的中间态，把界面刷成空对话；
    // ② 拉回来的消息数比本地少也不重画，宁可留着本地的完整内容。
    if (!staleSession && content.trim() && state.sessionId) {
      if (wasAborted) await new Promise((r) => setTimeout(r, 700));
      const y = els.scroll.scrollTop;
      const before = state.messages.length;
      await refreshSession({ minCount: before });
      els.scroll.scrollTop = y;
    }
    els.input.focus();
  }
}

/** 重新拉当前会话，保持滚动位置 */
async function refreshSession({ minCount = 0 } = {}) {
  if (!state.sessionId) return;
  try {
    const { session } = await api(`/api/sessions/${state.sessionId}`);
    const msgs = session.messages || [];
    // 服务端还没写完时拉到的可能比本地少，这种情况直接放弃这次重画
    if (msgs.length < minCount) return;
    state.messages = msgs;
    state.branches = session.branches || {};
    renderMessages();
  } catch {
    /* 静默：拉不到就维持现状 */
  }
}

function stopStreaming() {
  state.abortCtrl?.abort();
}

/* ============ 8. 设置 ============ */

function fillSettingsForm() {
  if (!state.config) return;
  els.apiKeyInput.value = '';
  els.apiKeyInput.placeholder = state.config.hasKey
    ? `已保存 ${state.config.keyHint}（留空则不修改）`
    : 'sk-…';
  els.baseUrlInput.value = state.config.baseUrl || '';
  els.sysPromptInput.value = state.config.systemPrompt || '';
  els.searchCheck.checked = !!state.config.webSearch;
  els.readUrlCheck.checked = !!state.config.readUrl;
  els.thinkingCheck.checked = !!state.config.thinking;
  els.safetyCheck.checked = !!state.config.safety;
  els.titleCheck.checked = !!state.config.title;
  els.searchStatus.innerHTML =
    '联网搜索 / 阅读链接 / 文件解析都由 <code>api.deepseek.com</code> 服务端完成，' +
    '只支持 <code>deepseek-flash</code>；切到 <code>deepseek-v4-pro</code> 时自动停用。';
}

function openSettings() {
  fillSettingsForm();
  // 提示词框按内容自适应，避免内容被裁掉
  requestAnimationFrame(() => {
    const ta = els.sysPromptInput;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 340)}px`;
  });
  els.settingsModal.hidden = false;
  setTimeout(() => els.apiKeyInput.focus(), 60);
}

function closeSettings() {
  els.settingsModal.hidden = true;
}

async function saveSettings() {
  const patch = {
    baseUrl: els.baseUrlInput.value.trim() || undefined,
    webSearch: els.searchCheck.checked,
    readUrl: els.readUrlCheck.checked,
    thinking: els.thinkingCheck.checked,
    safety: els.safetyCheck.checked,
    title: els.titleCheck.checked,
    // 传空字符串表示清空系统提示词（不再用 || undefined 把空值吞掉）
    systemPrompt: els.sysPromptInput.value.trim(),
  };
  const key = els.apiKeyInput.value.trim();
  if (key) patch.apiKey = key;

  try {
    state.config = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
    state.useSearch = state.config.webSearch;
    state.thinking = state.config.thinking;
    syncSearchBtn();
    syncThinkBtn();
    els.keyDot.classList.toggle('ok', state.config.hasKey);
    els.keyDot.title = state.config.hasKey ? `已配置 ${state.config.keyHint}` : 'API Key 未配置';
    closeSettings();
    toast('设置已保存');
    if (!state.messages.length) renderWelcome();
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  }
}

function syncSearchBtn() {
  els.btnSearch.setAttribute('aria-pressed', String(!!state.useSearch));
  els.btnSearch.title = `联网搜索：${state.useSearch ? '开启' : '关闭'}`;
}

function syncThinkBtn() {
  els.btnThink.setAttribute('aria-pressed', String(!!state.thinking));
  els.btnThink.title = `深度思考：${state.thinking ? '开启' : '关闭'}`;
}

function syncJumpLatest() {
  const far = els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight > 240;
  els.btnJumpLatest.hidden = !far;
}

/* ============ 9. 事件绑定 ============ */

function bindEvents() {
  /* 输入框 */
  els.input.addEventListener('input', () => {
    autosize();
    updateSendState();
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!state.streaming) send();
    }
  });
  els.btnSend.addEventListener('click', () => {
    if (state.streaming) stopStreaming();
    else send();
  });
  els.btnEditCancel.addEventListener('click', cancelEdit);

  /* 附件：按钮 / 选择文件 / 粘贴 */
  els.btnAttach?.addEventListener('click', () => els.filePicker?.click());
  els.filePicker?.addEventListener('change', async () => {
    if (els.filePicker.files?.length) await addFiles(els.filePicker.files);
    els.filePicker.value = '';
    updateSendState();
  });
  els.input.addEventListener('paste', async (e) => {
    const picked = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (!picked.length) return;
    e.preventDefault();
    await addFiles(picked);
    updateSendState();
  });
  els.composer?.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.composer.classList.add('dragging');
  });
  els.composer?.addEventListener('dragleave', () => els.composer.classList.remove('dragging'));
  els.composer?.addEventListener('drop', async (e) => {
    e.preventDefault();
    els.composer.classList.remove('dragging');
    const dropped = e.dataTransfer?.files;
    if (dropped?.length) {
      await addFiles(dropped);
      updateSendState();
    }
  });

  /* 新建对话 */
  $('#btnNew').addEventListener('click', () => {
    if (state.streaming) stopStreaming();
    state.streamToken += 1;
    state.sessionId = null;
    state.messages = [];
    LS.set('sessionId', null);
    renderWelcome();
    renderSessionList();
    els.app.classList.remove('mobile-open');
    els.input.focus();
  });

  /* 模型切换 */
  els.modelSelect.addEventListener('change', async () => {
    state.model = els.modelSelect.value;
    LS.set('model', state.model);
    if (state.sessionId) {
      await api(`/api/sessions/${state.sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ model: state.model }),
      }).catch(() => {});
      state.sessions = state.sessions.map((s) =>
        s.id === state.sessionId ? { ...s, model: state.model } : s
      );
    }
    toast(
      state.model === 'deepseek-v4-pro'
        ? '已切到 V4 Pro（不联网，深度推理）'
        : '已切到 Flash（支持联网与图片）'
    );
  });

  /* 联网开关 */
  els.btnSearch.addEventListener('click', () => {
    state.useSearch = !state.useSearch;
    syncSearchBtn();
    api('/api/config', { method: 'POST', body: JSON.stringify({ webSearch: state.useSearch }) }).catch(
      () => {}
    );
  });

  /* 深度思考开关：按轮生效，同时同步全局默认值 */
  els.btnThink.addEventListener('click', () => {
    state.thinking = !state.thinking;
    syncThinkBtn();
    api('/api/config', { method: 'POST', body: JSON.stringify({ thinking: state.thinking }) }).catch(
      () => {}
    );
  });

  /* 明暗切换 */
  $('#btnTheme').addEventListener('click', () => {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
  // 跟随系统（用户未手动选过时）
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (LS.get('theme', null) === null) applyTheme(e.matches ? 'dark' : 'light');
  });

  /* 侧栏折叠 / 展开 */
  /** expanded: true 展开 / false 收起 / 不传则切换 */
  function toggleSidebar(expanded) {
    if (window.innerWidth <= 820) {
      els.app.classList.toggle('mobile-open', expanded === undefined ? undefined : expanded);
      return;
    }
    const collapsed = els.app.classList.contains('collapsed');
    const next = expanded === undefined ? !collapsed : !expanded;
    els.app.classList.toggle('collapsed', next);
    LS.set('collapsed', next);
  }

  $('#btnCollapse').addEventListener('click', () => toggleSidebar(false));
  $('#btnMenu').addEventListener('click', () => toggleSidebar());

  // 快捷键：Ctrl/Cmd + B 切换侧栏（和常见编辑器一致）
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleSidebar();
    }
  });
  els.scrim.addEventListener('click', () => els.app.classList.remove('mobile-open'));

  // 视口跨过断点时清理移动端专属状态，避免残留遮罩
  let wasNarrow = window.innerWidth <= 820;
  window.addEventListener('resize', () => {
    const narrow = window.innerWidth <= 820;
    if (wasNarrow !== narrow) {
      els.app.classList.remove('mobile-open');
      els.app.classList.toggle('collapsed', LS.get('collapsed', false));
      wasNarrow = narrow;
    }
  });

  /* 设置 */
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  els.btnCloseSources.addEventListener('click', closeSourcesDrawer);
  els.sourcesScrim.addEventListener('click', closeSourcesDrawer);
  els.settingsModal.addEventListener('click', (e) => {
    if (e.target === els.settingsModal) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (els.sourcesDrawer.classList.contains('open')) {
        closeSourcesDrawer();
        return;
      }
      if (state.editing) {
        cancelEdit();
        return;
      }
      if (!els.settingsModal.hidden) closeSettings();
      els.app.classList.remove('mobile-open');
    }
  });
  $('#btnToggleKey').addEventListener('click', () => {
    const isPw = els.apiKeyInput.type === 'password';
    els.apiKeyInput.type = isPw ? 'text' : 'password';
    $('#btnToggleKey').textContent = isPw ? '隐藏' : '显示';
  });
  $('#btnTestKey').addEventListener('click', async () => {
    const btn = $('#btnTestKey');
    const old = btn.textContent;
    btn.textContent = '测试中…';
    btn.disabled = true;
    try {
      // 若表单里填了新 key，先临时保存
      const key = els.apiKeyInput.value.trim();
      if (key) await api('/api/config', { method: 'POST', body: JSON.stringify({ apiKey: key }) });
      await api('/api/test-key', { method: 'POST' });
      btn.textContent = '连接正常 ✓';
      toast('API Key 可用');
    } catch (err) {
      btn.textContent = '测试失败';
      toast(err.message, true);
    } finally {
      setTimeout(() => {
        btn.textContent = old;
        btn.disabled = false;
      }, 1800);
    }
  });

  /* 消息操作（事件委托） */
  els.messages.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('.copy-code');
    if (copyBtn) {
      const code = copyBtn.closest('pre')?.querySelector('code')?.textContent || '';
      await copyText(code);
      copyBtn.textContent = '已复制';
      setTimeout(() => (copyBtn.textContent = '复制'), 1400);
      return;
    }
    const actCopy = e.target.closest('.act-copy');
    if (actCopy) {
      const msg = actCopy.closest('.msg');
      const text = msg.querySelector('.prose')?.innerText || '';
      await copyText(text);
      const label = actCopy.querySelector('.act-label');
      if (label) label.textContent = '已复制';
      actCopy.classList.add('done');
      setTimeout(() => {
        if (label) label.textContent = '复制';
        actCopy.classList.remove('done');
      }, 1400);
      return;
    }
    const actRegen = e.target.closest('.act-regen');
    if (actRegen) {
      const msg = actRegen.closest('.msg');
      const aid = msg?.dataset.id;
      if (!aid) { toast('这条回答还没保存，暂时不能重新生成', true); return; }
      if (state.streaming) { toast('正在生成，先停止再重试', true); return; }
      // 两条提问夹着一个回答：往上找最近一条提问
      const i = state.messages.findIndex((m) => m.id === aid);
      let qid = null;
      for (let k = i - 1; k >= 0; k--) {
        if (state.messages[k].role === 'user') { qid = state.messages[k].id; break; }
      }
      if (!qid) { toast('找不到这条回答对应的提问', true); return; }
      send(qid);
      return;
    }
    const actEdit = e.target.closest('.act-edit');
    if (actEdit) {
      const msg = actEdit.closest('.msg');
      const id = msg?.dataset.id;
      if (!id) {
        toast('这条提问还没保存，暂时不能编辑', true);
        return;
      }
      if (state.streaming) {
        toast('正在生成，先停止再编辑', true);
        return;
      }
      startEdit(id);
    }
  });

  /* 双击提问也能进编辑 */
  els.messages.addEventListener('dblclick', (e) => {
    const bubble = e.target.closest('.msg.user .bubble');
    const id = bubble?.closest('.msg')?.dataset.id;
    if (id && !state.streaming) startEdit(id);
  });

  /* 移动端输入时避免被键盘遮挡 */
  els.input.addEventListener('focus', () => {
    setTimeout(() => scrollToBottom(true), 260);
  });

  /* 回到底部 */
  els.scroll.addEventListener('scroll', syncJumpLatest, { passive: true });
  els.btnJumpLatest.addEventListener('click', () => {
    els.scroll.scrollTo({ top: els.scroll.scrollHeight, behavior: 'smooth' });
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/* ============ 启动 ============ */
init();

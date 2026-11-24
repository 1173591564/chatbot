/**
 * 会话存储：JSON 文件落盘到 data/sessions.json。
 *
 * 每个会话是一棵「消息树」，支持回到任意一轮提问重新编辑：
 *   {
 *     id, title, model, createdAt, updatedAt,
 *     nodes: [{ id, parentId, role, content, reasoning?, tools?, model?, createdAt }],
 *     leafId          // 当前正在看的那条分支的末端
 *   }
 *
 * 当前对话 = 从 leafId 顺着 parentId 走到根、再反转。
 * 同一个父节点下、角色相同的多个子节点就是「分支」，前端用 ‹ 1/2 › 切换。
 * 这样编辑旧提问不会覆盖原来的问答，只是多长出一条新枝。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './config.js';

const FILE = path.join(paths.DATA_DIR, 'sessions.json');
const MAX_SESSIONS = 200;

let store = { sessions: [] };
let saveTimer = null;

/* ---------------- 旧格式迁移 ---------------- */

/**
 * 早期版本一个会话只有一个 messages 数组（一条直线）。
 * 读盘时把它折成一条链，leafId 指向最后一条，之后所有读写都走树。
 */
function migrate(session) {
  if (Array.isArray(session.nodes)) return session;

  const legacy = Array.isArray(session.messages) ? session.messages : [];
  const nodes = [];
  let parentId = null;
  for (const m of legacy) {
    if (!m || !m.role) continue;
    const node = {
      id: crypto.randomUUID(),
      parentId,
      role: m.role,
      content: m.content || '',
      createdAt: session.createdAt || Date.now(),
    };
    if (m.reasoning) node.reasoning = m.reasoning;
    if (m.tools) node.tools = m.tools;
    if (m.model) node.model = m.model;
    nodes.push(node);
    parentId = node.id;
  }
  delete session.messages;
  session.nodes = nodes;
  session.leafId = parentId;
  return session;
}

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (Array.isArray(data.sessions)) {
        store = { sessions: data.sessions.map(migrate) };
      }
    }
  } catch (err) {
    console.warn('[sessions] 读取失败，使用空存储：', err.message);
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 200);
}

/** 立刻落盘（进程退出前或需要强一致时用） */
export function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.mkdirSync(paths.DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 1));
  } catch (err) {
    console.warn('[sessions] 写入失败：', err.message);
  }
}

load();

/* ---------------- 树操作 ---------------- */

export function findNode(session, nodeId) {
  if (!session || !nodeId) return null;
  return session.nodes.find((n) => n.id === nodeId) || null;
}

/** 从 leaf 往上回溯到根，返回正序路径 */
export function pathOf(session, leafId = session?.leafId) {
  if (!session) return [];
  const out = [];
  let cur = findNode(session, leafId);
  let guard = 0;
  while (cur && guard < 5000) {
    out.push(cur);
    cur = cur.parentId ? findNode(session, cur.parentId) : null;
    guard += 1;
  }
  return out.reverse();
}

/** 同一父节点下、角色相同的兄弟（含自己），按创建时间排序 */
export function siblingsOf(session, node) {
  if (!session || !node) return [];
  return session.nodes
    .filter((n) => (n.parentId || null) === (node.parentId || null) && n.role === node.role)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/** 从某个节点一路往下走，始终选最新的子节点，得到该分支的末端 */
export function deepestLeaf(session, nodeId) {
  let cur = findNode(session, nodeId);
  let guard = 0;
  while (cur && guard < 5000) {
    const kids = session.nodes
      .filter((n) => n.parentId === cur.id)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (!kids.length) break;
    cur = kids[kids.length - 1];
    guard += 1;
  }
  return cur ? cur.id : nodeId;
}

/* ---------------- 会话 CRUD ---------------- */

export function listSessions() {
  return [...store.sessions]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((s) => ({
      id: s.id,
      title: s.title,
      model: s.model,
      updatedAt: s.updatedAt,
      // 只数当前分支上的提问，切到别的分支后计数跟着变
      count: pathOf(s).filter((n) => n.role === 'user').length,
      branchCount: branchPointCount(s),
    }));
}

/** 有多少个「有多个版本」的节点，用于列表上标注 */
function branchPointCount(session) {
  const seen = new Map();
  for (const n of session.nodes) {
    const key = `${n.parentId || 'root'}:${n.role}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  let n = 0;
  for (const v of seen.values()) if (v > 1) n += v - 1;
  return n;
}

export function getSession(id) {
  return store.sessions.find((s) => s.id === id) || null;
}

export function createSession({ title = '新对话', model = 'deepseek-flash' } = {}) {
  const now = Date.now();
  const session = {
    id: crypto.randomUUID(),
    title,
    model,
    createdAt: now,
    updatedAt: now,
    nodes: [],
    leafId: null,
  };
  store.sessions.unshift(session);
  if (store.sessions.length > MAX_SESSIONS) {
    store.sessions = store.sessions.slice(0, MAX_SESSIONS);
  }
  saveSoon();
  return session;
}

export function updateSession(id, patch = {}) {
  const s = getSession(id);
  if (!s) return null;
  if (typeof patch.title === 'string') s.title = patch.title.slice(0, 80);
  if (typeof patch.model === 'string') s.model = patch.model;
  // 切换分支：只接受确实存在的节点，防止前端传来脏 id 把会话弄坏
  if (patch.leafId !== undefined) {
    if (patch.leafId === null) s.leafId = null;
    else if (findNode(s, String(patch.leafId))) s.leafId = String(patch.leafId);
  }
  s.updatedAt = Date.now();
  saveSoon();
  return s;
}

export function deleteSession(id) {
  const before = store.sessions.length;
  store.sessions = store.sessions.filter((s) => s.id !== id);
  if (store.sessions.length !== before) saveSoon();
  return store.sessions.length !== before;
}

/**
 * 往树里加一条消息。
 * parentId 为 null 表示挂在根上（新会话的第一句）。
 */
export function addNode(sessionId, { parentId = null, role, content = '', reasoning, tools, model, files, annotations, serverCalls } = {}) {
  const s = getSession(sessionId);
  if (!s) return null;
  const node = {
    id: crypto.randomUUID(),
    parentId: parentId && findNode(s, parentId) ? parentId : null,
    role,
    content,
    createdAt: Date.now(),
  };
  if (reasoning) node.reasoning = reasoning;
  if (tools && tools.length) node.tools = tools;
  if (model) node.model = model;
  if (files && files.length) node.files = files;
  if (annotations && annotations.length) node.annotations = annotations;
  if (serverCalls && serverCalls.length) node.serverCalls = serverCalls;
  s.nodes.push(node);
  s.updatedAt = node.createdAt;
  // 标题取第一轮提问
  if (s.title === '新对话' && role === 'user' && content) {
    s.title = content.replace(/\s+/g, ' ').slice(0, 24) || '新对话';
  }
  saveSoon();
  return node;
}

/** 把「当前看的位置」挪到某个节点 */
export function setLeaf(sessionId, nodeId) {
  const s = getSession(sessionId);
  if (!s) return null;
  if (nodeId && !findNode(s, nodeId)) return null;
  s.leafId = nodeId || null;
  s.updatedAt = Date.now();
  saveSoon();
  return s;
}

/**
 * 从会话历史构造发给模型的 messages。
 * upToId 指定上下文截到哪一条为止（编辑旧提问时只带它前面的内容）。
 * 空内容的助手节点（中止、报错）会被跳过，避免把半截回答喂给模型。
 */
/**
 * 构造一条用户消息的 content。
 *
 * 附件分两种走法：
 *   - 图片：本轮带了 data URL 就用 image_url（原图最准）；历史轮次没有 data URL
 *     时退回 fileId —— 官方支持用 Files API 的 file_id 引用图片。
 *     这样 sessions.json 里不用存整张图的 base64。
 *   - 其它文件：{type:'file', file_id}，让官方去解析。
 *
 */
export function userContent(text = '', files = []) {
  if (!files || !files.length) return text;
  const parts = [];
  const notes = [];      // 没带原图、又不是文档的附件，用一句话说明
  for (const f of files) {
    if (f.image) {
      // 本轮带了原图：走 image_url 最准
      parts.push({ type: 'image_url', image_url: { url: f.image } });
    } else if (f.fileId && !isImageFile(f)) {
      // 文档：交给官方解析
      parts.push({ type: 'file', file_id: f.fileId });
    } else if (isImageFile(f)) {
      // 历史轮次的图片：base64 已剥掉，拿 file_id 当文档喂会被官方拒绝
      // （图片是 text_recognition 解析出来的，不是文档）。这里只留一句占位。
      notes.push(`（之前发过一张图片${f.name ? `：${f.name}` : ''}）`);
    }
  }
  const body = text || (parts.length ? '请看看这些内容。' : '');
  const withNotes = notes.length ? `${body}${body ? '\n' : ''}${notes.join('\n')}` : body;
  if (!parts.length) return withNotes;
  parts.push({ type: 'text', text: withNotes || '请看看这些内容。' });
  return parts;
}

/** 按 purpose / 文件名判断是不是图片附件 */
function isImageFile(f = {}) {
  if (f.purpose === 'text_recognition') return true;
  return /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(String(f.name || ''));
}

export function toApiMessages(session, systemPrompt, upToId) {
  const out = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  for (const m of pathOf(session, upToId)) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!m.content && !(m.files && m.files.length)) continue;

    if (m.role === 'user' && m.files && m.files.length) {
      // 历史轮次不回放图片 base64（落盘时已经剥掉，这里再兜一层），
      // 否则每轮请求体都会被历史图片撑大
      out.push({ role: 'user', content: userContent(m.content, m.files) });
      continue;
    }

    if (m.role === 'assistant') {
      if (!m.content) continue;
      const am = { role: 'assistant', content: m.content };
      // 官方要求：上一轮的 server_tool_calls / annotations 原样回传，
      // 否则模型会重复搜索，或引用编号对不上。
      if (m.serverCalls) am.server_tool_calls = m.serverCalls;
      if (m.annotations) am.annotations = m.annotations;
      out.push(am);
      continue;
    }

    out.push({ role: 'user', content: m.content });
  }
  return out;
}

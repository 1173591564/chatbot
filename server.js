import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConfig, publicConfig, setConfig, paths } from './lib/config.js';
import {
  listSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  addNode,
  setLeaf,
  pathOf,
  siblingsOf,
  deepestLeaf,
  findNode,
  toApiMessages,
  userContent,
  flush,
} from './lib/sessions.js';
import { runChat, UserError, MODELS, supportsServerTools } from './lib/deepseek.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(paths.ROOT, 'public');

/* ---------------- 官方工具调用 → 前端文案 ---------------- */

function shortUrl(u = '') {
  try {
    const x = new URL(u);
    return x.hostname + (x.pathname.length > 1 ? x.pathname.slice(0, 28) : '');
  } catch {
    return String(u).slice(0, 40);
  }
}

function describeCall(call = {}) {
  const a = call.action || {};
  const kind = call.kind || '';
  if (a.type === 'search') {
    const q = (a.queries || []).join('、');
    return {
      tool: kind === 'image_search' || kind === 'deep_image_search' ? 'image_search' : 'search_web',
      label: q ? `搜索「${q}」` : '搜索',
    };
  }
  if (a.type === 'open_page') {
    return { tool: 'fetch_url', label: `打开 ${shortUrl(a.url)}` };
  }
  if (a.type === 'read_link') {
    return { tool: 'fetch_url', label: `阅读 ${shortUrl(a.url)}` };
  }
  if (a.type === 'find_in_page') {
    return { tool: 'fetch_url', label: `页内查找「${a.pattern || ''}」` };
  }
  return { tool: 'search_web', label: '联网' };
}

/* ---------------- 工具函数 ---------------- */

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req, limit = 2_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      // 这个上限最常被图片撞到：base64 会把原始字节放大约 1.37 倍
      const mb = Math.round(limit / 1024 / 1024);
      throw new UserError(
        `请求体超过 ${mb}MB。多半是图片太大——请换小一点的图，或先用截图/压缩再发。`,
        413
      );
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new UserError('请求体不是合法的 JSON', 400);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/* ---------------- 静态资源版本号 ----------------
   开发期最容易踩的坑：改了 css/js，浏览器还在用缓存里的旧文件。
   这里在返回 index.html 时，把 /style.css 之类改写成 /style.css?v=<mtime>，
   文件一变 URL 就变，浏览器只能重新拉，无需用户手动清缓存。
   --------------------------------------------------- */

function assetVersion(relPath) {
  try {
    const st = fs.statSync(path.join(PUBLIC_DIR, relPath));
    return Math.floor(st.mtimeMs).toString(36);
  } catch (e) {
    return '0';
  }
}

function injectVersions(html) {
  return html
    .replace(/(href="\/style\.css)(")/g, '$1?v=' + assetVersion('style.css') + '$2')
    .replace(/(src="\/app\.js)(")/g, '$1?v=' + assetVersion('app.js') + '$2');
}

function serveStatic(req, res, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    // 畸形转义（/%ZZ、/a%2）：直接当 404，不要让异常冒到顶层变成 500
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad Request');
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  // 防目录穿越：用「目录 + 分隔符」比对，否则 public_evil/ 也能过
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    // 开发期不做强缓存：每次都用 ETag 校验，内容没变只回 304，
    // 改了文件立刻生效，避免"改了代码但浏览器还在用旧版"。
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }).end();
      return;
    }
    // HTML 走注入：把资源引用加上版本号，改了文件浏览器必然重新拉
    if (ext === '.html') {
      fs.readFile(target, 'utf8', (e2, html) => {
        if (e2) { res.writeHead(500).end('Internal Error'); return; }
        const body = Buffer.from(injectVersions(html), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': body.length,
        });
        res.end(body);
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
    });
    fs.createReadStream(target).pipe(res);
  });
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const method = req.method || 'GET';

  try {
    /* ---------- 配置 ---------- */
    if (pathname === '/api/config' && method === 'GET') {
      return json(res, 200, { ...publicConfig(), models: MODELS });
    }

    if (pathname === '/api/config' && method === 'POST') {
      const patch = await readJsonBody(req);
      const next = setConfig(patch);
      return json(res, 200, { ...next, models: MODELS });
    }

    if (pathname === '/api/test-key' && method === 'POST') {
      const cfg = getConfig();
      if (!cfg.apiKey) throw new UserError('还没填 API Key');
      const r = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      }).catch((e) => {
        throw new UserError(`连接失败：${e.message}`, 502);
      });
      if (r.status === 401) throw new UserError('Key 无效（401）', 401);
      if (!r.ok) throw new UserError(`DeepSeek 返回 ${r.status}`, 400);
      return json(res, 200, { ok: true });
    }

    /* ---------- 文件上传：转发到官方 Files API ---------- */
    if (pathname === '/api/files' && method === 'POST') {
      const cfg = getConfig();
      if (!cfg.apiKey) throw new UserError('还没填 API Key', 400);

      // 浏览器发来的是原始字节 + 文件名/purpose 头，这里重新组 multipart。
      // 官方要求 purpose 字段必须排在 file 之前，否则 400。
      // 文件名是 encodeURIComponent 过的，解不开就退回默认名，别让一条脏头把请求打挂
      let filename = 'file';
      try {
        filename = decodeURIComponent(String(req.headers['x-filename'] || 'file')).slice(0, 180) || 'file';
      } catch {
        /* 保留默认 */
      }
      const PURPOSES = ['user_data', 'text_recognition', 'rich_layout_recognition'];
      const wantPurpose = String(req.headers['x-purpose'] || 'text_recognition');
      const purpose = PURPOSES.includes(wantPurpose) ? wantPurpose : 'text_recognition';
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 100 * 1024 * 1024) throw new UserError('文件超过 100 MiB', 413);
        chunks.push(c);
      }
      if (!chunks.length) throw new UserError('空文件', 400);

      const form = new FormData();
      form.append('purpose', purpose);
      form.append('file', new Blob([Buffer.concat(chunks)]), filename);

      const r = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: form,
      }).catch((e) => {
        throw new UserError(`上传失败：${e.message}`, 502);
      });

      const text = await r.text();
      let data = {};
      try {
        data = JSON.parse(text);
      } catch {
        /* 非 JSON */
      }
      if (!r.ok) {
        const msg = data.error?.message || text.slice(0, 300) || `HTTP ${r.status}`;
        throw new UserError(`文件解析失败（${r.status}）：${msg}`, r.status === 413 ? 413 : 400);
      }
      return json(res, 200, {
        fileId: data.id,
        filename: data.filename || filename,
        bytes: data.bytes || size,
        purpose: data.purpose || purpose,
      });
    }

    /* ---------- 会话 CRUD ---------- */
    if (pathname === '/api/sessions' && method === 'GET') {
      return json(res, 200, { sessions: listSessions() });
    }

    if (pathname === '/api/sessions' && method === 'POST') {
      const body = await readJsonBody(req);
      const s = createSession({ model: MODELS.includes(body.model) ? body.model : MODELS[0] });
      return json(res, 200, { session: s });
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([\w-]+)$/);
    if (sessionMatch) {
      const id = sessionMatch[1];
      const s = getSession(id);
      if (!s) throw new UserError('会话不存在', 404);

      if (method === 'GET') {
        // 前端要画「当前分支」和每个分支点的 ‹ 1/2 ›，这里一次算好，
        // 省得把整棵树丢给浏览器再让它自己走一遍。
        const path = pathOf(s);
        const branches = {};
        for (const n of path) {
          const sibs = siblingsOf(s, n);
          if (sibs.length > 1) {
            branches[n.id] = {
              index: sibs.findIndex((x) => x.id === n.id) + 1,
              count: sibs.length,
              ids: sibs.map((x) => x.id),
            };
          }
        }
        return json(res, 200, {
          session: {
            id: s.id,
            title: s.title,
            model: s.model,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            leafId: s.leafId || null,
            messages: path.map((n) => ({
              id: n.id,
              parentId: n.parentId || null,
              role: n.role,
              content: n.content,
              reasoning: n.reasoning,
              tools: n.tools,
              model: n.model,
              files: n.files,
              annotations: n.annotations,
            })),
            branches,
          },
        });
      }

      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        // leafId 支持三种写法：具体节点 → 切分支；'prev'/'next' 配合 leafIdFrom 走兄弟节点
        if (body.leafId === 'prev' || body.leafId === 'next') {
          const from = body.leafIdFrom ? findNode(s, String(body.leafIdFrom)) : null;
          if (!from) throw new UserError('找不到要切换的消息', 400);
          const sibs = siblingsOf(s, from);
          const i = sibs.findIndex((x) => x.id === from.id);
          const next = sibs[body.leafId === 'prev' ? i - 1 : i + 1];
          if (next) setLeaf(id, deepestLeaf(s, next.id));
        } else {
          updateSession(id, body);
        }
        const fresh = getSession(id);
        return json(res, 200, {
          session: {
            id: fresh.id,
            title: fresh.title,
            model: fresh.model,
            updatedAt: fresh.updatedAt,
            leafId: fresh.leafId || null,
          },
        });
      }

      if (method === 'DELETE') {
        deleteSession(id);
        return json(res, 200, { ok: true });
      }
    }

    /* ---------- 核心：流式聊天 ---------- */
    if (pathname === '/api/chat' && method === 'POST') {
      // 聊天体可能带图片 base64（前端已压到 ~1MB，最多若干张），给 24MB 上限
      const body = await readJsonBody(req, 24 * 1024 * 1024);
      const cfg = getConfig();

      const model = MODELS.includes(body.model) ? body.model : MODELS[0];
      // message 只接受字符串。以前用 String(body.message) 兜底，
      // 结果传对象会被转成 "[object Object]" 照常发出去，还顺手建了个空会话。
      if (body.message !== undefined && body.message !== null && typeof body.message !== 'string') {
        throw new UserError('message 必须是字符串', 400);
      }
      const text = (body.message || '').trim();
      const sessionId = String(body.sessionId || '');

      const hasFiles = Array.isArray(body.files) && body.files.length > 0;
      if (!text && !body.regenFrom && !hasFiles) throw new UserError('消息不能为空', 400);
      if (text.length > 32000) throw new UserError('单条消息太长了（上限 32000 字符）', 400);

      // 先校验密钥，避免开出空会话、也避免先发 SSE 头再报错
      if (!cfg.apiKey) {
        throw new UserError(
          '还没有配置 DeepSeek API Key。点左下角「设置」填入以 sk- 开头的密钥即可开始聊天。',
          400
        );
      }

      // v4-pro 不支持官方联网工具：切到它时前端要提示，避免用户以为还在联网
      const toolsOff = !supportsServerTools(model);

      let session = sessionId ? getSession(sessionId) : null;
      // 带了个不存在的 sessionId（比如换了浏览器/清了数据）：直接开新会话，
      // 不要去撞 parentId 校验，否则用户会卡在 409 上没法说话。
      const resumed = !!session;
      if (!session) session = createSession({ model });
      if (session.model !== model) updateSession(session.id, { model });

      // 接在哪条消息下面：编辑旧提问时前端会传被编辑提问的父节点，
      // 这样新提问是「同一父节点的另一个分支」，旧问答仍保留在树里。
      // 注意：编辑第一句时前端传的是 parentId: null（挂根），
      // 必须用 'in' 判断「有没有这个字段」，不能用真假值判断。
      const parentId = resumed
        ? 'parentId' in body
          ? body.parentId
            ? String(body.parentId)
            : null
          : session.leafId || null
        : null;
      // 前端传来的分支锚点必须真实存在：否则 addNode 会把它降级成「挂到根」，
      // 用户的当前对话会突然只剩这一条新消息，看起来像丢历史。
      if (resumed && parentId && !findNode(session, parentId)) {
        throw new UserError('对话锚点已失效，请刷新页面后重试', 409);
      }

      // 重新生成：不新增提问，直接给同一个提问再答一次。
      // 新回答挂在同一提问下，旧回答自动成为可切换的另一版。
      const regenFrom = body.regenFrom ? findNode(session, String(body.regenFrom)) : null;
      if (body.regenFrom && !regenFrom) throw new UserError('要重新生成的那条提问不存在', 400);
      if (regenFrom && regenFrom.role !== 'user') throw new UserError('只能对着提问重新生成', 400);

      // 客户端可以覆盖本轮联网开关：只影响这一次请求，
      // 不再写回全局配置——否则另一台设备/另一个标签页的偏好会被悄悄改掉。
      if (typeof body.useSearch === 'boolean') {
        cfg.webSearch = body.useSearch;
      }
      // 深度思考同样可以按轮覆盖（输入框上的开关），不写回全局配置
      if (typeof body.thinking === 'boolean') {
        cfg.thinking = body.thinking;
      }

      /* SSE 头：注意必须立刻 flush，且关闭代理缓冲 */
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');

      const send = (payload) => {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      // 客户端断开后往已销毁的 socket 写会抛 ERR_STREAM_DESTROYED，
      // 这类事件失败不该影响落库，统一吞掉。
      const trySend = (payload) => {
        try {
          send(payload);
        } catch {
          /* 客户端已断开 */
        }
      };

      // 心跳，防止中间层掐断
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, 15000);

      // 注意：req 的 'close' 在响应正常结束后也会触发，
      // 所以要同时看 res.writableEnded，避免把「正常收尾」误判成「用户中断」。
      const abort = new AbortController();
      req.on('close', () => {
        clearInterval(heartbeat);
        if (!res.writableEnded) abort.abort();
      });

      send({ type: 'session', sessionId: session.id, model });
      if (toolsOff && (cfg.webSearch || cfg.readUrl)) {
        send({ type: 'notice', text: 'V4 Pro 不支持联网工具，这条回答不会搜索网页' });
      }

      // 先把提问落库，前端就能拿到 id 作为分支锚点
      // 重新生成时沿用原提问节点，不再新增
      // 附件元数据：name/fileId 是必须的；image 是图片的 data URL，只用于本轮请求。
      // 不限制大小会把「一张手机照片」原样写进 sessions.json，还会在后续每一轮
      // 都被重新塞回请求体——文件会越滚越大，因此这里做两道闸。
      const MAX_INLINE_IMAGE = 1_200_000; // 约 0.9MB 原始字节
      const files = (Array.isArray(body.files) ? body.files.slice(0, 20) : [])
        .filter((f) => f && typeof f === 'object')
        .map((f) => {
          const out = { name: String(f.name || 'file').slice(0, 180) };
          if (f.fileId) out.fileId = String(f.fileId);
          if (f.purpose) out.purpose = String(f.purpose);
          if (typeof f.image === 'string' && f.image.startsWith('data:image/')) {
            if (f.image.length <= MAX_INLINE_IMAGE) out.image = f.image;
            else out.imageDropped = true;
          }
          return out;
        });
      // 落盘版附件：剥掉图片 base64（体积大、且后续轮次用 file_id 引用即可），
      // 但保持「有附件」这个事实，刷新后仍能看到附件条。
      const filesForStore = files.map((f) => {
        if (!f.image) return f;
        const { image, ...rest } = f;
        return { ...rest, imageDropped: true };
      });
      const userNode =
        regenFrom ||
        addNode(session.id, {
          parentId,
          role: 'user',
          content: text,
          files: filesForStore.length ? filesForStore : undefined,
        });
      if (!regenFrom) send({ type: 'user', id: userNode?.id || null, parentId: userNode?.parentId || null });
      else send({ type: 'user', id: userNode.id, parentId: userNode.parentId || null });

      const messages = toApiMessages(session, cfg.systemPrompt, userNode.parentId || null);
      // 本轮提问带上图片 base64（只在这一次请求里），历史轮次靠 file_id
      messages.push({
        role: 'user',
        content: regenFrom ? userContent(userNode.content, userNode.files) : userContent(text, files),
      });

      let content = '';
      let reasoning = '';
      const toolLog = [];   // 前端工具卡的持久化摘要
      let annotations = null;
      let serverCalls = null;
      let streamError = null;

      let generatedTitle = '';
      const isFirstAnswer = !(getSession(session.id)?.nodes || []).some((n) => n.role === 'assistant');

      try {
        const result = await runChat({
          messages,
          model,
          cfg,                       // 带上本轮覆盖过的配置（useSearch 等）
          signal: abort.signal,
          emit: (evt) => {
            if (evt.type === 'content') {
              content += evt.text;
              send({ type: 'content', text: evt.text });
            } else if (evt.type === 'reasoning') {
              reasoning += evt.text;
              send({ type: 'reasoning', text: evt.text });
            } else if (evt.type === 'annotations') {
              annotations = evt.list;
              send({ type: 'annotations', list: evt.list });
            }
            else if (evt.type === 'done') {
              if (evt.serverCalls) serverCalls = evt.serverCalls;
              if (evt.annotations) annotations = evt.annotations;
              if (evt.title) generatedTitle = evt.title;
            } else if (evt.type === 'tool_start') {
              // 官方的 call_started 只带 action，转成前端认识的结构
              const t = describeCall(evt.call);
              const item = {
                key: `${evt.step}:${evt.call?.index ?? 0}`,
                tool: t.tool,
                label: t.label,
                status: 'running',
                ts: Date.now(),
              };
              toolLog.push(item);
              send({ type: 'tool_start', key: item.key, tool: t.tool, label: t.label });
            } else if (evt.type === 'tool_result') {
              const key = `${evt.step}:${evt.call?.index ?? 0}`;
              const item = toolLog.find((x) => x.key === key) || toolLog[toolLog.length - 1];
              const ok = evt.call?.status !== 'failed';
              const payload = {
                type: 'tool_result',
                key,
                ok,
                ms: item ? Date.now() - item.ts : 0,
                items: (evt.call?.sources || []).slice(0, 6).map((x) => ({
                  title: x.title,
                  url: x.url,
                  snippet: x.snippet,
                })),
                page: evt.call?.page
                  ? {
                      url: evt.call.page.url,
                      title: evt.call.page.title,
                      // 官方不同版本给过 chars / length / content 三种字段，
                      // 都没有就退到正文长度，实在没有才写 0
                      chars:
                        evt.call.page.chars ??
                        evt.call.page.length ??
                        (typeof evt.call.page.content === 'string'
                          ? evt.call.page.content.length
                          : 0),
                      truncated: !!evt.call.page.truncated,
                    }
                  : undefined,
                error: evt.call?.error?.code,
              };
              if (item) {
                item.status = ok ? 'ok' : 'fail';
                item.ms = payload.ms;
                if (payload.items.length) item.items = payload.items;
                if (payload.page) item.page = payload.page;
                if (payload.error) item.error = payload.error;
              }
              send(payload);
            } else if (evt.type !== 'done') {
              send(evt);
            }
          },
        });
        trySend({ type: 'done', usage: result.usage, finishReason: result.finishReason });
      } catch (err) {
        streamError = err;
        trySend({
          type: 'error',
          message: err.message || '未知错误',
          aborted: !!err.aborted,
        });
      } finally {
        clearInterval(heartbeat);
      }

      // 助手回答挂到刚才那条提问下面，并把「当前分支」移到新回答。
      // 注意：setLeaf 必须在 send 之前完成——客户端中途断开时 send 会抛，
      // 一旦跳过 setLeaf，会话就会停在「有节点但 leafId 为空」的坏状态，
      // 前端刷新后拿到的就是一份空对话。
      // 用户中途点「停止」时 content 里已经有部分文字，也要落库，
      // 否则刷新后这段回答凭空消失（aborted 只表示没说完）。
      const abortedWithText = !!streamError?.aborted && content.trim().length > 0;
      if ((!streamError || abortedWithText) && content.trim() && userNode) {
        const assistantNode = addNode(session.id, {
          parentId: userNode.id,   // 重新生成时 userNode 就是原来那条提问
          role: 'assistant',
          content,
          reasoning: reasoning || undefined,
          model,
          annotations: annotations || undefined,
          serverCalls: serverCalls || undefined,
          tools: toolLog.length
            ? toolLog.map((t) => ({
                tool: t.tool,
                label: t.label,
                status: t.status,
                items: t.items,
                page: t.page,
                error: t.error,
                ms: t.ms,
              }))
            : undefined,
        });
        setLeaf(session.id, assistantNode?.id || userNode.id);
        if (generatedTitle && isFirstAnswer) {
          updateSession(session.id, { title: generatedTitle });
        }
        trySend({ type: 'end', assistantId: assistantNode?.id || null });
        trySend({ type: 'title', title: getSession(session.id)?.title || '新对话' });
      } else {
        // 中止/失败：提问已经落库了，分支停在这条提问上，重试时可以复用它
        if (userNode) setLeaf(session.id, userNode.id);
        trySend({ type: 'end', assistantId: null });
      }

      return res.end();
    }

    if (pathname === '/api/health') {
      const cfg = getConfig();
      return json(res, 200, {
        ok: true,
        hasKey: !!cfg.apiKey,
        webSearch: cfg.webSearch,
        node: process.version,
      });
    }

    /* ---------- 静态文件 ---------- */
    if (method === 'GET' || method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }

    res.writeHead(405).end('Method Not Allowed');
  } catch (err) {
    if (res.headersSent) {
      // SSE 已经开始，只能补一个错误事件再收尾
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
        res.write('data: {"type":"end"}\n\n');
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    const status = err.isUserError ? err.status || 400 : 500;
    if (!err.isUserError) console.error('[server]', err);
    json(res, status, { error: err.message || '服务器内部错误' });
  }
});

/* 退出前把防抖中的会话写盘，避免最后 200ms 的改动丢失 */
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    flush();
  } catch {
    /* 尽力而为 */
  }
  console.log(`\n[server] 收到 ${sig}，会话已落盘，退出`);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  const cfg = getConfig();
  console.log(`\n  🐋 DeepSeek 聊天机器人已启动`);
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log(`  ➜  API Key: ${cfg.apiKey ? '已配置' : '未配置（打开页面后点右上角「设置」填写）'}`);
  console.log(`  ➜  联网搜索: ${cfg.webSearch ? '开启' : '关闭'}\n`);
});

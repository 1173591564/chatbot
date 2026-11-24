/**
 * 假的 DeepSeek 全家桶 API，仅用于本地回归。
 *
 * 模拟的东西（按官方 web_tools / document_parsing 文档的形态）：
 *   POST /files            上传 → {id, object:'file'}（proxy 会再包一层）
 *   POST /chat/completions 流式：
 *     - choice.server_tool_event: call_started / call_completed / step_reasoning_done
 *     - 正文 + reasoning_content 分块
 *     - 末帧 delta.server_tool_calls / delta.annotations（全量一次性给）
 *     - finish_reason
 *
 * 用环境变量 MOCK_MODE 控制场景：
 *   tools   （默认）搜索 + 读页面，然后带角标的正文
 *   text    纯文本，不调工具（用来测非联网问答 / v4-pro）
 *   slow    慢慢吐字，用来测中止
 *   error   400 报错，用来测错误提示
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT || 3999);
const MODE = process.env.MOCK_MODE || 'tools';

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const files = new Map();

function chunk(res, model, delta, finish = null) {
  sse(res, {
    id: 'mock',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
}

function usage(res, extra = {}) {
  return {
    prompt_tokens: 1320,
    completion_tokens: 486,
    total_tokens: 1806,
    prompt_cache_hit_tokens: 1024,
    reasoning_tokens: 210,
    server_tool_use: { tool_search: 1, tool_fetch: 1, tool_image_search: 0 },
    ...extra,
  };
}

/* 正文里放两处引用，end_index 用「码点」计算，这里全 ASCII 便于核对 */
const ANSWER_HEAD = 'DeepSeek 在 11 月更新了全家桶 API，联网搜索改由服务端直接执行。';
const ANSWER_TAIL = '官方文档同时说明，声明了 tools 时不能再传 web_search_options。';

const ANSWER = `## 结论\n\n${ANSWER_HEAD}\n\n${ANSWER_TAIL}\n\n| 项 | 说明 |\n| --- | --- |\n| 搜索 | \`deepseek_web_search\` |\n| 读取 | \`deepseek_read_url\` |\n\n- 全量 \`server_tool_calls\` 只在末帧给一次\n- 角标区间按码点计算\n`;

// 角标区间：第一处在 ANSWER_HEAD 末尾，第二处在 ANSWER_TAIL 的「官方文档」后面
const CP_HEAD_END = ANSWER.indexOf(ANSWER_HEAD) + Array.from(ANSWER_HEAD).length;
const CP_TAIL_END =
  ANSWER.indexOf(ANSWER_TAIL) + Array.from('官方文档同时说明').length;

const SERVER_CALLS = [
  {
    index: 0,
    reasoning_content: '用户问的是最新变化，先搜一下。',
    calls: [
      {
        index: 0,
        kind: 'web_search',
        status: 'completed',
        action: { type: 'search', queries: ['DeepSeek 全家桶 API'] },
        sources: [
          {
            title: 'DeepSeek 官方文档 · 联网搜索',
            url: 'https://api-docs.deepseek.com/zh-cn/guides/web_tools/',
            snippet: '联网搜索工具由服务端执行，模型无需返回工具调用。',
            site_name: 'api-docs.deepseek.com',
            page_age: '2026-11-13',
          },
          {
            title: 'API 更新日志',
            url: 'https://api-docs.deepseek.com/zh-cn/updates/',
            snippet: '2026-11-13 发布全家桶应用 API。',
            site_name: 'api-docs.deepseek.com',
          },
        ],
        signature: 'sig-search-1',
      },
      {
        index: 1,
        kind: 'web_fetch',
        status: 'completed',
        action: { type: 'open_page', url: 'https://api-docs.deepseek.com/zh-cn/guides/web_tools/' },
        page: {
          url: 'https://api-docs.deepseek.com/zh-cn/guides/web_tools/',
          title: '联网搜索',
        },
        signature: 'sig-fetch-1',
      },
    ],
  },
];

const ANNOTATIONS = [
  {
    type: 'url_citation',
    url_citation: {
      url: 'https://api-docs.deepseek.com/zh-cn/guides/web_tools/',
      title: 'DeepSeek 官方文档 · 联网搜索',
      start_index: 0,
      end_index: CP_HEAD_END,
    },
  },
  {
    type: 'url_citation',
    url_citation: {
      url: 'https://api-docs.deepseek.com/zh-cn/updates/',
      title: 'API 更新日志',
      start_index: 0,
      end_index: CP_TAIL_END,
    },
  },
];

const server = http.createServer(async (req, res) => {
  /* ---------- /files ---------- */
  if (req.url.startsWith('/files') && req.method === 'POST') {
    const buf = [];
    for await (const c of req) buf.push(c);
    const raw = Buffer.concat(buf);
    // 不真的解析 multipart，只把它当成「有字节就成功」
    if (!raw.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'empty body' } }));
    }
    const id = `file-${crypto.randomBytes(6).toString('hex')}`;
    files.set(id, raw.length);
    // 从 multipart 里抠出 filename 与 purpose，既能回显也能断言顺序
    const text = raw.toString('latin1');
    const fnm = /name="file"; filename="([^"]*)"/.exec(text);
    const pidx = text.indexOf('name="purpose"');
    const fidx = text.indexOf('name="file"');
    const purpose = pidx >= 0 ? /purpose"\r?\n\r?\n([^\r]*)/.exec(text)?.[1] : null;
    if (pidx >= 0 && fidx >= 0 && pidx > fidx) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'purpose 必须在 file 之前' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        id,
        object: 'file',
        bytes: raw.length,
        filename: fnm ? Buffer.from(fnm[1], 'latin1').toString('utf8') : 'mock',
        purpose: purpose || 'text_recognition',
      })
    );
  }
  if (req.url.startsWith('/files/') && req.method === 'GET') {
    const id = req.url.split('/')[2];
    if (!files.has(id)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'not found' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id, object: 'file', bytes: files.get(id) }));
  }
  if (req.url.startsWith('/files/') && req.method === 'DELETE') {
    const id = req.url.split('/')[2];
    files.delete(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id, object: 'file', deleted: true }));
  }

  if (req.url === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] })
    );
  }

  if (!req.url.startsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }

  let body = '';
  for await (const c of req) body += c;
  let parsed = {};
  try {
    parsed = JSON.parse(body);
  } catch {}
  const model = parsed.model || 'deepseek-flash';
  const msgs = parsed.messages || [];

  if (MODE === 'error') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({ error: { message: 'mock 400：模型不存在或参数非法', type: 'invalid_request_error' } })
    );
  }

  // 参数校验：声明了 tools 时禁止 web_search_options；assistant 历史必须回传 signature
  const bad = [];
  if (parsed.tools && parsed.web_search_options) bad.push('tools + web_search_options 不能同时出现');
  const assistantWithCalls = msgs.filter((m) => m.role === 'assistant' && m.server_tool_calls);
  for (const m of assistantWithCalls) {
    for (const step of m.server_tool_calls || []) {
      for (const call of step.calls || []) if (!call.signature) bad.push('回传缺少 signature');
    }
  }
  if (bad.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: `mock 校验失败：${bad[0]}` } }));
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const wantTools = MODE === 'tools' && Array.isArray(parsed.tools) && parsed.tools.length > 0;
  const hasFile = msgs.some(
    (m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'file' || p.type === 'image_url')
  );
  const hasToolHistory = msgs.some((m) => m.role === 'assistant' && m.server_tool_calls);

  /* ---------- 纯文本 ---------- */
  if (!wantTools) {
    const text = hasFile ? '我读了你传的文件，主要内容如下：\n\n- 第一点是…\n' : ANSWER;
    for (const t of text.match(/[\s\S]{1,12}/g) || []) {
      chunk(res, model, { content: t });
      if (MODE === 'slow') await sleep(120);
      else await sleep(12);
    }
    chunk(res, model, {}, 'stop');
    sse(res, { id: 'mock', object: 'chat.completion.chunk', model, choices: [], usage: usage(res) });
    return res.end('data: [DONE]\n\n');
  }

  /* ---------- 带官方工具的流程 ---------- */
  // 第二次进来（历史里已经有 server_tool_calls）就只出正文，避免无限循环
  if (!hasToolHistory) {
    for (const t of ['用户问的是', '最新变化，', '我需要', '联网确认一下。']) {
      chunk(res, model, { reasoning_content: t });
      await sleep(40);
    }
    // 注意：官方真实行为是「工具跑完才出正文」，这里保持一致，
    // 否则本地测出来的排版顺序跟线上不同。

    const step = SERVER_CALLS[0];
    // call_started：只带 action
    sse(res, {
      id: 'mock',
      object: 'chat.completion.chunk',
      model,
      choices: [
        {
          index: 0,
          delta: {},
          server_tool_event: {
            type: 'call_started',
            step: 0,
            call: { index: 0, kind: 'web_search', action: { type: 'search', queries: ['DeepSeek 全家桶 API'] } },
          },
        },
      ],
    });
    await sleep(180);
    sse(res, {
      id: 'mock',
      object: 'chat.completion.chunk',
      model,
      choices: [
        {
          index: 0,
          delta: {},
          server_tool_event: {
            type: 'call_completed',
            step: 0,
            call: step.calls[0],
          },
        },
      ],
    });
    await sleep(60);

    sse(res, {
      id: 'mock',
      object: 'chat.completion.chunk',
      model,
      choices: [
        {
          index: 0,
          delta: {},
          server_tool_event: {
            type: 'call_started',
            step: 0,
            call: {
              index: 1,
              kind: 'web_fetch',
              action: { type: 'open_page', url: 'https://api-docs.deepseek.com/zh-cn/guides/web_tools/' },
            },
          },
        },
      ],
    });
    await sleep(150);
    sse(res, {
      id: 'mock',
      object: 'chat.completion.chunk',
      model,
      choices: [
        {
          index: 0,
          delta: {},
          server_tool_event: { type: 'call_completed', step: 0, call: step.calls[1] },
        },
      ],
    });
    sse(res, {
      id: 'mock',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: {}, server_tool_event: { type: 'step_reasoning_done', step: 0 } }],
    });
    await sleep(40);
  }

  // 正文分块
  for (const t of ANSWER.match(/[\s\S]{1,10}/g) || []) {
    chunk(res, model, { content: t });
    await sleep(10);
  }

  // 末帧：全量 server_tool_calls + annotations 一次性给
  chunk(
    res,
    model,
    {
      content: '',
      ...(hasToolHistory ? {} : { server_tool_calls: SERVER_CALLS }),
      annotations: ANNOTATIONS,
    },
    'stop'
  );
  sse(res, {
    id: 'mock',
    object: 'chat.completion.chunk',
    model,
    choices: [],
    usage: usage(res),
  });
  res.end('data: [DONE]\n\n');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] listening on http://127.0.0.1:${PORT}  mode=${MODE}`);
});

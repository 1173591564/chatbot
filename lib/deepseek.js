/**
 * DeepSeek 流式对话 —— 官方「全家桶」直通。
 *
 * 和上一版的区别：
 *   旧版：后端自己写爬虫（Bing/Tavily/…）+ 自研 function calling 循环，
 *         用的是 deepseek-chat / deepseek-reasoner（2026-07-24 已被官方停用）。
 *   新版：联网搜索 / 阅读链接交给官方服务端工具，后端只做转发和事件整理：
 *         tools: [{type:"deepseek_web_search"}, {type:"deepseek_read_url"}]
 *
 * 官方约定（见 web_tools 文档）：
 *   - 工具调用过程在 choice.server_tool_event 里：call_started / call_completed / step_reasoning_done
 *   - 完整的 server_tool_calls 与 annotations 只在带 finish_reason 的最后一个 chunk 的 delta 中给一次
 *   - annotations 元素形如 {type:"url_citation", url_citation:{url,title,start_index,end_index}}
 */

import { getConfig } from './config.js';

const REQUEST_TIMEOUT_MS = 300000; // 深度搜索会连着调很多次工具，给足时间

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.isUserError = true;
  }
}

/** 联网工具与文件解析都只支持 deepseek-flash */
export const MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
export function supportsServerTools(model) {
  return model === 'deepseek-flash';
}

function endpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

/** 构造请求体：把设置翻译成官方参数 */
export function buildBody({ messages, model, signal: _signal, cfg }) {
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  // 思考模式：新版是独立开关，不再靠模型名暗示
  if (cfg.thinking) body.thinking = { type: 'enabled' };
  if (cfg.safety) body.safety_check = { level: 'high' };
  if (cfg.title) body.title = { enabled: true };

  if (supportsServerTools(model)) {
    const tools = [];
    if (cfg.webSearch !== false) tools.push({ type: 'deepseek_web_search' });
    if (cfg.readUrl !== false) tools.push({ type: 'deepseek_read_url' });
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
  }
  return body;
}

/**
 * 发一次流式请求，边收边把事件抛给上层。
 * 不做任何工具循环——服务端已经把搜索/抓取/拼上下文全做完了。
 *
 * emit 出去的事件：
 *   {type:'reasoning', text}
 *   {type:'content', text}
 *   {type:'tool_start',   id, step, call}                    模型开始搜索/读网页
 *   {type:'tool_result',  id, step, call}                    调用结束（含 sources/page/error）
 *   {type:'step_done',    step}
 *   {type:'annotations',  list}                              引用来源
 *   {type:'done', usage, finishReason, serverCalls, annotations}
 */
export async function runChat({ messages, model = 'deepseek-flash', signal, emit, cfg: cfgIn }) {
  // cfg 可以由调用方传入（本轮已按请求覆盖过），没传才回落到全局配置
  const cfg = cfgIn || getConfig();
  if (!cfg.apiKey) {
    throw new UserError('还没有配置 DeepSeek API Key。点左下角「设置」填入以 sk- 开头的密钥即可开始聊天。', 400);
  }

  const body = buildBody({ messages, model, cfg });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let res;
  try {
    res = await fetch(endpoint(cfg.baseUrl), {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (err.name === 'AbortError') {
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { aborted: true });
      throw new UserError(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`, 504);
    }
    throw new UserError(`无法连接 DeepSeek：${err.message}`, 502);
  }

  if (!res.ok) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    const raw = await res.text().catch(() => '');
    let detail = raw.slice(0, 600);
    try {
      const j = JSON.parse(raw);
      detail = j.error?.message || j.message || detail;
    } catch {
      /* 保留原样 */
    }
    const hint =
      res.status === 401
        ? 'API Key 无效或未填写，请在左下角「设置」里更新。'
        : res.status === 402
          ? '账户余额不足，请到 DeepSeek 平台充值。'
          : res.status === 429
            ? '请求过于频繁，稍后再试。'
            : res.status === 400 && /model/i.test(detail)
              ? '模型名可能不对：请用 deepseek-flash 或 deepseek-v4-pro。'
              : '';
    throw new UserError(
      `DeepSeek 返回 ${res.status}${detail ? `：${detail}` : ''}${hint ? `\n${hint}` : ''}`,
      res.status
    );
  }

  let content = '';
  let reasoning = '';
  let finishReason = '';
  let usage = null;
  let serverCalls = null;
  let annotations = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consume = (chunk) => {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];

    // 工具事件是和 delta 并列的字段，优先处理
    const ev = choice?.server_tool_event || chunk.server_tool_event;
    if (ev) {
      if (ev.type === 'call_started') {
        emit({ type: 'tool_start', step: ev.step ?? 0, call: ev.call || {} });
      } else if (ev.type === 'call_completed') {
        emit({ type: 'tool_result', step: ev.step ?? 0, call: ev.call || {} });
      } else if (ev.type === 'step_reasoning_done') {
        emit({ type: 'step_done', step: ev.step ?? 0 });
      }
      return;
    }

    if (!choice) return;
    const delta = choice.delta || {};

    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      emit({ type: 'reasoning', text: delta.reasoning_content });
    }
    if (delta.content) {
      content += delta.content;
      emit({ type: 'content', text: delta.content });
    }

    // 完整结构只在带 finish_reason 的最后一帧出现一次
    if (delta.server_tool_calls) serverCalls = delta.server_tool_calls;
    if (delta.annotations) {
      annotations = delta.annotations;
      emit({ type: 'annotations', list: annotations });
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
      if (choice.finish_reason === 'content_filter') {
        emit({ type: 'notice', text: '内容被安全策略拦截，仅供参考' });
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        consume(chunk);
      }
    }
    // 尾包可能没有换行
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          consume(JSON.parse(payload));
        } catch {
          /* 忽略半截帧 */
        }
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  emit({ type: 'done', usage, finishReason, serverCalls, annotations });
  return { content, reasoning, usage, finishReason, serverCalls, annotations };
}

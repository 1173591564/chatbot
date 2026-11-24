import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/* ---------- .env 解析（零依赖） ---------- */
export function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnv();

/* ---------- 运行时配置（UI 里填写后落盘） ---------- */
const defaults = {
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  webSearch: true,
  readUrl: true,
  thinking: false,
  safety: false,
  title: true,
  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    [
      '你是 DeepSeek 助手，一个可靠、直接、乐于助人的 AI。',
      '',
      '工作方式：',
      '- 回答时效性强、或你不确定的事实性问题时，先用联网搜索查证；需要细节时再打开具体网页。',
      '- 搜索结果只是素材，要自己组织语言回答，不要整段照抄。',
      '- 引用网页内容时，系统会自动标注来源编号，你不需要另外贴链接。',
      '- 不确定就明说，不要编造来源、链接或数据。',
      '- 默认用中文回答（用户用其他语言提问就跟随该语言）。',
      '- 代码用带语言标注的 Markdown 代码块；适合时用列表、表格让答案更易读。',
      '- 保持简洁：能三句话说清就不要写三段。',
    ].join('\n'),
};

let current = { ...defaults };
let persisted = {};

try {
  if (fs.existsSync(CONFIG_FILE)) {
    persisted = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    current = { ...current, ...pick(persisted) };
  }
} catch {
  /* 配置损坏时忽略，使用默认值 */
}

function pick(obj) {
  const out = {};
  for (const k of ['apiKey', 'baseUrl', 'webSearch', 'readUrl', 'thinking', 'safety', 'title', 'systemPrompt']) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
  }
  return out;
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(pick(current), null, 2));
  } catch (err) {
    console.warn('[config] 写入失败：', err.message);
  }
}

export function getConfig() {
  return current;
}

export function setConfig(patch = {}) {
  if (typeof patch.apiKey === 'string') {
    current.apiKey = patch.apiKey.trim();
  }
  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) {
    // 允许填 https://api.deepseek.com 或 .../v1，统一去掉尾部斜杠。
    // 只收 http/https：baseUrl 会被服务端带着 API Key 去请求，
    // 放开 file:// / gopher:// 之类等于给了一个任意协议请求面。
    const u = patch.baseUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/i.test(u)) {
      throw Object.assign(new Error('接口地址必须是 http(s):// 开头'), {
        status: 400,
        isUserError: true,
      });
    }
    current.baseUrl = u;
  }
  if (typeof patch.webSearch === 'boolean') current.webSearch = patch.webSearch;
  if (typeof patch.readUrl === 'boolean') current.readUrl = patch.readUrl;
  if (typeof patch.thinking === 'boolean') current.thinking = patch.thinking;
  if (typeof patch.safety === 'boolean') current.safety = patch.safety;
  if (typeof patch.title === 'boolean') current.title = patch.title;
  // 允许清空：留空表示「不要系统提示词」。以前这里判了 trim() 非空，
  // 用户把内容全删掉点保存，看到的却是旧提示词还在。
  if (typeof patch.systemPrompt === 'string') {
    current.systemPrompt = patch.systemPrompt;
  }
  persist();
  return publicConfig();
}

/** 给前端看的配置：密钥做了掩码，绝不外泄原文 */
export function publicConfig() {
  const key = current.apiKey || '';
  return {
    hasKey: key.length > 4,
    keyHint: key ? `${key.slice(0, 3)}••••${key.slice(-4)}` : '',
    baseUrl: current.baseUrl,
    webSearch: current.webSearch,
    readUrl: current.readUrl,
    thinking: current.thinking,
    safety: current.safety,
    title: current.title,
    systemPrompt: current.systemPrompt,
  };
}

export const paths = { ROOT, DATA_DIR, CONFIG_FILE };

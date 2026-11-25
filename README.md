# 🐋 DeepSeek 聊天机器人

带**联网搜索**、**阅读链接**、**文件解析**的 DeepSeek 聊天界面。零第三方依赖（Node 20+ 原生实现），单进程跑起来就能用。

```
node server.js      # 然后打开 http://localhost:3000
```

> 本项目现在完全走 **DeepSeek 官方「全家桶」API**：搜索、抓网页、解析文件都由 `api.deepseek.com`
> 服务端完成，本地不再跑爬虫，也不再自己实现 function calling 循环。用的是官方模型名
> `deepseek-flash` / `deepseek-v4-pro`（旧的 `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用）。

---

## 功能

**聊天**
- DeepSeek 流式输出（SSE），逐字显示
- 双模型切换：`deepseek-flash`（快，支持联网 / 文件 / 图片）/ `deepseek-v4-pro`（复杂推理，不支持联网工具）
- **思考过程**独立成可折叠卡片实时展示（设置里开「深度思考」）
- Markdown 渲染：标题、列表、表格、引用、代码块 + 语法高亮 + 一键复制
- **数学公式**：Temml（LaTeX→MathML）渲染，支持 `$…$` `\(...\)` 行内、`$$…$$` `\[...\]` 块级（含多行），解析失败回退显示原文；货币写法 `$5 和 $10` 不会误判
- 多轮上下文，会话自动命名、本地持久化，可新建 / 切换 / 删除
- 停止生成（保留已生成内容）、重新生成、token 用量统计
- **编辑历史提问**：任意一轮的提问都能改，改完作为新版本，旧问答原样保留
- **分支切换**：同一位置的多个版本用 `‹ 1/2 ›` 左右翻页，重新生成也走这套（一个提问多个回答）
- 深浅色自适应（纸 / 墨两套）
- 每次请求自动注入当前日期，「今天 / 最新」类问题不会再瞎编

**官方工具（服务端执行，模型自主决定何时用）**
- `deepseek_web_search` —— 联网搜索，结果以卡片展示（标题 / 链接 / 摘要），可点开
- `deepseek_read_url` —— 打开网页读正文；也支持在页面内查找
- **引用角标**：`annotations` 里的 `url_citation` 会渲染成正文里的上标编号 `1`、`2`，
  点击跳转，回答末尾附来源列表（去重）
- 工具调用过程实时可视化：调用中 → 成功 / 失败 + 耗时
- 顶部「联网」开关可随时关闭

**文件与图片**
- 点输入框左侧 `＋`、拖拽文件到输入框、或直接粘贴，都能添加附件
- 自动选 `purpose`：纯文本 / 表格 / 电子书 → `user_data`（不计费）；PDF / Office → `rich_layout_recognition`；图片 → `text_recognition`
- 只发附件不写字也能发（自动补一句「请看看这些内容。」）
- 图片额外走 `image_url` 保住原图，其余文件走 `{type:'file', file_id}`

---

## 快速开始

### 1. 环境

Node.js **20 或以上**（用到原生 `fetch`、`FormData`、`AbortController`，无需 `npm install`）。

### 2. 填 API Key

两种方式，任选其一：

**A. 页面里填**（最省事）
启动后打开页面 → 左下角「设置」→ 粘贴 `sk-…` → 保存。Key 会写到 `data/config.json`（该目录已被 git 忽略）。

**B. 环境变量**
```bash
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY=sk-xxxx
```

### 3. 启动

```bash
node server.js
# 或
npm start
```

打开 <http://localhost:3000>。

---

## 计费须知

官方工具按调用次数计费，**搜索 / 抓取各 5 元 / 1000 次**（下文为 2026-11 的公开价，若有调整以官网为准）。
旧版本用自研爬虫是免费的，现在换成了官方工具，这部分会产生费用。
不想花钱就把设置里的「联网搜索」「阅读链接」关掉，模型只用自身知识回答。

文件解析：纯文本 / 表格 / 电子书走 `user_data`，官方标注**不计费**；PDF / Office 走版面识别，占用 token 额度。

---

## 项目结构

```
server.js               HTTP 服务：REST + SSE 流式接口 + /api/files 上传代理 + 静态文件
lib/
  config.js             API Key / 系统提示词 / 各功能开关（.env + data/config.json）
  deepseek.js           流式请求 + 官方工具事件解析（server_tool_event / annotations）
  sessions.js           会话持久化（data/sessions.json，消息树 + 分支）+ 日期注入
public/                 网页前端（index.html / style.css / app.js / temml.js）
android-app/            安卓 WebView 壳（assets/www/ 与网页版同一套 UI）
  app/src/main/assets/www/   前端（md.js 独立渲染器 + temml.js）
  app/src/main/java/.../     MainActivity（安全区/键盘避让/开屏动画/WebView 调试）
scripts/                Windows 桌面启动器
  start-web.ps1         幂等启动：3000 未监听才拉 node server.js，然后开浏览器
  launcher.exe          无窗口入口（图标内嵌），快捷方式直接指它
  make-shortcut.ps1     重建「DeepSeek Chat」桌面快捷方式
  make-icon.ps1         重新生成 pelican.ico（16/32/48/64 DIB）
tests/
  mock-deepseek.mjs     假 DeepSeek 全家桶服务（含 /files），用于无 key 时验证全链路
```

> 已删除：`lib/tools.js`、`lib/websearch.js`、`lib/webfetch.js`、`lib/extract.js`
> —— 自研搜索 / 抓取 / 正文提取随官方工具上线一并移除。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 读取配置（密钥返回掩码） |
| POST | `/api/config` | 更新 `apiKey` / `baseUrl` / `webSearch` / `readUrl` / `thinking` / `safety` / `title` / `systemPrompt` |
| POST | `/api/test-key` | 验证密钥可用性（请求 `/models`） |
| POST | `/api/files` | **上传代理**：原始字节 + `X-Filename`（encodeURIComponent）/ `X-Purpose` 头 → 官方 `POST /files` |
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions` | 新建会话 |
| GET | `/api/sessions/:id` | 会话详情（当前分支消息 + `branches`） |
| PATCH | `/api/sessions/:id` | 改标题 / 模型 / 切换分支（`leafId` 或 `leafId:'prev'/'next'`） |
| DELETE | `/api/sessions/:id` | 删除会话 |
| POST | `/api/chat` | **SSE 流式对话**（可带 `parentId` / `regenFrom` / `files[]`） |
| GET | `/api/health` | 健康检查 |

### SSE 事件

```jsonc
{"type":"session",     "sessionId":"…", "model":"deepseek-flash"}
{"type":"user",        "id":"…", "parentId":null}     // 提问已落库
{"type":"reasoning",   "text":"…"}                     // 思考增量
{"type":"content",     "text":"…"}                     // 正文增量
{"type":"tool_start",  "key":"0:0", "tool":"search_web", "label":"搜索「…」"}
{"type":"tool_result", "key":"0:0", "ok":true, "ms":211, "items":[…], "page":{…}}
{"type":"step_done",   "step":0}                       // 一轮工具调用收尾
{"type":"annotations", "list":[{ "type":"url_citation", "url_citation":{…} }]}
{"type":"done",        "usage":{…}, "finishReason":"stop"}
{"type":"error",       "message":"…", "aborted":false}
{"type":"end",         "assistantId":"…"}
{"type":"title",       "title":"…"}                    // 服务端自动生成标题
```

`tool` 取值：`search_web` / `fetch_url` / `image_search`（由官方 `action.type` 映射）。

### 请求体的构造（`lib/deepseek.js:buildBody`）

```jsonc
{
  "model": "deepseek-flash",
  "messages": [...],
  "stream": true,
  "stream_options": { "include_usage": true },
  "thinking":      { "type": "enabled" },     // 设置里开「深度思考」才有
  "safety_check":  { "level": "high" },       // 开「内容安全审核」才有
  "title":         { "enabled": true },       // 开「自动生成标题」才有
  "tools": [
    { "type": "deepseek_web_search" },
    { "type": "deepseek_read_url" }
  ],
  "tool_choice": "auto"
}
```

两条硬约束（踩过坑）：
1. 官方工具**只支持 `deepseek-flash`**。切到 `deepseek-v4-pro` 时必须不传 `tools`，否则 400。
2. 声明了 `tools` 时**不能再传** `web_search_options` / `response_format≠text` / `logprobs`，否则 400。

多轮对话必须把上一轮的 `server_tool_calls`（含每个 call 的 `kind` + `signature`）和 `annotations`
**原样回传**，否则模型会重复搜索、引用编号对不上。这一层在 `lib/sessions.js:toApiMessages` 里做。

上传文件的 multipart 里，`purpose` 字段**必须排在 `file` 之前**，否则 400。

---

## 无 Key 时跑测试

用 mock 服务验证整条链路（工具事件 → 引用角标 → 附件 → 富文本回答）：

```bash
node tests/mock-deepseek.mjs     # 终端 A，监听 :3999
node server.js                   # 终端 B
# 设置里把 API 地址改成 http://127.0.0.1:3999，Key 随便填 sk-mock
```

mock 支持 `MOCK_MODE=tools|text|slow|error` 三种场景，并会校验
「`tools` 与 `web_search_options` 不能并存」「assistant 历史必须回传 `signature`」
「`purpose` 必须先于 `file`」，违反就按官方行为返回 400。

---

## 说明

- **密钥安全**：只存在本机 `data/config.json`，接口返回时永远是掩码；不会写入日志。如需要多人使用，建议在前面加一层登录。
- **文件安全**：`/api/files` 只做转发，单文件上限 100 MiB，purpose 只接受官方三个值。
- 会话数据与配置都在 `data/` 下，直接删掉该目录即可重置。

## 安卓版

`android-app/` 是一个 WebView 壳，内嵌 `assets/www/` 下与网页版同设计语言的前端，
**WebView 内直连官方 API**（不经本地服务器），API Key 存在手机本地。

构建：`cd android-app && gradle assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk`

安卓端特有的移动交互：

- **原生开屏动画**：鹈鹕图标淡入 + 加载条，跟随系统深浅色，`onPageFinished` 后淡出
- **手势**：页面中部右滑拉出会话抽屉（左缘留给系统返回），抽屉开着时左滑收起
- 会话列表按「今天 / 更早」分组、可搜索；删除会话有居中确认弹窗防误触
- 输入框随文字自动增高（132px 封顶），发送后收回
- 安全区 / 键盘避让（`typing` 锁定防弹键盘顶飞布局）
- Debug 包开了 `WebContentsDebugging`：`chrome://inspect` 可直接调 WebView

| | 网页版 | 安卓版 |
|---|---|---|
| 联网 / 阅读 / 文件 | 浏览器 → 本机 Node 代理 → 官方 API | WebView 内直连官方 API |
| API Key | 存在服务器 `data/config.json` | 存在手机本地（App 内设置） |
| 引用角标 / 工具卡 / 文件上传 / 分支编辑 / 数学公式 | 有 | 有 |
| 缓存 | 服务端自动加 `?v=<mtime>`，不用手动清 | 跟随 APK 版本 |
| TTS / ASR / 导入导出 / Mermaid | 无 | 无 |

## Windows 桌面启动器

`scripts/` 提供一键启动：双击「DeepSeek Chat」快捷方式 →
检测 `localhost:3000` 未监听则静默拉起 `node server.js` → 自动打开浏览器。
重建方式见 `scripts/make-shortcut.ps1`；图标文件 `pelican.ico`（鹈鹕线稿）由
`make-icon.ps1` 生成，快捷方式指向带内嵌图标的 `launcher.exe`，不依赖 lnk 图标字段。

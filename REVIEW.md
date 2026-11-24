# 全栈代码审查报告

审查范围：`server.js`、`lib/`（Node 服务端）、`public/`（网页前端）、`android-app/`（WebView 前端 + Java 层）。
所有「高优先」问题都经过实际运行复现（curl 攻击 / jsdom 注入 / 真实请求体），不是纸面推测。

**结论：找到 6 个高优先 bug（全部可复现）、10 个可靠性隐患、若干死代码。高优先问题已全部修好并回归通过，配置已恢复为官方地址 + 空 Key。**

---

## 一、高优先（会真实打到用户）

### A1 网页版发图片必 413 —— 已修

**现象**：网页版上传一张 3MB 的手机照片，上传成功，一按发送就失败。

**原因**：图片被转成 base64 放进 `/api/chat` 的 JSON body，体积放大 1.37 倍 → 4MB；
而 `readJsonBody` 的默认上限是 2MB，直接抛 `413 请求体过大`。
网页版**没有任何压缩**（安卓端早就有 `shrinkImage` 压到 1600px），所以这是网页版独有的坑。

实测：构造 4MB 请求体打 `/api/chat` → `HTTP 413 {"error":"请求体过大"}`，且该错误信息完全没提「是图片太大」。

**修复**：
- `public/app.js` 新增 `shrinkImage(file, 1600, 0.86)`：`createImageBitmap` + canvas → JPEG，4 秒超时回退原图；`addFiles` 里图片先压再内联；压完仍 >1.2MB 就标记 `imageTooBig` 放弃内联。
- `server.js` 给 `/api/chat` 单独放宽到 **24MB**（其它接口仍是 2MB）。
- 413 文案改成：「请求体超过 XMB。多半是图片太大——请换小一点的图，或先用截图/压缩再发。」

### A2 网页版 emoji 让引用角标全部失效 —— 已修

**现象**：回答里只要出现一个 emoji（模型很爱用 `🐋`），正文里的 `[1]` `[2]` 角标全都不见了，只剩末尾的来源列表。安卓端同场景正常。

**原因**：`applyAnnotations` 做「DOM 文本 ↔ 原文」对齐时，字符收集用 `Array.from()`（**码点**），但取字符时用 `nodeValue[offset]`（**UTF-16 下标**）。一个 emoji 占 2 个 UTF-16 单元，从它之后整个映射错位 → 匹配率跌破 0.85 门槛 → 全部降级成「只显示来源列表」。

实测：一段带 `🐋` 的正文，jsdom 里 `角标数: 0`；同样内容在安卓端 `角标数: 1`。这就是铁证。

**修复**：收集时就存下码点字符 `{node, offset, ch}`，取字符用 `ch` 而不是 `nodeValue[offset]`。

回归：`emoji.cjs` 从 0 → 1；新增 5 个用例（含减号、em dash、代码块、引用块、多 emoji），全过。

### A3 网页版把整张图永久写进 sessions.json —— 已修

**现象**：`sessions.json` 里存着完整的图片 base64，且每一轮请求都把历史图片重新发一遍。

实测：一张 4KB 的图 → 会话 `files` 块 **4085 bytes**，其中 4022 是 data URL。

**后果**：几张手机照片就能把 `sessions.json` 撑到上百 MB；每轮对话都要重传十几 MB，慢且容易被掐断。

**修复**（三层）：
1. **落盘时剥掉 base64**：`server.js` 存节点前 `delete image`，只留 `{name, fileId, purpose, imageDropped:true}`，前端仍能显示附件条。
2. **历史轮次不回放 base64**：`userContent()` 只有本轮（带 `image` 字段）才用 `image_url`。
3. **历史图片降级成文字占位**：历史图片没有 base64，又不能拿 `file_id` 当文档喂（图片是 `text_recognition` 解析的，当文档会被官方拒），所以只留一句「（之前发过一张图片：a.png）」。

实测：同一会话第二轮之后，`sessions.json` 仍是 40KB 量级，无 base64。

> 顺带查到官方 Responses API 明确支持 `image_url.file_id`，但 **Chat Completions 是否支持说法不一**，所以没有依赖它——这正是选「落盘剥离 + file_id + 文字占位」方案的原因。

### A4 服务端不校验参数：`message` 可以是对象，`parentId` 可以不存在 —— 已修

两个独立 bug，都实测复现：

| 攻击 | 实测结果 | 应有行为 |
|---|---|---|
| `{"message":{"a":1}}` | 建了会话，并把 `[object Object]` 当提问发出去 | 400 |
| `{"sessionId":"...","parentId":"bad-id"}` | 建了会话，新提问静默挂到**根节点**，当前对话被截断成只剩这一条 | 409/400 |

坏父节点会话实测：节点 `14f62068 parent=None`，leaf 路径只剩「坏父节点 → 回答」，之前的历史全都不见了。

**修复**：
- `message` 非字符串（且非 null/undefined）→ `400 message 必须是字符串`。
- 续用已有会话时，`parentId` 必须能在树里找到，否则 `409 对话锚点已失效，请刷新页面后重试`。
- 顺带修好一个连带问题：**传了不存在的 `sessionId` 时不应该撞 409**。现在 `resumed=false` 就不做锚点校验、也不带 `parentId`，直接开新会话。

### A5 安卓端 `addNode` 不校验 parentId，产生孤儿节点 —— 已修

**现象**：传一个不存在的 `parentId`，节点仍被创建并保留该父 ID。

实测：`addNode(parentId:'NOT-EXIST')` → 返回 `n2-… parentId: NOT-EXIST`，节点留在 `nodes` 里。

**后果**：沿 `leafId` 往上的路径在这里断开，这条消息**永远显示不出来，也删不掉**。

**修复**：`addNode` 里 `if (pid && !nodeById(s, pid)) pid = null;`（降级为根节点，至少可见可操作）。

回归：新建 `/tmp/andbranch.cjs`，7/7 通过（含分支切换、兄弟节点、孤儿降级）。

### A6 `baseUrl` 允许任意协议（SSRF / 密钥外泄面）—— 已修

**现象**：`POST /api/config {"baseUrl":"file:///etc/passwd"}` 被接受并持久化，之后所有带 API Key 的请求都打向它。

实测：保存成功，`test-key` 返回「连接失败：fetch failed」。

**风险**：`baseUrl` 会被服务端**带着 API Key** 去请求。放开 `file://`、`gopher://` 等协议等于开了一个任意协议请求面。

**修复**：`setConfig` 只接受 `^https?://`，否则 400「接口地址必须是 http(s):// 开头」。

---

## 二、可靠性 / 体验（已修）

| # | 问题 | 修法 |
|---|---|---|
| B1 | `flush()` 导入但从未调用，进程退出时最后 200ms 的会话改动会丢 | 挂 `SIGINT`/`SIGTERM`，退出前 `flush()` |
| B2 | `systemPrompt` 无法清空——`trim()` 为空时被忽略，用户删光内容点保存，旧提示词还在 | `typeof === 'string'` 就接受，前端不再用 `\|\| undefined` 吞掉空串 |
| B3 | 安卓 `readChunkedFile` 把 100MB 分块全攒在内存数组里 | 每块转 `Blob` 交给浏览器托管 |
| B5/B10 | `webSearch` 用全局 `setConfig()` 写回，多标签页/多设备互相踩（A 关掉联网，B 也被关掉） | 只覆盖本轮 `cfg`；`runChat` 支持传入 `cfg` |
| B6 | 安卓返回键 `evaluateJavascript` 是异步的，手快连按两次可能直接退出 App | 加 `backPending` 闸门；顺带让返回键优先退出编辑态 |
| B7 | `NativeBridge` 路径校验用 `startsWith(base)`，`.../files_evil` 可绕过 | 改为 `getCanonicalPath()` + `base + File.separator`，顺带解析 `../` 和软链 |
| B8 | `page.chars` 恒为 0 → 界面显示「已读取 0 字符」 | 依次取 `chars` / `length` / `content.length`；前端 0 时改显示「已读取网页」 |
| B9 | 前端无上传大小提示 | `MAX_UPLOAD=100MB` 前端拦截 + toast |
| B11 | `serveStatic` 遇到畸形转义（`/%ZZ`）抛异常 → 500 | `decodeURIComponent` 包 try/catch → 400 |
| B12 | 目录穿越校验用的是裸 `startsWith`，`public_evil/` 可过 | 改成 `PUBLIC_DIR + path.sep` 前缀比对 |

**额外发现并修掉的两个安卓端真 bug（不在原清单里）：**

- **`purposeFor` 映射写错**：PDF/Word 被设成 `text_recognition`（那是给图片 OCR 用的），会导致解析时**版式丢失**；图片反而没有分支。已改为 `pdf/doc/ppt → rich_layout_recognition`、图片 → `text_recognition`、其余 → `user_data`。
- **安卓端图片存在内存里但没有 `fileId`**：图片既不压缩落盘也没有 `file_id`，**刷新页面这张图就彻底没了**。已改为同时上传 `/files` 换 `fileId`（并遵守「只有 deepseek-flash 支持 Files API」的限制），历史轮次靠 `file_id` 或文字占位。

## 三、死代码 / 小问题

- `server.js` `pageVersion()` 从未被调用（`injectVersions` 自己算）→ 已删。
- `lib/config.js` `loadEnv` 有自调用，属于正常启动路径，保留。
- `lib/sessions.js` 导出全部在用。
- `/api/config` 的 `keyHint`（`sk-••••test`）会泄露首尾字符。这是本机单用户工具、且 API 本身就要 Key 才能用，**未改**，仅记录：若要放到局域网，建议直接不返回 hint。

## 四、确认没问题的点

- **标题 XSS**：`el()` 全程用 `textContent`；`sanitizeUrl` 仅放行 `https?`/`mailto`/`data:image`。构造恶意标题实测不执行。
- **目录穿越**：`/../../etc/passwd` → 404（修完仍是 404）。
- **空 message**：`""` → 400（原本就正常）。
- **中止语义**：有正文落 assistant 节点、无正文回退 `setLeaf(userNode.id)`，前端 700ms 后按 `minCount` 刷新——三者缺一不可，本轮未改动、回归通过。

---

## 五、回归结果

| 测试 | 结果 |
|---|---|
| 网页端 `webtest.cjs` | 31 / 31 |
| 网页端 `webbranch.cjs`（重建） | 8 / 8 |
| 网页端 `skip.cjs`（角标边界，新建） | 5 / 5 |
| 安卓端 `andtest.cjs` | 10 / 10 |
| 安卓端 `andtest2.cjs`（角标） | 通过 |
| 安卓端 `andbranch.cjs`（重建） | 7 / 7 |
| 安卓端 `orphan.cjs`（孤儿节点） | 孤儿已消除 |
| curl 参数校验 4 项 | 全部符合预期 |
| 图片全链路（落盘 / 历史回放） | 无 base64 落盘，第二轮正常 |

`data/config.json` 已恢复：`apiKey=""`、`baseUrl="https://api.deepseek.com"`；`data/sessions.json`（测试垃圾）已删除。

## 六、修复后仍需注意

1. **`readJsonBody` 24MB 只是缓兵之计**：真发十几张原图仍会撞上限。彻底解法是「图片一律先传 `/files`，聊天只带 `file_id`」——但 Chat Completions 是否支持 `image_url.file_id` 尚无定论，建议实测官方接口后再切。
2. **安卓端未跑 Gradle 构建**（按你的要求）。Java 侧改动（`insideFilesDir`、`backPending`、`onPause`）只做了静态核对，真机第一次构建时建议重点看这三处。
3. **`/files` 上传的临时文件**目前不清理，长期用会在 `data/uploads` 堆积。

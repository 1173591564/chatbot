# DeepSeek 助手 · Android 客户端

把「DeepSeek 全家桶 + 聊天」做成一个**纯客户端**安卓 App：填自己的 API Key 就能用，不需要自建服务器、不需要代理。所有请求从手机直接发往 `api.deepseek.com`。

---

## 一、它做了什么

| 能力 | 实现方式 |
| --- | --- |
| 流式对话 | `POST /chat/completions` + SSE，逐字渲染 |
| 深度思考 | `thinking: {type: "enabled"}`，思考过程折叠展示，可展开 |
| 联网搜索 | 官方服务端工具 `deepseek_web_search`，实时工具卡 + 来源列表 |
| 阅读链接 | 官方服务端工具 `deepseek_read_url`，同样有工具卡与正文摘要 |
| 引用标注 | 解析 `annotations`（`url_citation`），正文插入可点角标 + 末尾「来源」 |
| 文件解析 | 拍照/选文件 → `POST /files` → `{"type":"file","file_id":…}` 引用 |
| 看图 | 图片内联成 `image_url` data URL（会自动压到 1600px） |
| 多轮记忆 | `server_tool_calls` / `annotations` 原样回传，避免重复搜索 |
| 会话管理 | 本地多会话、标题自动生成、删除 |
| 主题 | 纸墨风格明暗双主题，状态栏图标跟随 |
| Markdown | 标题/列表/表格/引用/代码块高亮 + 一键复制 |
| 重新生成 | 同题重答，旧回答保留成可切换的另一版 |
| 编辑提问 | 点「编辑」或长按气泡，改写任意一轮提问，旧问答不丢 |
| 分支切换 | 同一位置多个版本用 ‹ 1/2 › 翻页，上下文按当前分支截断 |
| 继续写 | 被长度上限截断时，带着已有内容续写 |
| 中止保留 | 点停止时保留已生成的部分 |
| 自动重试 | 网络层错误自动重试一次 |
| 回到底部 | 长回答翻上去后一键回落 |
| 会话搜索 | 按标题和提问内容过滤 |
| 多选文件 | 一次挑多个文档批量上传 |
| 粘贴图片 | 截图后直接粘贴成附件 |
| 工具计费 | 显示本轮搜索/抓取了几次 |

---

## 二、怎么构建

### 环境要求

- JDK 17 或 21
- Android SDK：`platforms;android-34`、`build-tools;34.0.0`
- Gradle 8.7（仓库里没有 wrapper，用系统 Gradle 即可）

### 步骤

```bash
cd android-app

# 指向你的 SDK（或用环境变量 ANDROID_HOME）
echo "sdk.dir=/path/to/android-sdk" > local.properties

gradle assembleDebug
```

产物在 `app/build/outputs/apk/debug/app-debug.apk`。

想要正式包用 `gradle assembleRelease`——注意 `app/build.gradle.kts` 里 release 目前复用 debug 签名，**发布前必须换成自己的 keystore**，否则无法上架、也无法覆盖升级。

### 用 Android Studio

直接 `Open` 这个 `android-app` 目录，等 Gradle Sync 完成即可运行。

---

## 三、第一次使用

1. 装好 APK，打开 App。
2. 点右上角齿轮 → 填 API Key（在 platform.deepseek.com 创建）→ **测试连接** → 保存。
3. 回主界面直接聊。左下角 `+` 添加文件或拍照。

Key 只存在 App 的本地存储里，不经过任何第三方。但**不要把内置了 Key 的安装包发给别人**。

---

## 四、目录结构

```
android-app/
├── app/src/main/
│   ├── assets/www/          # 整个前端（WebView 加载）
│   │   ├── index.html       # 结构：顶栏 / 消息区 / 输入区 / 抽屉 / 设置
│   │   ├── style.css        # 纸墨主题，明暗两套 token
│   │   ├── md.js            # 自写 Markdown 渲染 + 代码高亮
│   │   └── app.js           # 设置持久化、SSE 解析、工具卡、文件上传
│   ├── java/com/arena/deepseekchat/
│   │   ├── MainActivity.java   # WebView 容器、insets、返回键、外链
│   │   ├── NativeBridge.java   # JS ↔ 原生：选文件/拍照/分块读/剪贴板
│   │   └── FileUtils.java      # 文件名、大小、MIME 推断
│   └── res/                 # 图标、主题、FileProvider 路径
├── build.gradle.kts
└── settings.gradle.kts
```

---

## 五、实现上的几个关键点

### 1. `server_tool_event` 是 choice 级字段

流式响应里工具事件挂在 `choices[0]` 上，不是顶层：

```js
var choice = chunk.choices && chunk.choices[0];
var ev = (choice && choice.server_tool_event) || chunk.server_tool_event;
```

事件有三种：`step_reasoning_done` / `call_started` / `call_completed`。每个 chunk 最多一个。
完整的 `server_tool_calls` 和 `annotations` **只在带 `finish_reason` 的最后一个 chunk 里出现一次**，所以边流边渲染时，工具卡先只显示标题，等 `call_completed` 才填来源。

### 2. `purpose` 必须排在 `file` 前面

```js
var fd = new FormData();
fd.append('purpose', purpose);   // 必须先
fd.append('file', blob, name);   // 后
```

`purpose` 的取值：

- `text_recognition` — PDF / DOC / DOCX / PPT / PPTX，只要文字
- `rich_layout_recognition` — 需要保留图表版式时用（本次未默认使用，因为要额外计费图片 token）
- `user_data` — txt / md / csv / json / 代码 / XLSX / EPUB，**不计费**

### 3. 模型能力是硬约束

官方文档明确：**服务端工具和文件解析都要求 `deepseek-flash`**。所以：

```js
function modelSupportsTools() { return settings.model === 'deepseek-flash'; }
```

切到 `deepseek-v4-pro` 时，代码会自动不发送 `tools`，上传文件也会提示切回 Flash。这不是为了省事，硬发过去会返回 400。

### 4. `file://` 页面的跨域

WebView 从 `file:///android_asset/` 加载，`fetch` 到 `https://api.deepseek.com` 属于跨源：

- `settings.setAllowUniversalAccessFromFileURLs(true)`
- `shouldInterceptRequest` 里对 `*.deepseek.com` 的 `OPTIONS` 预检回 204 + 放行头

如果服务端对 `Origin: null` 不放行，第二条就是兜底。（经实测，`/chat/completions` 与 `/files` 目前允许 `file://` 这个源。）

### 5. 引用角标怎么定位

`annotations` 的 `start_index` / `end_index` 是**Unicode 码点**偏移，不是 UTF-16 下标。中文一个字算 1，emoji 算 1。

`applyAnnotations()` 会把渲染后的文本节点拼成字符串，用 `Array.from()` 按码点切分，再把角标插到对应位置。如果 Markdown 渲染改变了字符序列（比如列表符号），则降级为只在末尾输出「来源」列表，不会插错位。

### 6. 大文件不上内存

`NativeBridge` 里：

- ≤ 8 MiB：直接 base64 内联返回
- > 8 MiB：拷到 `files/uploads/`，前端用 `readChunk(path, offset, len)` 按 4 MiB 分块读、拼成 Blob 再上传，读完整即删临时文件

这样 100 MiB 的 PDF 也能传（官方上限 100 MiB / 1000 页）。

### 6.5 SSE 尾帧不能丢

流结束时 `buf` 里可能还剩最后一帧（没有尾随换行）。原实现用 `indexOf('\n')` 逐行切，尾帧会被直接扔掉——**如果它正好带着 `finish_reason` 和 `annotations`，引用和 `server_tool_calls` 就整段丢失**，下一轮还会重复搜索。

现在 `done` 分支里会 `decoder.decode()` 冲刷残留字节并把 `buf` 剩余部分按行处理完。

### 6.6 `finish_reason` 有三种，别只判断一种

| 值 | 处理 |
| --- | --- |
| `stop` | 正常结束 |
| `length` | 露出「继续写」按钮 + 黄色提示，入库时标 `truncated` |
| `content_filter` | 中性提示，不丢已生成内容 |

注意 `finish_reason` 在 **`choices[0]`** 上，不在 `delta` 里。

### 6.6 消息树与分支（会话数据结构）

会话不再是「一条 messages 直线」，而是一棵树：

```js
{
  id, title, model, createdAt, updatedAt,
  nodes: [{ id, parentId, role, content, reasoning?, tools?, ... }],
  leafId          // 当前看的那条分支的末端
}
```

- 当前对话 = 从 `leafId` 沿 `parentId` 回溯到根
- 同一父节点下、同角色的多个子节点 = 同一个位置的多个版本
- **编辑提问**：在「被编辑提问的父节点」下新挂一条 user 节点 → 旧问答整枝保留
- **重新生成**：在原提问节点下再挂一条 assistant 节点 → 一个提问多个回答
- 切换分支只改 `leafId`，不删任何节点
- 发给模型的上下文按当前分支截断，不会把别的分支内容混进去
- 旧版本存的 `messages` 直线在启动时自动折叠成树并写回，不会丢历史

### 6.7 重新生成 vs 继续写

两者都先 `messages = messages.slice(0, idx)` 截断到问题之前，区别在请求体：

- 重新生成：正常发请求，模型从头答
- 继续写：`toApiMessages(prefix)` 会在末尾追加一条 `{role:'assistant', content: 已有内容}`，引导模型接着补

### 7. 图片不走 Files

图片直接内联：

```json
{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
```

比上传再引用少一次计费、也更快。代价是 base64 会撑大请求体（约 +33%），所以发送前压到 1600px 内。请求体总上限 48 MiB。

---

## 六、已知限制（诚实版）

1. **没在真机上跑过。** 这份代码是按官方文档逐字段实现、并用 Node + jsdom 做过流式解析/工具卡/引用角标/上传顺序的离线测试，但**没有连真实 API Key 联调，也没有在真机安装验证**。第一次跑大概率会遇到小问题（见下条）。
2. **`safety_check` 的字段位置**按文档放在顶层（与 `tools` 平级）。若报 400，先把它关掉（设置里有开关）再试。
3. **`annotations` 的 `start_index` 语义**按官方「Unicode 码点」实现。如果服务端实际给的是 UTF-16 下标，纯中文场景表现一致，含 emoji 时角标可能偏一两格——不影响正文，只影响小角标位置。
4. **会话存 `localStorage`**，容量约 5–10 MB。历史里的图片超过 200 KB 会自动替换成占位符（正文还在，图没了），避免配额爆掉导致整个历史丢失。
5. **只自动重试一次**，且只在没有收到任何内容时重试（已经输出一半再重试会重复）。
6. **release 用 debug 签名**，只能自己装，不能上架、不能覆盖不同机器构建的同包名应用。
7. **不支持图像理解的模型**：V4 Pro 收到图片会报错。代码层面没拦（因为图片附件和模型选择可以不一致），自己注意切回 Flash。
8. **「继续写」是启发式**：把已有内容作为 `assistant` 前缀再请求。官方没有专门的续写参数，模型可能选择重写而非接着补；这时点「重新生成」更可靠。
9. **上传超时设为 4 分 20 秒**（官方：上传 120s + 解析 120s，留了余量）。超过会报「解析超时」，不会一直转圈。

---

## 七、和网页版的关系

工作区里 `server.js` 那一套是**可选**的「省钱模式」：它用一个 Node 服务转发请求、自己实现搜索与抓取，不消耗官方的按次计费。

这个安卓 App **不依赖**它。两者共用同一套视觉语言和前端逻辑结构，但网络层完全不同：

- 网页版：浏览器 → 你的 Node 服务 → DeepSeek
- 安卓版：App → DeepSeek（直连）

---

## 八、打包前检查清单

- [ ] `local.properties` 指向正确的 SDK（**不要提交到仓库**）
- [ ] 若要发布：把 release 签名换成自己的 keystore
- [ ] 若改了包名：检查 `AndroidManifest.xml` 里 FileProvider 的 `${applicationId}` 仍然生效
- [ ] 改完后先跑一次 `gradle assembleDebug`，装到手机上点一遍「测试连接」

---

## 九、许可与责任

自用工具。API Key 计费、内容合规都由你自己的 DeepSeek 账号承担。工具卡里的来源链接来自第三方网页，点击会跳到系统浏览器。

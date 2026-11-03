# M0 环境与契约验证结果

> 执行环境：E:\SillyTavern\SillyTavern（release 分支，commit 06bde939f）
> ST 版本：1.19.0（`node -e "require('./package.json').version"` 实测）
> Node 版本：v22.22.2
> 执行日期：2026-11-03

## 一、结论速览

| 编号 | 待验证项 | 结果 | 关键事实 |
|---|---|---|---|
| 1 | enableServerPlugins 打开后插件能否加载 | ✅ 通过 | 需给插件目录加 `package.json`（`"type":"module"`），否则 `export` 语法报错 |
| 2 | generateQuietPrompt 群聊是否污染上下文 | ⚠️ 源码确认，待浏览器实测 | 签名已确认，见 §2.2 |
| 3 | 群聊「自动模式」停止条件 | ⚠️ 待浏览器实测 | 源码确认存在，见 §2.4 |
| 4 | setExtensionPrompt 群聊注入位置 | ✅ 签名已确认 | 4 个位置枚举已确认，见 §2.3 |
| 5 | ST 具体版本号 | ✅ 已确认 | 1.19.0 |
| 6 | 目标 API 并发支持 | ⚠️ 待实测 | 多连接配置已确认存在 |

## 二、关键 API 契约（源码实证，可直接用于编码）

### 2.1 Server 插件契约（M0-2 实测通过）

- **加载方式**：`src/plugin-loader.js` 用 `await import(fileUrl)` 动态 import。
- **重要坑**：ST 根 `package.json` 无 `"type":"module"`，插件 `.js` 文件会被 Node 当 CommonJS，导致 `export` 报错 `Unexpected token 'export'`。
- **解法**：插件目录内放 `package.json` 声明 `{"type":"module","main":"index.js"}`（走 `loadFromPackage` 路径），或改用 `index.mjs`。
- **加载顺序**：`index.js` → `index.cjs` → `index.mjs`（`loadFromDirectory` 里 fileTypes 数组）。
- **插件结构**（实测通过）：
  ```js
  export const info = { id: 'xxx', name: 'Xxx', description: '...' };
  export async function init(router) { /* router.get/post(...) 挂到 /api/plugins/xxx/... */ }
  export async function exit() { /* 清理定时器 */ }
  ```
- **验证命令**：`curl http://127.0.0.1:8000/api/plugins/hello/ping` → `{"ok":true,"data":"pong"}`

### 2.2 generateQuietPrompt 签名（public/script.js:3084）

```js
await getContext().generateQuietPrompt({
    quietPrompt: '回复"测试"两个字',   // 注意：是对象参数，不是字符串！
    quietToLoud: false,
    skipWIAN: false,
    quietImage: null,
    quietName: null,
    responseLength: null,
    forceChId: null,                  // 群聊指定角色时用
    jsonSchema: null,                 // 可要求返回 JSON
    removeReasoning: true,
    trimToSentence: false,
});
```
- 返回字符串；`jsonSchema` 字段可用于强约束 JSON 输出（对 M3 意图判定、M4 提议极有用）。
- **注意**：位置参数已废弃，会打印 `console.trace` 警告。

### 2.3 setExtensionPrompt 签名（public/script.js:8926）

```js
getContext().setExtensionPrompt(key, value, position, depth, scan=false, role=0, filter=null);
```
- `position` 枚举（`extension_prompt_types`）：
  - `NONE: -1`
  - `IN_PROMPT: 0`（注入到 prompt 内）
  - `IN_CHAT: 1`（注入到聊天历史）
  - `BEFORE_PROMPT: 2`
- `role` 枚举（`extension_prompt_roles`）：`SYSTEM:0 / USER:1 / ASSISTANT:2`
- `getContext().getExtensionPromptRoleByName('system')` 可转换角色名。

### 2.4 群聊自动模式

- 源码关键词：`auto_mode_delay`、`DEFAULT_AUTO_MODE_DELAY`（public/scripts/bookmarks.js）。
- ST 原生群聊支持自动模式，无需 Autopilot 扩展。
- 停止条件需在浏览器实测（固定轮数 vs 等待输入）。

### 2.5 其他确认可用的能力（getContext() 返回值，st-context.js:115-230）

- 命令：`SlashCommandParser` / `SlashCommand` / `SlashCommandArgument` / `SlashCommandNamedArgument` / `SlashCommandEnumValue` / `ARGUMENT_TYPE` / `registerSlashCommand`（已废弃，用 `SlashCommandParser.addCommandObject()`）
- 消息：`addOneMessage` / `sendSystemMessage` / `saveReply` / `deleteLastMessage` / `deleteMessage`
- 事件：`eventSource` / `eventTypes`（100+ 事件）
- 多连接：`ConnectionManagerRequestService`（支持多连接配置）
- 工具调用：`ToolManager` / `registerFunctionTool` / `isToolCallingSupported`
- 变量（⚠️ 不建议存真值）：`getLocalVariable` / `setGlobalVariable` 等一整套
- 世界书：`convertCharacterBook` / `getWorldInfoPrompt` / `loadWorldInfo` 等

## 三、M0-6 双目录骨架（已建立）

```
E:\SillyTavern\SillyTavern\
├── plugins/university-sim/          ← 后端：时间引擎、状态总线、子系统
└── public/scripts/extensions/third-party/university-sim/  ← 前端：面板、注入、命令
```

## 四、待浏览器实测项（需用户在打开的 ST 页面操作）

以下 3 项无法在纯命令行确认，需要浏览器实际跑：
1. `generateQuietPrompt` 在群聊是否污染聊天记录（对比调用前后 chat.length）
2. 群聊「自动模式」的停止条件
3. 目标 API（如 OpenAI 兼容接口）是否支持并发请求

## 五、对后续开发的关键修正

1. **插件必须用 `package.json` 声明 `"type":"module"`**（或 `index.mjs`）——这是核查报告示例代码踩过的坑，已实测修复。
2. **`generateQuietPrompt` 是对象参数**，不是字符串——核查报告示例 `generateQuietPrompt('...')` 已过时。
3. **`jsonSchema` 字段**可直接强约束 LLM 返回 JSON，对 M3 意图判定、M4 效果提议的价值重大，建议优先采用而非 prompt 兜底。

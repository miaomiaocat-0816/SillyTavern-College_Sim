# University Sim（大学生活模拟 RP 框架）

SillyTavern 的「大学生活模拟」角色扮演框架 —— 纯扩展 + Server 插件实现，**零源码修改**。

## 项目结构

```
university-sim/
├── server-plugin/     # 后端 Server 插件（复制到 SillyTavern/plugins/university-sim/）
│   ├── index.js       # 入口（info + init + exit）
│   ├── lib/
│   │   ├── bus.js         # 状态总线（唯一真值 + JSON 落盘 + 串行化写入）
│   │   └── time-engine.js # 时间引擎（RP 时间推进 + 倍率/暂停）
│   └── routes/        # 统一路由（/state、/time、/tick）
├── ui-extension/      # 前端 UI 扩展（复制到 public/scripts/extensions/third-party/university-sim/）
│   ├── manifest.json
│   ├── index.js       # 可拖动面板 + 时间 tab
│   └── style.css
└── docs/              # 开发文档
    └── notes/api-verification.md  # M0 环境与契约验证结论
```

## 安装

1. **后端插件**：将 `server-plugin/` 复制到 SillyTavern 的 `plugins/university-sim/`
2. **前端扩展**：将 `ui-extension/` 复制到 SillyTavern 的 `public/scripts/extensions/third-party/university-sim/`
3. 在 `config.yaml` 设置 `enableServerPlugins: true`、`enableServerPluginsAutoUpdate: false`
4. 重启 SillyTavern，在 Extensions 面板勾选 University Sim

## 开发进度

- ✅ M0 环境与契约验证
- ✅ M1 后端地基（状态总线 + 时间引擎 + 路由）
- ✅ M2 物品·属性·物流（物品 + 快递 + 课程 + 属性系统）
- ✅ M3 叙事接入（事件仲裁 + 提议裁决器 + 世界书约束层 + prompt 注入 + 命令）
- ✅ M4 NPC 自主（角色池 + 陌生人触发 + 意图判定 + 主动发言）
- ✅ M5 多 API 与面板（连接绑定 + 属性/背包/快递/好感 tab）
- ✅ M6 可选插件（成人开关 + 生理状态 + 受孕判定 + 规则编辑器 + 概率配置 + 时间跳跃）

## 技术要点

- **架构铁律**：真值只存后端总线（`bus.mutate()` 唯一写入入口），LLM 无写入通道，数值不进叙事
- **零 fork**：不修改 SillyTavern 任何源码，纯扩展 + 插件（符合 AGPL 合规）
- **CSRF**：ST 1.19.0 全局启用，前端用 `getRequestHeaders()` 自动带 token
- **成人开关**：`enable_adult_events` 单一开关（settings.json），关闭时成人物品/事件/受孕代码路径全部不执行

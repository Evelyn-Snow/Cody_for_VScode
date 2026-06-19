# Cody for VSCode

[![VSCode](https://img.shields.io/badge/VSCode-%5E1.63.0-blue)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.1--build.4-orange)](package.json)

> **Cody** — 内嵌 VSCode 的 AI 编程助手，深度融合到编辑器工作流中，提供实时代码补全、下拉候选列表、多轮对话以及自主 Agent 工具链。

## 核心功能

| 功能 | 说明 |
|------|------|
| 幽灵文字补全 | 光标后实时浮现 AI 生成的灰色代码，Tab 一键接受 |
| 下拉候选补全 | 本地前缀匹配毫秒出结果 + 后台 AI 流式替换至首位 |
| Assistant 对话 | 侧边栏单轮问答，支持代码解释、文件分析、知识查询 |
| Agent 工具链 | 多轮自主执行：读写文件、操作文档、执行命令、管理任务进度 |
| SKILL 系统 | 导入 .md 文件作为 Agent 领域知识，启用/禁用/移除及查看 |
| 多模型谱系 | MiniMax / OpenAI / Qwen3 / Ollama / Anthropic，独立 API 配置 |
| 思考模式控制 | 5 种参数格式适配不同模型谱系，补全强制关闭、对话可自选开/关 |
| 办公文档 | Agent 直接创建 & 读取 .docx / .xlsx / .pdf |
| 快照回滚 | Agent 每次修改自动备份，随时一键恢复 |
| Token 流式 | 对话 SSE 流式输出，首字延迟极低 |
| 低版本兼容 | 最低支持 VSCode 1.63 / Windows 7（<1.68 时 inline 补全自动降级跳过） |

## 快速开始

### 安装

1. 下载最新 .vsix 文件（[Releases](https://github.com/QianQiuXue-Snow/Cody_for_VScode/releases)）
2. VSCode -> Ctrl+Shift+P -> Extensions: Install from VSIX... -> 选择文件
3. 点击左侧 Cody 图标打开侧边栏 -> 进入设置配置 API

### 配置 API

打开设置面板（侧边栏齿轮图标），按标签页配置：

| 标签 | 配置项 |
|------|--------|
| API | 对话 & 补全各自的 Base URL 和 Key |
| 模型 | 对话模型 / 补全模型 / 思考参数格式 / 思考开关 |
| 补全 | inline / dropdown / both |
| Agent | 最大轮数 / Tokens / Temperature |
| Skills | 导入 & 管理 Agent 领域知识 |

### 补全模式

| 模式 | 触发方式 | 接受方式 |
|------|----------|----------|
| inline | 打字后 250ms 自动 | Tab |
| dropdown | 输入 >= 2 个字符 | Enter（列表首位即 AI 结果） |
| both | 两者同时 | Tab / Enter 各司其职 |

## 项目结构

```
cody-for-vscode/
├── package.json              # VSCode 扩展配置 & 贡献点
├── tsconfig.json
├── src/
│   ├── extension.ts          # 入口：注册 Provider + 命令
│   ├── api/
│   │   └── openaiClient.ts   # OpenAI 兼容 HTTP 客户端（流式 / 非流式）
│   ├── completion/
│   │   ├── completionProvider.ts  # inline 幽灵文字补全
│   │   └── dropdownProvider.ts    # dropdown 下拉候选补全
│   ├── chat/
│   │   ├── chatPanel.ts      # Webview 后端逻辑
│   │   ├── chat.html         # Webview UI（设置面板 + 对话 + Skills）
│   │   └── chat.js           # Webview 前端交互
│   ├── agent/
│   │   └── agentEngine.ts    # Agent 工具定义 & 执行 & Prompt 生成
│   ├── skills/
│   │   └── skillManager.ts   # SKILL 导入 / 启禁 / 移除 / 持久化
│   ├── config/
│   │   └── settings.ts       # VSCode 配置读写
│   └── commands/
│       └── explainCommands.ts # 命令注册
├── skills/
│   └── code-analysis.skill   # 示例：代码分析 Skill
└── out/                      # 编译产物（tsc）
```

## 技术栈

| 层 | 技术 |
|---|------|
| 语言 | TypeScript |
| 运行时 | Node.js (VSCode Extension Host) |
| API | VSCode Extension API v1.63+ |
| AI 通信 | Node.js 原生 http/https + SSE 流式解析 |
| 文档处理 | mammoth / docx / xlsx / pdf-parse |
| 状态持久化 | VSCode ExtensionContext.globalState |

## 多模型兼容矩阵

| 谱系 | 思考关闭参数 | 代表模型 |
|------|-------------|----------|
| MiniMax / OpenAI | extra_body: { thinking: false } | MiniMax-M2.5, GPT-4o |
| Qwen3 | chat_template_kwargs: { enable_thinking: false } | Qwen3-30B, Qwen3-Coder |
| Ollama | think: false | codellama, qwen2.5-coder |
| Anthropic | extra_body: { thinking: { type: "disabled" } } | Claude 3.5/4 via 代理 |

## 开发

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 打包
npx vsce package --allow-missing-repository
```

## 许可证

MIT License.

Copyright (c) 2025

---

> **Agent 模式内核逻辑基于 Cody_for_Windows，本插件完全通过 AI 开发。**

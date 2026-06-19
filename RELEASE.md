# Cody for VSCode — Release Notes

## v0.1.0 → v0.1.1

---

## v0.1.1 (累计变更)

### ✨ 新增

- **Token 统计面板**：输入栏上方可折叠面板，实时展示对话/补全的请求数、Token 消耗、缓存命中率和运行时长。
- **对话 Token 细化**：缓存命中（系统 Prompt）/ 缓存未命中（对话历史）/ 输出 三项分立。
- **总计分离显示**：全局 Token 消耗单独一行，一目了然。
- **`edit_docx` 工具**：Agent 模式新增修改已有 Word 文档的能力（先 `read_docx` → 修改 → `edit_docx` 覆盖）。
- **Assistant 模式多轮记忆**：每次对话保留上下文，支持连续追问。

### 🐛 修复

- **Agent typing 动画卡死**：执行完毕/异常退出/手动停止后对话框不再残留跳动点。
- **工具调用间歇性丢失**：放宽 ` ```tool` 正则匹配 + 通用 JSON 兜底解析 + 安全网二次提取，`write_docx` 等工具不再被传为普通文本。
- **假 Token 计数**：补全请求为 0 时不再显示错误的 Token 消耗（之前错误地把模型名和 URL 估算为 Token）。
- **补全请求管理**：inline 幽灵补全新增 generation 过期检测，旧请求结果自动丢弃，消除打字后闪现旧补全。

### 🔧 优化

- **补全清洗**：新增 `completionCleaner` 共享模块，6 步严格清洗（去 code fences → 去前重叠 → 切后重叠 → 去空白 → 语义截断 → 重复检测），inline 和 dropdown 统一使用。

---

## v0.1.0（初始版本）

- 内嵌 VSCode 的 AI 编程助手
- Assistant（单次问答）+ Agent（多轮工具调用）双模式
- inline 幽灵文字补全 + 下拉候选列表
- 文件读写、目录列出、代码搜索、终端命令、PDF 读取、Word/Excel 创建等 13 种工具
- 补全缓存、快照回滚、危险操作审批、任务追踪
- OpenAI 兼容 API，支持思考模式（minimax / qwen / ollama / anthropic）

---

### 版本路线

```
v0.1.0
  ├─ build.2   Assistant 多轮记忆
  ├─ build.3   补全清洗 + 请求废弃
  ├─ build.4   Agent streaming 状态修复
  ├─ build.5   Token 统计面板
  └─ build.6   假 Token 修复
v0.1.1
  ├─ build.0   工具调用解析修复
  ├─ build.1   对话 Token 细化
  ├─ build.2   edit_docx 工具
  └─ build.3   缓存命中率 + 总计分离
```

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Settings } from '../config/settings';

// ========== DOMMatrix polyfill (pdf-parse 依赖 browser API) ==========
// pdf-parse → pdf.js 在 Node.js 环境缺少 DOMMatrix，此处提供最小实现
(globalThis as any).DOMMatrix = class DOMMatrix {
  a: number = 1; b: number = 0; c: number = 0; d: number = 1; e: number = 0; f: number = 0;
  m11: number = 1; m12: number = 0; m13: number = 0; m14: number = 0;
  m21: number = 0; m22: number = 1; m23: number = 0; m24: number = 0;
  m31: number = 0; m32: number = 0; m33: number = 1; m34: number = 0;
  m41: number = 0; m42: number = 0; m43: number = 0; m44: number = 1;
  is2D: boolean = true; isIdentity: boolean = true;

  constructor(init?: string | number[]) {
    if (typeof init === 'string') {
      this._setFromString(init);
    } else if (Array.isArray(init)) {
      this.a = init[0] ?? 1; this.b = init[1] ?? 0;
      this.c = init[2] ?? 0; this.d = init[3] ?? 1;
      this.e = init[4] ?? 0; this.f = init[5] ?? 0;
    }
  }

  private _setFromString(s: string): void {
    const m = s.match(/matrix\(([^)]+)\)/);
    if (m) {
      const vals = m[1].split(/[\s,]+/).map(Number);
      this.a = vals[0] ?? 1; this.b = vals[1] ?? 0;
      this.c = vals[2] ?? 0; this.d = vals[3] ?? 1;
      this.e = vals[4] ?? 0; this.f = vals[5] ?? 0;
    }
  }

  translate(x: number, y: number): DOMMatrix { this.e += x; this.f += y; return this; }
  scale(sx: number, sy?: number): DOMMatrix {
    const s = sy ?? sx;
    this.a *= s; this.b *= s; this.c *= s; this.d *= s;
    return this;
  }
  rotate(_angle: number): DOMMatrix { return this; }
  multiply(other: DOMMatrix): DOMMatrix { return this; }
  transformPoint(_point: any): any { return { x: 0, y: 0 }; }
  toFloat32Array(): Float32Array { return new Float32Array([this.a, this.b, this.c, this.d, this.e, this.f]); }
  toString(): string { return `matrix(${this.a},${this.b},${this.c},${this.d},${this.e},${this.f})`; }

  static fromMatrix(other: DOMMatrix): DOMMatrix { return new (globalThis as any).DOMMatrix() as DOMMatrix; }
  static fromFloat32Array(arr: Float32Array): DOMMatrix {
    return new (globalThis as any).DOMMatrix(Array.from(arr)) as DOMMatrix;
  }
  static fromFloat64Array(arr: Float64Array): DOMMatrix {
    return new (globalThis as any).DOMMatrix(Array.from(arr)) as DOMMatrix;
  }
};

// ========== 类型定义 ==========

export type ToolName =
  | 'read_file' | 'write_file' | 'list_files' | 'search_code' | 'delete_file' | 'execute_command'
  | 'read_docx' | 'write_docx' | 'edit_docx' | 'read_xlsx' | 'write_xlsx' | 'read_pdf'
  | 'todo';

export interface ToolCall {
  name: ToolName;
  arguments: Record<string, string>;
}

export interface ToolResult {
  name: ToolName;
  arguments: Record<string, string>;
  success: boolean;
  output: string;
}

export interface AgentTask {
  id: number;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface FileSnapshot {
  filePath: string;
  originalContent: string;
  timestamp: number;
}

/** 危险操作 */
const DANGEROUS_TOOLS: ToolName[] = ['delete_file', 'execute_command'];

export function isDangerous(toolName: ToolName): boolean {
  return DANGEROUS_TOOLS.includes(toolName);
}

// ========== Agent 系统 Prompt ==========

export function buildAgentSystemPrompt(skillsPrompt?: string): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const rootPath = workspaceFolders?.[0]?.uri.fsPath ?? '(未知)';

  const base = `${Settings.chatSystemPrompt}

你现在处于 **Cody Agent 模式**，可以主动使用工具来读取、分析、修改工程文件。

## 代码/文本文件工具

|\`read_file\`|读取文本文件内容|path: 文件路径（相对于工程根目录）|
|\`write_file\`|创建或覆盖文本文件|path: 文件路径, content: 完整文件内容|
|\`list_files\`|列出目录内容|dir: 目录路径（相对路径，空=根目录）|
|\`search_code\`|搜索代码|pattern: 搜索关键词|
|\`delete_file\`|删除文件 ⚠️|path: 文件路径|
|\`execute_command\`|执行终端命令 ⚠️（白名单程序: git/node/npm/npx/tsc/python/py/pip，不支持管道/重定向等 shell 语法）|cmd: 命令|

## 办公文档工具

| \`read_docx\`|读取 Word 文档 (.docx)|path: 文件路径|
| \`write_docx\`|创建 Word 文档 (.docx)|path: 文件路径, content: Markdown 格式内容（支持 # ## ### ** ** 列表等）|
| \`edit_docx\`|修改已有 Word 文档 (.docx)|path: 文件路径, content: 完整 Markdown 格式内容（覆盖写入）|
| \`read_xlsx\`|读取 Excel 表格 (.xlsx)|path: 文件路径, sheet: 工作表名称（可选，默认第一个）|
| \`write_xlsx\`|创建 Excel 表格 (.xlsx)|path: 文件路径, content: JSON 二维数组或对象数组格式|
| \`read_pdf\`|读取 PDF 文件（内部多策略自动回退，非常可靠）|path: 文件路径|

|\`todo\`|更新任务进度（追踪多步骤任务）|items: JSON数组 [{id, text, status: pending|in_progress|completed}]|

> ⚠️ **read_pdf 内置三级回退（pdf-parse → PyPDF2 → 二进制提取），能应对绝大多数 PDF。永远不要用 execute_command 手动提取 PDF，直接用 read_pdf 工具。**

## 工程信息
- 工程根目录: \`${rootPath}\`

## write_docx / edit_docx 的 content 格式
使用 Markdown 编写，支持：# 标题、## 二级标题、**加粗**、*斜体*、- 无序列表、1. 有序列表、普通段落。
其中 write_docx 用于新建 Word 文档，edit_docx 用于修改已有文档（先 read_docx 读取内容，修改后在 content 中提供完整新内容覆盖写入）。

## write_xlsx 的 content 格式
JSON 二维数组（每行一个数组）或对象数组（键名为表头），例如：
\`[["姓名","年龄"],["张三",30],["李四",25]]\` 或 \`[{"姓名":"张三","年龄":30}]\`

## 响应格式
普通回答用 Markdown。需要调用工具时**必须**使用以下 JSON 格式，严禁使用 XML 格式（<tool_calls>）：

\`\`\`tool
{
  "calls": [
    {"name": "read_file", "arguments": {"path": "src/main.py"}}
  ]
}
\`\`\`

**路径请使用工具名对应的参数名**：
- read_file/write_file/delete_file → "path"
- read_pdf / read_docx / read_xlsx / write_docx / edit_docx / write_xlsx → "path"
- list_files → "dir"（空字符串=根目录）
- search_code → "pattern"
- execute_command → "cmd"

每次可批量调用多个不相互依赖的工具。

> ⚠️ **JSON 格式**：content 字段中每个英文双引号必须写成 \\" (反斜杠+引号)，否则工具调用会被忽略。建议长文档直接用 write_file 写入文件。

## 重要规则
- 修改文件前先用 read_file 读取现有内容
- \`write_docx\` / \`edit_docx\` 提供 Markdown 格式内容，\`write_xlsx\` 提供 JSON 数组
- 修改 Word 文档时先 \`read_docx\` 读取内容，然后用 \`edit_docx\` 覆盖写入
- 所有路径相对于工程根目录
- **路径必须使用相对路径**：绝对路径（如 d 盘路径或 /home 路径）会被安全机制拒绝。所有工具的 path 参数必须相对于工程根目录。
- **高效操作**：
  * 读取文档/文件时直接用对应工具，不要先用 list_files 确认文件存在 — 工具会返回「文件不存在」
  * **禁止用 execute_command 替代已有的专用工具**（如 read_pdf、read_docx、read_xlsx）。专用工具内部已做优化，execute_command 只会触发危险审批并浪费轮数
  * **路径保护**：所有文件操作严格限定在工作区根目录内，.. 路径和绝对路径均被拒绝
  * 如果 read_pdf 失败，先检查错误信息再决定下一步，不要盲目重试
  * 每轮只用 1~2 个工具调用，不要批量调用超过 3 个
  * 每一轮都要有实质性进展，不要只在对话中描述计划而不执行
- **文档输出规则**：当需要输出的内容超过 3 段或 500 字时（如 Markdown 文档、Word 报告、分析总结、长篇文章等），**禁止直接在对话框中打印完整内容**，必须使用工具写入文件：
  * Markdown / 文本 → 用 \`write_file\` 写入 \`docs/文件名.md\`
  * Word 文档 → 用 \`write_docx\`（新建）或 \`edit_docx\`（修改已有），写入 \`docs/文件名.docx\`
  * Excel 表格 → 用 \`write_xlsx\` 写入 \`docs/文件名.xlsx\`
  * 写入后只需在对话框中告知文件路径和简短摘要即可`;

  return skillsPrompt ? `${base}\n${skillsPrompt}` : base;
}

// ========== 响应解析 ==========

export function parseToolCalls(content: string): { text: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  let text = content;

  // ===== 格式 A：```tool JSON（放宽：tool 后允许任意空白，包括无换行）=====
  const toolBlockRegex = /`{2,3}\s*tool\s*([\s\S]*?)`{2,3}/g;
  let match: RegExpExecArray | null;

  while ((match = toolBlockRegex.exec(content)) !== null) {
    let parsed: any;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      // 兜底：逐字段提取（覆盖所有工具名）
      parsed = salvageToolJson(match[1]);
    }
    if (parsed && parsed.calls && Array.isArray(parsed.calls)) {
      for (const call of parsed.calls) {
        if (call.name && call.arguments) {
          toolCalls.push({
            name: call.name as ToolName,
            arguments: call.arguments,
          });
        }
      }
    }
    text = text.replace(match[0], '');
  }

  // ===== 格式 B：<tool_calls> XML（部分模型原生格式）=====
  const xmlRegex = /<tool_calls>([\s\S]*?)<\/tool_calls>/g;
  let xmlMatch: RegExpExecArray | null;

  while ((xmlMatch = xmlRegex.exec(text)) !== null) {
    const xmlCalls = parseXmlToolCalls(xmlMatch[1]);
    for (const tc of xmlCalls) {
      toolCalls.push(tc);
    }
    text = text.replace(xmlMatch[0], '');
  }

  return { text: text.trim(), toolCalls };
}

/** 解析 <invoke name="xxx"><parameter name="yyy">value</parameter></invoke> 格式 */
function parseXmlToolCalls(xml: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const invokeRegex = /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  let m: RegExpExecArray | null;

  while ((m = invokeRegex.exec(xml)) !== null) {
    const name = m[1] as ToolName;
    const args: Record<string, string> = {};

    const paramRegex = /<parameter name="([^"]+)"(?:\s+[^>]*)?>([\s\S]*?)<\/parameter>/g;
    let pm: RegExpExecArray | null;

    while ((pm = paramRegex.exec(m[2])) !== null) {
      const key = pm[1];
      let val = pm[2].trim();
      // 尝试从 new_value 属性获取更新后的值
      const nvMatch = pm[0].match(/new_value="([^"]+)"/);
      if (nvMatch) val = nvMatch[1];
      args[key] = val;
    }

    if (name && Object.keys(args).length > 0) {
      calls.push({ name, arguments: args });
    }
  }

  return calls;
}

/** 还原 JSON 字符串转义（单次扫描，避免多轮 replace 的顺序污染：如 \\n 应得到「\ + n」而非换行） */
function unescapeJsonString(s: string): string {
  return s.replace(/\\(.)/g, (_m: string, c: string) => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '';
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      default: return c;
    }
  });
}

/** JSON.parse 失败时的通用兜底：提取所有 name/arguments 字段 */
export function salvageToolJson(raw: string): any | null {
  // 提取 name
  const nameMatch = raw.match(/"name"\s*:\s*"([^"]+)"/);
  if (!nameMatch) return null;

  const isContentTool = /^(write_file|write_docx|edit_docx|write_xlsx)$/.test(nameMatch[1]);

  if (isContentTool) {
    // 文件写入类：path + content（content 可能极长，正则不可靠 → 用索引定位）
    const pathMatch = raw.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!pathMatch) return null;

    // 定位 content 值起点（兼容 "content": " 与 "content":" 两种书写）
    const contentKeyIdx = raw.indexOf('"content"');
    if (contentKeyIdx === -1) return null;
    const colonIdx = raw.indexOf(':', contentKeyIdx + '"content"'.length);
    if (colonIdx === -1) return null;
    let contentStart = colonIdx + 1;
    while (contentStart < raw.length && /\s/.test(raw[contentStart])) contentStart++;
    if (raw[contentStart] !== '"') return null;
    contentStart++;

    // content 终点：从末尾跳过所有闭合符/空白（任意嵌套深度），应停在收尾引号上
    let end = raw.length;
    while (end > contentStart && /[\s}\])]/.test(raw[end - 1])) end--;
    if (end <= contentStart || raw[end - 1] !== '"') return null;

    let content = unescapeJsonString(raw.substring(contentStart, end - 1));
    if (!content) return null;

    return {
      calls: [{ name: nameMatch[1], arguments: { path: pathMatch[1], content } }],
    };
  }

  // 非 content 工具：逐 key-value 提取
  const args: Record<string, any> = {};
  const kvRegex = /"(\w+)"\s*:\s*("(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = kvRegex.exec(raw)) !== null) {
    if (m[1] === 'name' || m[1] === 'calls') continue;
    let v: any = m[2];
    if (v.startsWith('"')) {
      v = unescapeJsonString(v.slice(1, -1));
    } else if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v === 'null') v = null;
    else v = parseFloat(v);
    args[m[1]] = v;
  }

  if (Object.keys(args).length === 0) return null;
  return { calls: [{ name: nameMatch[1], arguments: args }] };
}

// ========== 摘要 / 详情 ==========

export function formatToolResultsSummary(results: ToolResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const icon = r.success ? '✅' : '❌';
    lines.push(`${icon} ${formatToolStat(r)}`);
  }
  return lines.join('\n');
}

function formatToolStat(r: ToolResult): string {
  const a = r.arguments;
  switch (r.name) {
    case 'read_file':
      return r.success
        ? `读取 \`${a.path}\` — ${r.output.split('\n').length} 行, ${Math.round(r.output.length / 1024)}KB`
        : `读取 \`${a.path}\` — 文件不存在`;
    case 'write_file':
    case 'write_docx':
    case 'edit_docx':
    case 'write_xlsx':
      return r.success
        ? `写入 \`${a.path}\` — ${(a.content || r.output).length} 字符`
        : `写入 \`${a.path}\` 失败: ${r.output}`;
    case 'list_files': {
      const c = r.success ? r.output.trim().split('\n').filter(l => l).length : 0;
      return `列出 \`${a.dir || '/'}\` — ${c} 个项目`;
    }
    case 'search_code': {
      const mc = r.success ? r.output.trim().split('\n').filter(l => l && !l.startsWith('未找到')).length : 0;
      return r.success ? `搜索 \`"${a.pattern}"\` — ${mc} 条匹配` : `搜索 \`"${a.pattern}"\` — 无匹配`;
    }
    case 'delete_file':
      return r.success ? `删除 \`${a.path}\`` : `删除 \`${a.path}\` 失败`;
    case 'execute_command':
      return r.success
        ? `执行 \`${(a.cmd || '').substring(0, 60)}\``
        : `执行失败: ${r.output.substring(0, 80)}`;
    case 'read_docx':
      return r.success
        ? `读取 Word \`${a.path}\` — ${Math.round(r.output.length / 1024)}KB 文本`
        : `读取 Word \`${a.path}\` 失败: ${r.output}`;
    case 'read_xlsx':
      return r.success
        ? `读取 Excel \`${a.path}\` — ${r.output.split('\n').length} 行`
        : `读取 Excel \`${a.path}\` 失败: ${r.output}`;
    case 'read_pdf':
      return r.success
        ? `读取 PDF \`${a.path}\` — ${Math.round(r.output.length / 1024)}KB 文本`
        : `读取 PDF \`${a.path}\` 失败: ${r.output}`;
    default:
      return r.success ? r.name : `${r.name} 失败`;
  }
}

export function formatToolResultsDetails(results: ToolResult[]): string {
  const sections: string[] = [];
  for (const r of results) {
    const icon = r.success ? '✅' : '❌';
    const heading = describeToolAction(r);
    let body = '';

    if (r.name === 'read_file' || r.name === 'read_docx' || r.name === 'read_pdf') {
      body = r.success
        ? `\`\`\`\n${r.output.length > 20000 ? r.output.substring(0, 20000) + '\n// ... (已截断)' : r.output}\n\`\`\``
        : r.output;
    } else if (r.name === 'write_file') {
      body = r.success
        ? `文件已写入 \`${r.arguments.path}\`（${(r.arguments.content || '').length} 字符）`
        : r.output;
    } else if (r.name === 'write_docx' || r.name === 'edit_docx' || r.name === 'write_xlsx') {
      body = r.output;
    } else if (r.name === 'read_xlsx') {
      body = `\`\`\`\n${r.output.length > 20000 ? r.output.substring(0, 20000) + '\n// ... (已截断)' : r.output}\n\`\`\``;
    } else if (r.name === 'search_code' || r.name === 'list_files') {
      body = `\`\`\`\n${r.output}\n\`\`\``;
    } else if (r.name === 'execute_command') {
      body = `\`\`\`sh\n${r.output}\n\`\`\``;
    } else {
      body = r.output;
    }

    sections.push(`#### ${icon} ${heading}\n\n${body}`);
  }
  return sections.join('\n\n');
}

function describeToolAction(r: ToolResult): string {
  switch (r.name) {
    case 'read_file': return `读取文件 \`${r.arguments.path}\``;
    case 'write_file': return `写入文件 \`${r.arguments.path}\``;
    case 'list_files': return `列出目录 \`${r.arguments.dir || '/'}\``;
    case 'search_code': return `搜索 \`"${r.arguments.pattern}"\``;
    case 'delete_file': return `删除文件 \`${r.arguments.path}\``;
    case 'execute_command': return `执行命令 \`${(r.arguments.cmd || '').substring(0, 80)}\``;
    case 'read_docx': return `读取 Word 文档 \`${r.arguments.path}\``;
    case 'write_docx': return `创建 Word 文档 \`${r.arguments.path}\``;
    case 'edit_docx': return `修改 Word 文档 \`${r.arguments.path}\``;
    case 'read_xlsx': return `读取 Excel 表格 \`${r.arguments.path}\``;
    case 'write_xlsx': return `创建 Excel 表格 \`${r.arguments.path}\``;
    case 'read_pdf': return `读取 PDF 文件 \`${r.arguments.path}\``;
    default: return r.name;
  }
}

export function formatToolResultsForAI(results: ToolResult[]): string {
  // 使用可读文本格式（避免 JSON 转义字符混入 AI 上下文）
  const lines: string[] = ['工具执行结果：'];
  for (const r of results) {
    const icon = r.success ? 'OK' : 'FAIL';
    const name = r.name;
    const path = r.arguments.path || r.arguments.dir || r.arguments.cmd || '';
    let output: string;

    if (!r.success) {
      output = r.output;
    } else if (r.name === 'read_docx' || r.name === 'read_pdf') {
      output = r.output.length > 30000 ? r.output.substring(0, 30000) + '\n...(已截断)' : r.output;
    } else if (r.name === 'read_xlsx') {
      output = r.output.length > 30000 ? r.output.substring(0, 30000) + '\n...(已截断)' : r.output;
    } else if (r.name === 'write_file' || r.name === 'write_docx' || r.name === 'edit_docx' || r.name === 'write_xlsx') {
      output = `文件已创建: ${path}`;
    } else if (r.name === 'read_file') {
      output = r.output;
    } else {
      output = r.output;
    }

    lines.push(`\n[${icon}] ${name} ${path}`);
    lines.push('---');
    lines.push(output);
    lines.push('---');
  }
  return lines.join('\n');
}

// ========== 工具执行 ==========

export async function executeTool(toolCall: ToolCall): Promise<ToolResult> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const rootPath = workspaceFolders?.[0]?.uri.fsPath ?? '';

  try {
    switch (toolCall.name) {
      case 'read_file': return executeReadFile(rootPath, toolCall.arguments);
      case 'write_file': return executeWriteFile(rootPath, toolCall.arguments);
      case 'list_files': return executeListFiles(rootPath, toolCall.arguments);
      case 'search_code': return executeSearchCode(rootPath, toolCall.arguments);
      case 'delete_file': return executeDeleteFile(rootPath, toolCall.arguments);
      case 'execute_command': return executeCommand(toolCall.arguments, rootPath);
      case 'read_docx': return await executeReadDocx(rootPath, toolCall.arguments);
      case 'write_docx': return await executeWriteDocx(rootPath, toolCall.arguments);
      case 'edit_docx': return await executeWriteDocx(rootPath, toolCall.arguments); // 与 write_docx 共用实现
      case 'read_xlsx': return executeReadXlsx(rootPath, toolCall.arguments);
      case 'write_xlsx': return executeWriteXlsx(rootPath, toolCall.arguments);
      case 'read_pdf': return await executeReadPdf(rootPath, toolCall.arguments);
      case 'todo': return executeTodo(toolCall.arguments);
      default:
        return { ...toolCall, success: false, output: `未知工具: ${toolCall.name}` };
    }
  } catch (error) {
    return { ...toolCall, success: false, output: `执行失败: ${(error as Error).message}` };
  }
}

/**
 * 解析并校验路径：仅允许操作工作区根目录内的文件。
 * 返回 null 表示路径越权。
 */
function safeResolve(rootPath: string, relativePath: string): string | null {
  if (!rootPath) return null;

  // 统一为正斜杠并去头
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');

  // 直接拒绝包含 .. 的路径（防符号链接绕过）
  if (cleaned.split('/').some(seg => seg === '..')) return null;

  // 标准化两个路径
  const normalizedRoot = path.resolve(rootPath);

  // 判断输入是否为绝对路径（Windows drive letter 或 Unix / 开头）
  const isAbs = path.isAbsolute(cleaned) || /^[a-zA-Z]:[/\\]/.test(relativePath);
  let resolved: string;
  if (isAbs) {
    resolved = path.resolve(cleaned);
  } else {
    resolved = path.resolve(normalizedRoot, cleaned);
  }

  // 检查是否在工作区内部
  const rel = path.relative(normalizedRoot, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }

  return resolved;
}

// ---- 文本文件 ----

function executeReadFile(rootPath: string, args: Record<string, string>): ToolResult {
  const fp = safeResolve(rootPath, args.path);
  if (!fp) return { name: 'read_file', arguments: args, success: false, output: `越权路径: ${args.path}` };
  if (!fs.existsSync(fp)) return { name: 'read_file', arguments: args, success: false, output: `文件不存在: ${args.path}` };
  const content = fs.readFileSync(fp, 'utf-8');
  return { name: 'read_file', arguments: args, success: true, output: content };
}

function executeWriteFile(rootPath: string, args: Record<string, string>): ToolResult {
  const fp = safeResolve(rootPath, args.path);
  if (!fp) return { name: 'write_file', arguments: args, success: false, output: `越权路径: ${args.path}` };
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, args.content, 'utf-8');
  return { name: 'write_file', arguments: args, success: true, output: `文件已写入: ${args.path} (${args.content.length} 字符)` };
}

function executeListFiles(rootPath: string, args: Record<string, string>): ToolResult {
  const dp = args.dir ? safeResolve(rootPath, args.dir) : rootPath;
  if (dp === null) return { name: 'list_files', arguments: args, success: false, output: `越权路径: ${args.dir}` };
  if (!fs.existsSync(dp)) return { name: 'list_files', arguments: args, success: false, output: `目录不存在: ${args.dir || '/'}` };
  const entries = fs.readdirSync(dp, { withFileTypes: true });
  const lines: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
    lines.push(`${e.isDirectory() ? '📁' : '📄'} ${e.name}`);
  }
  return { name: 'list_files', arguments: args, success: true, output: lines.join('\n') };
}

function executeSearchCode(rootPath: string, args: Record<string, string>): ToolResult {
  const pattern = args.pattern;
  if (!pattern) return { name: 'search_code', arguments: args, success: false, output: '缺少搜索关键词' };
  const results: string[] = [];
  const maxResults = 20;
  try { searchRecursive(rootPath, pattern, results, maxResults, rootPath); } catch { /* ignore */ }
  if (results.length === 0) return { name: 'search_code', arguments: args, success: true, output: `未找到匹配 "${pattern}" 的结果` };
  return { name: 'search_code', arguments: args, success: true, output: results.join('\n') };
}

function searchRecursive(dir: string, pattern: string, results: string[], max: number, rootPath: string): void {
  if (results.length >= max) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (results.length >= max) return;
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) { searchRecursive(fullPath, pattern, results, max, rootPath); }
    else if (e.isFile()) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && results.length < max; i++) {
          if (lines[i].toLowerCase().includes(pattern.toLowerCase())) {
            results.push(`${path.relative(rootPath, fullPath).replace(/\\/g, '/')}:${i + 1}: ${lines[i].trim().substring(0, 200)}`);
          }
        }
      } catch { /* skip binary */ }
    }
  }
}

function executeDeleteFile(rootPath: string, args: Record<string, string>): ToolResult {
  const fp = safeResolve(rootPath, args.path);
  if (!fp) return { name: 'delete_file', arguments: args, success: false, output: `越权路径: ${args.path}` };
  if (!fs.existsSync(fp)) return { name: 'delete_file', arguments: args, success: false, output: `文件不存在: ${args.path}` };
  fs.unlinkSync(fp);
  return { name: 'delete_file', arguments: args, success: true, output: `文件已删除: ${args.path}` };
}

/** 简单命令行分词（支持双/单引号），返回 null 表示引号未闭合 */
function tokenizeCommandLine(cmd: string): string[] | null {
  const argv: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) { quote = null; } else { cur += ch; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur) { argv.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (quote) return null;
  if (cur) argv.push(cur);
  return argv;
}

function executeCommand(_args: Record<string, string>, rootPath?: string): ToolResult {
  const fail = (output: string): ToolResult => ({ name: 'execute_command', arguments: _args, success: false, output });
  const raw = (_args.cmd || '').trim();
  if (!raw) return fail('缺少命令');
  // 不经 shell、直接以参数列表执行：拒绝控制字符与 shell 元字符（管道/重定向/串联等）
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fail('命令无效：不允许控制字符');
  if (/[|&<>;`$]/.test(raw)) return fail('命令无效：不支持管道、重定向、串联等 shell 语法，请拆分为多个简单命令');
  const argv = tokenizeCommandLine(raw);
  if (!argv || argv.length === 0) return fail('命令无效：引号未闭合');
  const restArgs = argv.slice(1);
  const execOpts = { encoding: 'utf-8' as BufferEncoding, timeout: 30000, maxBuffer: 500 * 1024, cwd: rootPath || undefined, windowsHide: true };
  try {
    const { execFileSync } = require('child_process');
    let output: string;
    // 白名单：仅允许以下固定程序，其余一律拒绝（不可信程序选择防护）
    switch (argv[0]) {
      case 'git': output = execFileSync('git', restArgs, execOpts); break;
      case 'node': output = execFileSync('node', restArgs, execOpts); break;
      case 'npm': output = execFileSync('npm', restArgs, execOpts); break;
      case 'npx': output = execFileSync('npx', restArgs, execOpts); break;
      case 'tsc': output = execFileSync('tsc', restArgs, execOpts); break;
      case 'python': output = execFileSync('python', restArgs, execOpts); break;
      case 'py': output = execFileSync('py', restArgs, execOpts); break;
      case 'pip': output = execFileSync('pip', restArgs, execOpts); break;
      default: return fail(`不允许执行程序: ${argv[0]}（白名单: git, node, npm, npx, tsc, python, py, pip）`);
    }
    return { name: 'execute_command', arguments: _args, success: true, output: output || '(无输出)' };
  } catch (error: any) {
    return fail(error.stderr || error.message || '命令执行失败');
  }
}

// ========== Word 文档 (.docx) ==========

async function executeReadDocx(rootPath: string, args: Record<string, string>): Promise<ToolResult> {
  const fp = safeResolve(rootPath, args.path);
  if (!fp) return { name: 'read_docx', arguments: args, success: false, output: `越权路径: ${args.path}` };
  if (!fs.existsSync(fp)) return { name: 'read_docx', arguments: args, success: false, output: `文件不存在: ${args.path}` };
  try {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: fp });
    const text = result.value || '';
    return { name: 'read_docx', arguments: args, success: true, output: text };
  } catch (e: any) {
    return { name: 'read_docx', arguments: args, success: false, output: `读取 Word 失败: ${e.message}` };
  }
}

async function executeWriteDocx(rootPath: string, args: Record<string, string>): Promise<ToolResult> {
  const fp = safeResolve(rootPath, args.path);
  if (!fp) return { name: 'write_docx', arguments: args, success: false, output: `越权路径: ${args.path}` };
  const markdown = args.content || '';
  try {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, LevelFormat, AlignmentType } = require('docx');

    const children: any[] = [];
    const lines = markdown.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) { children.push(new Paragraph({ text: '' })); continue; }

      // 标题
      if (line.startsWith('# ')) {
        const text = line.slice(2);
        children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_1 }));
      } else if (line.startsWith('## ')) {
        const text = line.slice(3);
        children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_2 }));
      } else if (line.startsWith('### ')) {
        const text = line.slice(4);
        children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_3 }));
      } else if (line.startsWith('- ') || line.startsWith('* ')) {
        // 无序列表
        const text = line.slice(2);
        children.push(new Paragraph({
          text,
          bullet: { level: 0 },
        }));
      } else if (/^\d+\.\s/.test(line)) {
        // 有序列表（numbering 引用需在 Document 中定义，见下方 config）
        const text = line.replace(/^\d+\.\s/, '');
        children.push(new Paragraph({ text, numbering: { reference: 'default-ol' } }));
      } else {
        // 普通段落 — 处理内联格式
        children.push(parseInlineMarkdown(line));
      }
    }

    const doc = new Document({
      numbering: {
        config: [
          {
            reference: 'default-ol',
            levels: [
              {
                level: 0,
                format: LevelFormat.DECIMAL,
                text: '%1.',
                alignment: AlignmentType.START,
              },
            ],
          },
        ],
      },
      sections: [{ properties: {}, children }],
    });

    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(fp, buffer);
    return { name: 'write_docx', arguments: args, success: true, output: `Word 文档已创建: ${args.path}` };
  } catch (e: any) {
    return { name: 'write_docx', arguments: args, success: false, output: `创建 Word 失败: ${e.message}` };
  }
}

/** 解析内联 Markdown 格式到 TextRun 数组 */
function parseInlineMarkdown(text: string): any {
  const { Paragraph, TextRun } = require('docx');
  const runs: any[] = [];
  const regex = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.substring(lastIndex, match.index) }));
    }
    if (match[2]) {
      runs.push(new TextRun({ text: match[2], bold: true }));
    } else if (match[3]) {
      runs.push(new TextRun({ text: match[3], italics: true }));
    } else if (match[4]) {
      runs.push(new TextRun({ text: match[4], font: 'Consolas' }));
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.substring(lastIndex) }));
  }
  return runs.length > 0 ? new Paragraph({ children: runs }) : new Paragraph({ text });
}

// ========== Excel 表格 (.xlsx) ==========

function executeReadXlsx(rootPath: string, args: Record<string, string>): ToolResult {
  const fp = safeResolve(rootPath, args.path);
  if (!fp) return { name: 'read_xlsx', arguments: args, success: false, output: `越权路径: ${args.path}` };
  if (!fs.existsSync(fp)) return { name: 'read_xlsx', arguments: args, success: false, output: `文件不存在: ${args.path}` };
  try {
    const XLSX = require('xlsx');
    const workbook = XLSX.readFile(fp);
    const sheetName = args.sheet || workbook.SheetNames[0];
    if (!workbook.Sheets[sheetName]) {
      return { name: 'read_xlsx', arguments: args, success: false, output: `工作表 "${sheetName}" 不存在，可用: ${workbook.SheetNames.join(', ')}` };
    }
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
    // 格式化为可读文本
    const lines = data.map((row: any[]) => row.map((cell: any) => String(cell ?? '')).join('\t')).join('\n');
    return { name: 'read_xlsx', arguments: args, success: true, output: lines };
  } catch (e: any) {
    return { name: 'read_xlsx', arguments: args, success: false, output: `读取 Excel 失败: ${e.message}` };
  }
}

function executeWriteXlsx(rootPath: string, args: Record<string, string>): ToolResult {
  const fp = safeResolve(rootPath, args.path);
  if (!fp) return { name: 'write_xlsx', arguments: args, success: false, output: `越权路径: ${args.path}` };
  const content = args.content || '';
  try {
    const XLSX = require('xlsx');
    let parsed: any[];
    try { parsed = JSON.parse(content); } catch {
      return { name: 'write_xlsx', arguments: args, success: false, output: 'content 不是有效 JSON，请提供 JSON 数组格式' };
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { name: 'write_xlsx', arguments: args, success: false, output: 'content 必须是包含至少一行的 JSON 数组' };
    }

    const isObjectArray = typeof parsed[0] === 'object' && !Array.isArray(parsed[0]);
    const worksheet = isObjectArray
      ? XLSX.utils.json_to_sheet(parsed)
      : XLSX.utils.aoa_to_sheet(parsed);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, args.sheet || 'Sheet1');

    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    XLSX.writeFile(workbook, fp);

    return { name: 'write_xlsx', arguments: args, success: true, output: `Excel 表格已创建: ${args.path} (${parsed.length} 行)` };
  } catch (e: any) {
    return { name: 'write_xlsx', arguments: args, success: false, output: `创建 Excel 失败: ${e.message}` };
  }
}

// ========== PDF（多策略回退）==========

async function executeReadPdf(rootPath: string, args: Record<string, string>): Promise<ToolResult> {
  const fp = safeResolve(rootPath, args.path);
  if (!fp) return { name: 'read_pdf', arguments: args, success: false, output: `越权路径: ${args.path}` };
  if (!fs.existsSync(fp)) return { name: 'read_pdf', arguments: args, success: false, output: `文件不存在: ${args.path}` };

  const strategies: Array<{ name: string; fn: () => Promise<string | null> }> = [
    {
      name: 'pdf-parse',
      fn: async () => {
        const pdfParse = require('pdf-parse');
        const buffer = fs.readFileSync(fp);
        const data = await pdfParse(buffer);
        return data.text || null;
      },
    },
    {
      name: 'Python + PyPDF2',
      fn: async () => {
        const { execFileSync } = require('child_process');
        const os = require('os');
        // 文件路径经 argv 传入（参数列表），不嵌入脚本字符串
        const pyScript = `import sys
from PyPDF2 import PdfReader
r = PdfReader(sys.argv[1])
print(''.join([p.extract_text() or '' for p in r.pages]))
`;
        // 临时脚本写入系统临时目录，避免污染用户工作区
        const tmpPy = path.join(os.tmpdir(), `cody_pdf_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
        fs.writeFileSync(tmpPy, pyScript, 'utf-8');
        try {
          // Windows 常见两种入口：python.exe 与 py 启动器，依次尝试（均为固定字面量）
          let out: string | null = null;
          for (const py of ['python', 'py']) {
            try {
              out = execFileSync(py, [tmpPy, fp], {
                encoding: 'utf-8', timeout: 60000, maxBuffer: 10 * 1024 * 1024,
                windowsHide: true,
              });
              break;
            } catch { /* 启动器不存在或执行失败，尝试下一个 */ }
          }
          return out || null;
        } finally {
          try { fs.unlinkSync(tmpPy); } catch {}
        }
      },
    },
    {
      name: '二进制回退',
      fn: async () => {
        const raw = fs.readFileSync(fp, 'utf-8');
        const matches = raw.match(/[\x20-\x7E\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]{4,}/g);
        return matches ? matches.join('\n').substring(0, 50000) : null;
      },
    },
  ];

  const errors: string[] = [];
  for (const s of strategies) {
    try {
      const text = await s.fn();
      if (text && text.trim().length > 10) {
        return { name: 'read_pdf', arguments: args, success: true, output: text };
      }
      errors.push(`${s.name}: 提取内容过短或为空`);
    } catch (e: any) {
      errors.push(`${s.name}: ${e.message || e}`);
    }
  }

  return {
    name: 'read_pdf',
    arguments: args,
    success: false,
    output: `PDF 解析失败，已尝试 ${strategies.length} 种方式：\n${errors.map(e => '  - ' + e).join('\n')}`,
  };
}

// ========== 文件快照（回滚支持） ==========

// ========== Todo 任务跟踪 ==========

function executeTodo(args: Record<string, string>): ToolResult {
  try {
    const items = args.items ? JSON.parse(args.items) : null;
    const count = Array.isArray(items) ? items.length : 0;
    return { name: 'todo', arguments: args, success: true, output: `任务列表已更新 (${count} 项)` };
  } catch {
    return { name: 'todo', arguments: args, success: true, output: '任务列表已更新' };
  }
}

// ========== 文件快照（回滚支持） ==========

export class SnapshotManager {
  private snapshots: Map<string, FileSnapshot> = new Map();

  snapshot(filePath: string, originalContent: string): void {
    if (!this.snapshots.has(filePath)) {
      this.snapshots.set(filePath, { filePath, originalContent, timestamp: Date.now() });
    }
  }

  rollbackAll(): string[] {
    const restored: string[] = [];
    for (const [, snap] of this.snapshots) {
      try { fs.writeFileSync(snap.filePath, snap.originalContent, 'utf-8'); restored.push(snap.filePath); } catch { /* skip */ }
    }
    this.snapshots.clear();
    return restored;
  }

  rollbackFile(filePath: string): boolean {
    const snap = this.snapshots.get(filePath);
    if (!snap) return false;
    try { fs.writeFileSync(snap.filePath, snap.originalContent, 'utf-8'); this.snapshots.delete(filePath); return true; } catch { return false; }
  }

  commit(): void { this.snapshots.clear(); }
  get count(): number { return this.snapshots.size; }
  get list(): FileSnapshot[] { return Array.from(this.snapshots.values()); }
}

// ========== 任务管理 ==========

export class TaskManager {
  private tasks: AgentTask[] = [];
  private nextId = 1;

  createTask(title: string, description: string): AgentTask {
    const task: AgentTask = { id: this.nextId++, title, description, status: 'pending' };
    this.tasks.push(task);
    return task;
  }

  setStatus(id: number, status: AgentTask['status']): void {
    const task = this.tasks.find(t => t.id === id);
    if (task) task.status = status;
  }

  getAll(): AgentTask[] { return [...this.tasks]; }
  clear(): void { this.tasks = []; this.nextId = 1; }
}

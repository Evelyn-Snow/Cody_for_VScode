import * as vscode from 'vscode';
import { Settings } from '../config/settings';
import { CompletionEngine, getWordStart, getCurrentPrefix } from './completionEngine';

/**
 * 下拉补全 Provider（本地毫秒出 + 后台 AI 填充）
 *
 * 相比旧实现：
 * - 不再用「AI 完成后 triggerSuggest 重新弹出」的 hack，改用
 *   resolveCompletionItem 懒解析：占位项显示时由 VSCode 主动 resolve，
 *   完成后原地填充 label / insertText / documentation；
 * - AI 缓存由 CompletionEngine 按 (URI, 单词起点) 键控，修复旧版
 *   仅按前缀缓存导致的跨文件串味；
 * - 与 inline Provider 共享单飞请求，不重复打 API。
 */
const AI_PLACEHOLDER = 'cody-ai-pending';

interface PlaceholderData {
  type: string;
  uri: string;
  /** 纯 JSON 结构：{line, character}，避免跨序列化携带 vscode.Position 实例 */
  position: { line: number; character: number };
  wordStart: { line: number; character: number };
  prefix: string;
  language: string;
}

export class DropdownCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private engine: CompletionEngine) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): vscode.CompletionItem[] {
    if (!Settings.enableCompletion || !Settings.isDropdownMode) {
      return [];
    }

    const wordStart = getWordStart(document, position);
    const prefix = getCurrentPrefix(document, position, wordStart);
    if (prefix.length < Settings.completionMinPrefix) return [];

    // 1. 本地匹配（始终返回）
    const localItems = this.getLocalMatches(document, position, prefix);

    // 2. AI 缓存命中 → 直接返回（与 inline 共享同一缓存）
    const cached = this.engine.getCached(document, position);
    if (cached !== null) {
      const aiItem = this.makeAiItem(cached, prefix, wordStart, position, document.languageId);
      return [aiItem, ...this.withLocalSeparator(localItems)];
    }

    // 3. 未命中 → 本地结果 + AI 占位（resolve 时懒加载）
    const placeholder = new vscode.CompletionItem('⏳ AI 生成中...', vscode.CompletionItemKind.Event);
    placeholder.sortText = '!ai-loading';
    placeholder.preselect = false;
    placeholder.detail = '后台 AI 正在生成补全';
    // 占位期间被接受时：以当前前缀替换自身（等价于无操作）
    placeholder.insertText = prefix;
    placeholder.range = new vscode.Range(wordStart, position);
    placeholder.filterText = prefix;
    // data 属性 VSCode 1.65+ 才有，用 any 兼容旧版类型定义
    (placeholder as any).data = {
      type: AI_PLACEHOLDER,
      uri: document.uri.toString(),
      position: { line: position.line, character: position.character },
      wordStart: { line: wordStart.line, character: wordStart.character },
      prefix,
      language: document.languageId,
    } as PlaceholderData;

    // 预热请求（防抖计时从现在开始；resolve 时会复用同一任务）
    void this.engine.request(document, position);

    return [placeholder, ...this.withLocalSeparator(localItems)];
  }

  async resolveCompletionItem(
    item: vscode.CompletionItem,
    _token: vscode.CancellationToken
  ): Promise<vscode.CompletionItem> {
    const data = (item as any).data as PlaceholderData | undefined;
    if (!data || data.type !== AI_PLACEHOLDER) return item;

    const doc = await this.findDocument(data.uri);
    if (!doc) return item;

    const position = new vscode.Position(data.position.line, data.position.character);
    const wordStart = new vscode.Position(data.wordStart.line, data.wordStart.character);

    const text = await this.engine.request(doc, position, { revive: false });
    if (!text) return item; // 失败/取消/已失效 → 保持占位

    const filled = this.makeAiItem(text, data.prefix, wordStart, position, data.language);
    item.label = filled.label;
    item.insertText = filled.insertText;
    item.range = filled.range;
    item.filterText = filled.filterText;
    item.detail = filled.detail;
    item.documentation = filled.documentation;
    (item as any).data = undefined; // 防止重复 resolve
    return item;
  }

  // ===== 本地前缀匹配 =====

  private getLocalMatches(
    document: vscode.TextDocument,
    _position: vscode.Position,
    prefix: string
  ): vscode.CompletionItem[] {
    // 大文件限长扫描：本地匹配只是辅助，超出部分不再全文正则
    const SCAN_LIMIT = 300_000;
    const text = document.getText().substring(0, SCAN_LIMIT);
    const seen = new Set<string>();
    const items: vscode.CompletionItem[] = [];
    const lowerPrefix = prefix.toLowerCase();

    const re = /\b(\w[\w.]{1,40})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const word = m[1];
      if (word.length <= prefix.length) continue;
      if (!word.toLowerCase().startsWith(lowerPrefix)) continue;
      if (seen.has(word)) continue;
      seen.add(word);

      const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Text);
      item.sortText = `0${String(items.length).padStart(4, '0')}`;
      item.filterText = word;
      item.detail = '本地';
      items.push(item);
      if (items.length >= 10) break;
    }
    return items;
  }

  // ===== UI 组装 =====

  /** 构造最终 AI 补全项：insertText 为「前缀 + 续写」，range 覆盖整个单词 */
  private makeAiItem(
    text: string,
    prefix: string,
    wordStart: vscode.Position,
    position: vscode.Position,
    language: string
  ): vscode.CompletionItem {
    const full = prefix + text;
    const label = full.length > 60
      ? full.substring(0, 60).replace(/\n/g, '↵') + '…'
      : full.replace(/\n/g, '↵');

    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
    // 纯文本插入（不能用 SnippetString：补全里的 ${...}、$1 会被当 snippet 语法解析而丢失）
    item.insertText = full;
    item.range = new vscode.Range(wordStart, position);
    item.sortText = '!ai';
    item.filterText = full;
    item.detail = '🤖 AI 补全';
    item.documentation = new vscode.MarkdownString(
      `\`\`\`${language}\n${full}\n\`\`\``
    );
    return item;
  }

  private withLocalSeparator(localItems: vscode.CompletionItem[]): vscode.CompletionItem[] {
    if (localItems.length === 0) return [];
    const sep = new vscode.CompletionItem('- 本地匹配 -', vscode.CompletionItemKind.Text);
    sep.sortText = '~local';
    sep.preselect = false;
    return [sep, ...localItems];
  }

  private async findDocument(uriStr: string): Promise<vscode.TextDocument | null> {
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uriStr);
    if (open) return open;
    try {
      return await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
    } catch {
      return null;
    }
  }
}

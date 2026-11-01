import * as vscode from 'vscode';
import { openAIClient, estimateTokens, TokenUsage } from '../api/openaiClient';
import { Settings } from '../config/settings';
import { cleanCompletion } from './completionCleaner';
import { ChatPanelProvider } from '../chat/chatPanel';

/**
 * 统一补全引擎
 *
 * 旧实现的问题：
 * - inline / dropdown 两个 Provider 各自发请求，同一次击键可能打两次 API；
 * - 下拉缓存只按前缀键控、不区分文件 → 跨文件返回别的文件的补全；
 * - 用户继续输入时无法真正中止在途 HTTP（只能等结果回来再丢弃）；
 * - 防抖时长硬编码 200ms，配置项 completionDebounceMs 从未生效。
 *
 * 本引擎采用 Tabby / Continue 等成熟实现的通用模式：
 * 1. 单飞（single-flight）：同一「URI + 单词起点」只保留一个在途任务，
 *    inline 与 dropdown 复用同一个请求；
 * 2. 尾沿防抖：连续输入不断重置计时器，停手后才真正发请求；
 * 3. 真实取消：换词 / 换文档时 abort 底层 HTTP 连接；
 * 4. 前缀校验缓存：按 (URI, 单词起点偏移) 键控 + TTL + 内容一致性校验，
 *    同一单词内继续输入时直接命中缓存，不再重复请求。
 */

/** 光标所在单词的起点（扫描 [\w.] 字符） */
export function getWordStart(document: vscode.TextDocument, position: vscode.Position): vscode.Position {
  const line = document.lineAt(position.line);
  const text = line.text.substring(0, position.character);
  const m = text.match(/([\w.]+)$/);
  const startChar = m ? position.character - m[1].length : position.character;
  return new vscode.Position(position.line, startChar);
}

/** 当前正在输入的单词前缀 */
export function getCurrentPrefix(
  document: vscode.TextDocument,
  position: vscode.Position,
  wordStart: vscode.Position
): string {
  return document.getText(new vscode.Range(wordStart, position));
}

interface CacheEntry {
  /** 完整补全文本（含请求时的前缀），查找时按当前前缀切片 */
  fullText: string;
  createdAt: number;
}

interface Job {
  uriKey: string;
  key: string;
  /** 以完整补全文本（含前缀）resolve，失败 / 取消为 null */
  promise: Promise<string | null>;
  resolve: (v: string | null) => void;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  /** 任务持有的上下文：请求复用时刷新为最新位置 */
  context: { document: vscode.TextDocument; position: vscode.Position };
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 50;

export class CompletionEngine implements vscode.Disposable {
  private cache = new Map<string, CacheEntry>();
  private jobs = new Map<string, Job>();
  private disposed = false;

  dispose(): void {
    this.disposed = true;
    this.cancelAll();
    this.cache.clear();
  }

  /** 清空缓存并取消所有在途任务（配置变更时调用） */
  clearCache(): void {
    this.cache.clear();
    this.cancelAll();
  }

  /** 同步缓存命中：返回可直接插入的续写文本；未命中返回 null */
  getCached(document: vscode.TextDocument, position: vscode.Position): string | null {
    if (this.disposed) return null;
    const wordStart = getWordStart(document, position);
    const prefix = getCurrentPrefix(document, position, wordStart);
    if (prefix.length < Settings.completionMinPrefix) return null;
    const key = this.makeKey(document, wordStart);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    // 内容一致性校验：用户输入必须与补全开头一致（换词/改写自动失效）
    if (!entry.fullText.startsWith(prefix)) {
      this.cache.delete(key);
      return null;
    }
    return entry.fullText.slice(prefix.length);
  }

  /**
   * 请求补全：返回插入文本（续写部分），失败/取消/无效返回 null。
   * @param opts.immediate 为 true 时跳过防抖立即请求（inline 手动触发用）
   * @param opts.revive 为 false 时，若任务已被取消则不新建（占位项 resolve 用，
   *        防止过期占位复活任务并与新词任务互相取消）
   */
  request(
    document: vscode.TextDocument,
    position: vscode.Position,
    opts?: { immediate?: boolean; revive?: boolean }
  ): Promise<string | null> {
    if (this.disposed) return Promise.resolve(null);
    const wordStart = getWordStart(document, position);
    const prefix = getCurrentPrefix(document, position, wordStart);
    if (prefix.length < Settings.completionMinPrefix) return Promise.resolve(null);

    const key = this.makeKey(document, wordStart);

    // 1. 缓存命中
    const cached = this.getCached(document, position);
    if (cached !== null) return Promise.resolve(cached);

    // 2. 已有同 key 任务 → 复用（单飞），刷新上下文与防抖计时
    let job = this.jobs.get(key);
    if (job) {
      job.context = { document, position };
      if (job.timer) {
        // 尾沿防抖：连续输入重置计时器
        clearTimeout(job.timer);
        job.timer = undefined;
        if (opts?.immediate) {
          this.fireJob(job);
        } else {
          this.armTimer(job);
        }
      }
      // timer 已清除但尚未请求完成 → 正在请求中，无需额外动作
      return this.normalize(job.promise, prefix);
    }

    // 3. 新建任务；取消同一文档上其它单词的在途任务（避免请求堆积）
    if (opts?.revive === false) return Promise.resolve(null);
    const uriKey = document.uri.toString();
    this.cancelSiblings(uriKey, key);
    job = this.createJob(key, uriKey, document, position);
    this.jobs.set(key, job);
    if (opts?.immediate) {
      this.fireJob(job);
    } else {
      this.armTimer(job);
    }
    return this.normalize(job.promise, prefix);
  }

  /** 取消某一文档上的所有在途任务 */
  cancelUri(uriKey: string): void {
    for (const [key, job] of Array.from(this.jobs.entries())) {
      if (job.uriKey !== uriKey) continue;
      this.settle(job, null);
      this.jobs.delete(key);
    }
  }

  private cancelAll(): void {
    for (const [key, job] of Array.from(this.jobs.entries())) {
      this.settle(job, null);
      this.jobs.delete(key);
    }
  }

  private cancelSiblings(uriKey: string, keepKey: string): void {
    for (const [key, job] of Array.from(this.jobs.entries())) {
      if (key === keepKey || job.uriKey !== uriKey) continue;
      this.settle(job, null);
      this.jobs.delete(key);
    }
  }

  private makeKey(document: vscode.TextDocument, wordStart: vscode.Position): string {
    return `${document.uri.toString()}#${document.offsetAt(wordStart)}`;
  }

  private createJob(
    key: string,
    uriKey: string,
    document: vscode.TextDocument,
    position: vscode.Position
  ): Job {
    let resolve!: (v: string | null) => void;
    const promise = new Promise<string | null>((res) => { resolve = res; });
    return { uriKey, key, promise, resolve, context: { document, position } };
  }

  private armTimer(job: Job): void {
    job.timer = setTimeout(() => {
      job.timer = undefined;
      this.fireJob(job);
    }, Settings.completionDebounceMs);
  }

  /** 结果归一化：完整文本必须仍以调用方的前缀开头，否则视为失效 */
  private async normalize(promise: Promise<string | null>, prefix: string): Promise<string | null> {
    const fullText = await promise;
    if (!fullText) return null;
    return fullText.startsWith(prefix) ? fullText.slice(prefix.length) : null;
  }

  private settle(job: Job, value: string | null): void {
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = undefined;
    }
    if (job.controller) {
      job.controller.abort();
      job.controller = undefined;
    }
    job.resolve(value);
  }

  private async fireJob(job: Job): Promise<void> {
    const controller = new AbortController();
    job.controller = controller;
    try {
      const fullText = await this.fetchOnce(job, controller.signal);
      job.resolve(fullText);
    } catch {
      job.resolve(null);
    } finally {
      if (job.controller === controller) job.controller = undefined;
      // 仅当仍是当前任务时才删除（可能已被 cancel 清走、新任务占用了同 key）
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    }
  }

  /** 真正发起 HTTP 请求；返回完整补全文本（含前缀），失败/取消返回 null */
  private async fetchOnce(job: Job, signal: AbortSignal): Promise<string | null> {
    const document = job.context.document;
    const position = job.context.position;
    const wordStart = getWordStart(document, position);
    const prefix = getCurrentPrefix(document, position, wordStart);
    const language = document.languageId || 'plaintext';

    const offset = document.offsetAt(position);
    const beforeLen = Math.min(Settings.completionContextBeforeChars, offset);
    const codeBefore = document.getText(
      new vscode.Range(document.positionAt(offset - beforeLen), position)
    );
    const afterLen = Math.min(
      Settings.completionContextAfterChars,
      document.offsetAt(new vscode.Position(document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)) - offset
    );
    const codeAfter = document.getText(
      new vscode.Range(position, document.positionAt(offset + afterLen))
    );
    if (signal.aborted) return null;

    ChatPanelProvider.instance?.reportCompRequest();

    // 实际发送的 prompt（buildCompletionPrompt 内部有截断）用于无 usage 时的估算
    const sentMessages = openAIClient.buildCompletionPrompt(codeBefore, codeAfter, language);
    const promptEstimate = sentMessages.reduce((n, m) => n + estimateTokens(m.content), 0);

    let content = '';
    let usage: TokenUsage | null = null;
    try {
      const result = await openAIClient.getCompletion(codeBefore, codeAfter, language, signal);
      content = result.content;
      usage = result.usage;
    } catch {
      // 失败 / 取消：输入侧已被计费，照常入账
      ChatPanelProvider.instance?.reportCompTokens(promptEstimate, 0);
      return null;
    }
    if (signal.aborted) {
      ChatPanelProvider.instance?.reportCompTokens(
        usage?.promptTokens ?? promptEstimate,
        usage?.completionTokens ?? 0
      );
      return null;
    }

    const cleaned = cleanCompletion(content, codeBefore, codeAfter, language, Settings.completionMaxLines);

    // 无论结果最终是否被采用（清洗丢弃 / 越界截断），本次 API 消耗都要入账
    const promptTok = usage?.promptTokens ?? promptEstimate;
    const compTok = usage?.completionTokens ?? estimateTokens(content);
    ChatPanelProvider.instance?.reportCompTokens(promptTok, compTok);

    if (!cleaned) return null;

    // 缓存存完整文本（含前缀），供同一单词后续输入复用
    const fullText = cleaned.startsWith(prefix) ? cleaned : prefix + cleaned;
    this.cacheSet(job.key, fullText);
    return fullText;
  }

  private cacheSet(key: string, fullText: string): void {
    this.cache.set(key, { fullText, createdAt: Date.now() });
    if (this.cache.size > CACHE_MAX) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
  }
}

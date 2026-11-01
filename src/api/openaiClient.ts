import * as https from 'https';
import * as http from 'http';
import { StringDecoder } from 'string_decoder';
import { URL } from 'url';
import { Settings } from '../config/settings';

/**
 * Chat Message 类型定义（OpenAI 兼容格式）
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Chat Completion 请求参数
 */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stop?: string[];
}

/**
 * Chat Completion 响应中的 Choice
 */
export interface ChatChoice {
  index: number;
  message?: {
    role: string;
    content: string;
  };
  delta?: {
    role?: string;
    content?: string;
  };
  finish_reason: string | null;
}

/**
 * 流式响应增量回调
 */
export type StreamChunkCallback = (content: string) => void;

/** 对话 token 统计回调：缓存命中 / 未命中 / 输出 */
export type ChatTokenCallback = (
  cachedPromptTokens: number,
  uncachedPromptTokens: number,
  completionTokens: number
) => void;

/** 提供商返回的单次请求用量（OpenAI 兼容 usage 字段） */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** 缓存命中的输入 token（prompt_tokens_details.cached_tokens，部分提供商支持） */
  cachedPromptTokens?: number;
}

/** 解析 OpenAI 兼容 usage；无法识别返回 null */
function normalizeUsage(raw: any): TokenUsage | null {
  if (!raw || typeof raw.prompt_tokens !== 'number') return null;
  const u: TokenUsage = {
    promptTokens: raw.prompt_tokens,
    completionTokens: typeof raw.completion_tokens === 'number' ? raw.completion_tokens : 0,
  };
  const cached = raw.prompt_tokens_details?.cached_tokens
    ?? raw.cached_tokens
    ?? raw.prompt_cache_hit_tokens; // DeepSeek 兼容
  if (typeof cached === 'number') u.cachedPromptTokens = cached;
  return u;
}

/** 非流式请求结果：内容 + 提供商用量（不支持时为 null） */
export interface CompletionResult {
  content: string;
  usage: TokenUsage | null;
}

/**
 * 估算 token 数（混合中英文）
 */
export function estimateTokens(text: string): number {
  let cn = 0, en = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) { cn++; }
    // 空格/Tab 参与计费（缩进也是 token），仅换行忽略
    else if (ch !== '\n' && ch !== '\r') { en++; }
  }
  return Math.max(1, Math.round(cn / 1.5 + en / 4));
}

/**
 * OpenAI 兼容 API 客户端
 *
 * 支持：
 * - 非流式请求（用于代码补全）
 * - 流式请求（SSE，用于聊天对话）
 * - 自定义 API Base URL（兼容第三方 API 代理）
 */
export class OpenAIClient {
  /** 对话用 */
  private chatBaseUrl: string;
  private chatApiKey: string;
  /** 补全用 */
  private compBaseUrl: string;
  private compApiKey: string;
  /** 思考参数格式 */
  private chatThinkFmt: string;
  private compThinkFmt: string;
  /** 是否启用 */
  private chatThink: boolean;
  /** Token 统计回调 */
  private _onTokenCount: ChatTokenCallback | null = null;

  constructor() {
    this.chatBaseUrl = Settings.apiBaseUrl;
    this.chatApiKey = Settings.apiKey;
    this.compBaseUrl = Settings.completionApiBaseUrl;
    this.compApiKey = Settings.completionApiKey;
    this.chatThinkFmt = Settings.chatThinkingFormat;
    this.compThinkFmt = Settings.completionThinkingFormat;
    this.chatThink = Settings.chatThinkingEnabled;
  }

  refreshConfig(): void {
    this.chatBaseUrl = Settings.apiBaseUrl;
    this.chatApiKey = Settings.apiKey;
    this.compBaseUrl = Settings.completionApiBaseUrl;
    this.compApiKey = Settings.completionApiKey;
    this.chatThinkFmt = Settings.chatThinkingFormat;
    this.compThinkFmt = Settings.completionThinkingFormat;
    this.chatThink = Settings.chatThinkingEnabled;
  }

  /** 设置对话 token 统计回调 */
  setTokenCallback(cb: ChatTokenCallback | null): void {
    this._onTokenCount = cb;
  }

  /** 根据格式构建思考模式参数 */
  private buildThinkingBody(fmt: string, enabled: boolean): Record<string, any> | null {
    if (fmt === 'none') return null;
    if (fmt === 'qwen') return { chat_template_kwargs: { enable_thinking: enabled } };
    if (fmt === 'ollama') return { think: enabled };
    if (fmt === 'anthropic') return { extra_body: { thinking: { type: enabled ? 'enabled' : 'disabled' } } };
    // minimax / default
    return { extra_body: { thinking: enabled } };
  }

  /** 拼装 URL（传入不带协议的基础 URL） */
  private buildUrl(base: string, endpoint: string): URL {
    if (!base.endsWith('/')) base += '/';
    return new URL(endpoint, base);
  }

  /** 发起 HTTP POST 请求 */
  private async httpPost(
    baseUrl: string, apiKey: string, endpoint: string,
    bodyObj: Record<string, any>,
    expectStream: boolean,
    onChunk?: StreamChunkCallback,
    abortSignal?: AbortSignal,
    timeoutMs: number = 30000,
    onUsage?: (u: TokenUsage) => void,
    onReasoning?: (s: string) => void
  ): Promise<string> {
    const url = this.buildUrl(baseUrl, endpoint);
    const isHttps = url.protocol === 'https:';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': '',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body = JSON.stringify(bodyObj);
    headers['Content-Length'] = String(Buffer.byteLength(body));

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    };

    return new Promise((resolve, reject) => {
      // 请求发出前信号已中止 → 直接失败，避免监听不到状态变化
      if (abortSignal?.aborted) {
        reject(new Error('请求已被取消'));
        return;
      }
      const req = (isHttps ? https : http).request(options, (res) => {
        // 响应中途连接异常（如被重置）：没有监听器会变成未捕获异常
        res.on('error', (e: Error) => reject(new Error(`网络请求失败: ${e.message}`)));

        if (!expectStream) {
          // 以 Buffer 收集后再统一解码，避免多字节字符（中文）跨 chunk 被截断
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
          res.on('end', () => {
            const data = Buffer.concat(chunks).toString('utf-8');
            if (res.statusCode !== 200) {
              let em = `API 请求失败 (${res.statusCode})`;
              try { const eb = JSON.parse(data); em = eb.error?.message || em; } catch {}
              reject(new Error(em));
              return;
            }
            try {
              const resp = JSON.parse(data);
              if (onUsage && resp.usage) {
                const u = normalizeUsage(resp.usage);
                if (u) onUsage(u);
              }
              const content = resp.choices?.[0]?.message?.content;
              if (!content) { reject(new Error('API 返回的内容为空')); return; }
              resolve(content);
            } catch (e) { reject(new Error(`解析失败: ${(e as Error).message}`)); }
          });
          return;
        }

        // 流式
        if (res.statusCode !== 200) {
          const errChunks: Buffer[] = [];
          res.on('data', (c: Buffer) => { errChunks.push(c); });
          res.on('end', () => {
            const data = Buffer.concat(errChunks).toString('utf-8');
            let em = `API 请求失败 (${res.statusCode})`;
            try { const eb = JSON.parse(data); em = eb.error?.message || em; } catch {}
            reject(new Error(em));
          });
          return;
        }

        // StringDecoder 处理跨 chunk 的多字节字符
        const decoder = new StringDecoder('utf-8');
        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += decoder.write(chunk);
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (onUsage && parsed.usage) {
                const u = normalizeUsage(parsed.usage);
                if (u) onUsage(u);
              }
              const delta = parsed.choices?.[0]?.delta;
              const c = delta?.content;
              if (c && onChunk) onChunk(c);
              const rc = delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking;
              if (rc && onReasoning) onReasoning(rc);
            } catch {}
          }
        });
        res.on('end', () => {
          buffer += decoder.end();
          if (buffer.trim()) {
            const t = buffer.trim();
            if (t.startsWith('data: ') && t.slice(6) !== '[DONE]') {
              try {
                const parsed = JSON.parse(t.slice(6));
                if (onUsage && parsed.usage) {
                  const u = normalizeUsage(parsed.usage);
                  if (u) onUsage(u);
                }
                const delta = parsed.choices?.[0]?.delta;
                const c = delta?.content;
                if (c && onChunk) onChunk(c);
                const rc = delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking;
                if (rc && onReasoning) onReasoning(rc);
              } catch {}
            }
          }
          resolve('');
        });
      });

      req.on('error', (e: Error) => reject(new Error(`网络请求失败: ${e.message}`)));

      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('请求已被取消'));
        }, { once: true });
      }

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error(`请求超时（${timeoutMs / 1000}秒）`));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * 非流式请求 — 补全用（禁用思考模式）
   */
  private async completionRequest(request: ChatCompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const bodyObj: Record<string, any> = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.max_tokens ?? Settings.maxTokens,
      temperature: request.temperature ?? Settings.temperature,
      stream: false,
      stop: request.stop,
    };
    const thinkBody = this.buildThinkingBody(this.compThinkFmt, false);
    if (thinkBody) Object.assign(bodyObj, thinkBody);
    const usageRef: { value: TokenUsage | null } = { value: null };
    const result = await this.httpPost(this.compBaseUrl, this.compApiKey, 'chat/completions', bodyObj, false, undefined, signal, 15000, (u) => { usageRef.value = u; });
    return { content: result, usage: usageRef.value };
  }

  /**
   * 流式请求 — 对话用（按配置开关思考模式）
   */
  private async chatStreamRequest(
    request: ChatCompletionRequest,
    onChunk: StreamChunkCallback,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const bodyObj: Record<string, any> = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.max_tokens ?? 2048,
      temperature: request.temperature ?? 0.7,
      stream: true,
      stream_options: { include_usage: true },
      stop: request.stop,
    };
    const thinkBody = this.buildThinkingBody(this.chatThinkFmt, this.chatThink);
    if (thinkBody) Object.assign(bodyObj, thinkBody);
    // 包装回调以累积完整输出（思考内容供无 usage 时回退估算）
    let full = '';
    let reasoning = '';
    const usageRef: { value: TokenUsage | null } = { value: null };
    const wrappedChunk: StreamChunkCallback = (content) => {
      full += content;
      onChunk(content);
    };
    try {
      await this.httpPost(
        this.chatBaseUrl, this.chatApiKey, 'chat/completions', bodyObj, true,
        wrappedChunk, abortSignal, 60000,
        (u) => { usageRef.value = u; },
        (r) => { reasoning += r; }
      );
    } finally {
      // 无论成功、取消还是失败，本次请求的消耗都要入账：
      // 优先用提供商返回的真实 usage，取不到再回退本地估算
      if (this._onTokenCount) {
        const sysMsg = request.messages.find(m => m.role === 'system');
        const nonSysText = request.messages.filter(m => m.role !== 'system').map(m => m.content).join('');
        const sysEst = sysMsg ? estimateTokens(sysMsg.content) : 0;
        const usage = usageRef.value;
        if (usage) {
          const cached = usage.cachedPromptTokens !== undefined
            ? usage.cachedPromptTokens
            : Math.min(sysEst, usage.promptTokens);
          this._onTokenCount(cached, usage.promptTokens - cached, usage.completionTokens);
        } else {
          this._onTokenCount(sysEst, estimateTokens(nonSysText), estimateTokens(full + reasoning));
        }
      }
    }
  }

  // ===== 兼容旧接口（内部委托到上述两个方法）=====

  /** @deprecated 使用 completionRequest */
  async chatCompletion(request: ChatCompletionRequest): Promise<string> {
    return (await this.completionRequest(request)).content;
  }

  /** @deprecated 使用 chatStreamRequest */
  async streamChatCompletion(
    request: ChatCompletionRequest,
    onChunk: StreamChunkCallback,
    abortSignal?: AbortSignal
  ): Promise<void> {
    return this.chatStreamRequest(request, onChunk, abortSignal);
  }

  /**
   * 构建代码补全 Prompt
   *
   * 旧版用 `<FILL_HERE>` 文本标记，chat 模型不理解该格式，容易复述上下文、
   * 输出整段无关代码。现改为显式指令 + 游标标记，并明确行数上限。
   */
  buildCompletionPrompt(codeBefore: string, codeAfter: string, language: string): ChatMessage[] {
    // 更小上下文 → 更快推理
    const truncBefore = codeBefore.length > 300 ? codeBefore.slice(-300) : codeBefore;
    const truncAfter = codeAfter.length > 80 ? codeAfter.slice(0, 80) : codeAfter;

    const systemPrompt = [
      '你是一个代码补全引擎。你的唯一任务是在光标处续写代码。',
      '严格遵守以下规则：',
      `1. 只输出需要插入的续写代码，最多 ${Settings.completionMaxLines} 行，在语义完整处尽早结束；`,
      '2. 不要重复上下文中已存在的任何代码（包括光标前和光标后的内容）；',
      '3. 光标后若已有右括号、右大括号、引号、分号等配对符号，不要重复输出它们；',
      '4. 光标后已有区域边界（右括号、右大括号、右引号等）时，补全必须完整落在边界之内，不要越过边界；',
      '5. 不要输出 Markdown 代码块标记、解释说明或任何多余文本；',
      '6. 严格保持光标处的缩进和代码风格。',
    ].join('\n');
    const userPrompt = `在 <|CURSOR|> 处续写 ${language} 代码，只输出续写部分：\n\n<|BEFORE|>\n${truncBefore}\n<|CURSOR|>\n${truncAfter}\n<|AFTER|>`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
  }

  /**
   * 代码补全请求（signal 用于在用户继续输入时真正中止底层 HTTP 请求）
   */
  async getCompletion(
    codeBefore: string,
    codeAfter: string,
    language: string,
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    const messages = this.buildCompletionPrompt(codeBefore, codeAfter, language);

    return this.completionRequest({
      model: Settings.completionModel,
      messages,
      max_tokens: Settings.completionMaxTokens,
      temperature: Settings.completionTemperature,
    }, signal);
  }

  /**
   * 代码解读 Prompt
   */
  buildExplainPrompt(code: string, language: string, context: string): ChatMessage[] {
    const systemPrompt = '你是一个资深的代码审查专家和编程导师，擅长用清晰易懂的语言解释代码。';
    const userPrompt = `请解读以下${language}代码：

${context}

\`\`\`${language}
${code}
\`\`\`

请从以下几个方面进行解读：
1. **整体功能**：这段代码的主要目的是什么？
2. **关键逻辑**：核心的实现逻辑是怎样的？
3. **值得注意的地方**：有哪些需要特别注意的细节或潜在问题？
4. **优化建议**（可选）：有没有可以改进的地方？`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
  }
}

/** 全局单例 */
export const openAIClient = new OpenAIClient();

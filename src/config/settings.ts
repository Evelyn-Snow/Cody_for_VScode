import * as vscode from 'vscode';

/**
 * 插件配置管理
 * 从 VSCode 设置中读取和管理所有配置项
 */
export class Settings {
  /**
   * 获取对话 API 基础 URL
   */
  static get apiBaseUrl(): string {
    return vscode.workspace.getConfiguration('aiAssistant').get<string>('apiBaseUrl', 'http://localhost:8000/v1');
  }

  /**
   * 获取对话 API Key
   */
  static get apiKey(): string {
    const envKey = process.env.OPENAI_API_KEY;
    if (envKey) { return envKey; }
    return vscode.workspace.getConfiguration('aiAssistant').get<string>('apiKey', '');
  }

  /**
   * 补全专用 API URL（留空则回落对话 URL）
   */
  static get completionApiBaseUrl(): string {
    const val = vscode.workspace.getConfiguration('aiAssistant').get<string>('completionApiBaseUrl', '');
    return val || this.apiBaseUrl;
  }

  /**
   * 补全专用 API Key（留空则回落对话 Key）
   */
  static get completionApiKey(): string {
    const val = vscode.workspace.getConfiguration('aiAssistant').get<string>('completionApiKey', '');
    return val || this.apiKey;
  }

  /**
   * 对话思考模式参数格式
   */
static get chatThinkingFormat(): 'minimax' | 'qwen' | 'ollama' | 'anthropic' | 'none' {
    return vscode.workspace.getConfiguration('aiAssistant').get<'minimax' | 'qwen' | 'ollama' | 'anthropic' | 'none'>('chatThinkingFormat', 'minimax');
  }

  /**
   * 对话是否启用思考模式
   */
  static get chatThinkingEnabled(): boolean {
    return vscode.workspace.getConfiguration('aiAssistant').get<boolean>('chatThinkingEnabled', true);
  }

  /**
   * 补全思考模式参数格式
   */
  static get completionThinkingFormat(): 'minimax' | 'qwen' | 'ollama' | 'anthropic' | 'none' {
    return vscode.workspace.getConfiguration('aiAssistant').get<'minimax' | 'qwen' | 'ollama' | 'anthropic' | 'none'>('completionThinkingFormat', 'minimax');
  }

  /**
   * 代码补全模型
   */
  static get completionModel(): string {
    return vscode.workspace.getConfiguration('aiAssistant').get<string>('completionModel', 'MiniMax-M2.5-test');
  }

  /**
   * 对话模型
   */
  static get chatModel(): string {
    return vscode.workspace.getConfiguration('aiAssistant').get<string>('chatModel', 'MiniMax-M2.5-test');
  }

  /**
   * 最大 token 数（代码补全用）
   */
  static get maxTokens(): number {
    return vscode.workspace.getConfiguration('aiAssistant').get<number>('maxTokens', 1024);
  }

  /**
   * Agent 模式每次 API 请求的最大 token 数
   */
  static get agentMaxTokens(): number {
    return vscode.workspace.getConfiguration('aiAssistant').get<number>('agentMaxTokens', 8000);
  }

  /**
   * Agent 模式 temperature
   */
  static get agentTemperature(): number {
    return vscode.workspace.getConfiguration('aiAssistant').get<number>('agentTemperature', 0.2);
  }

  /**
   * Temperature 参数
   */
  static get temperature(): number {
    return vscode.workspace.getConfiguration('aiAssistant').get<number>('temperature', 0.3);
  }

  /**
   * 是否启用代码补全
   */
  static get enableCompletion(): boolean {
    return vscode.workspace.getConfiguration('aiAssistant').get<boolean>('enableCompletion', true);
  }

  /**
   * 补全模式：inline | dropdown | both
   */
  static get completionMode(): 'inline' | 'dropdown' | 'both' {
    return vscode.workspace.getConfiguration('aiAssistant').get<'inline' | 'dropdown' | 'both'>('completionMode', 'both');
  }

  /** inline 模式是否激活 */
  static get isInlineMode(): boolean {
    return this.completionMode === 'inline' || this.completionMode === 'both';
  }

  /** dropdown 模式是否激活 */
  static get isDropdownMode(): boolean {
    return this.completionMode === 'dropdown' || this.completionMode === 'both';
  }

  /**
   * 代码补全防抖延迟
   */
  static get completionDebounceMs(): number {
    return vscode.workspace.getConfiguration('aiAssistant').get<number>('completionDebounceMs', 500);
  }

  /**
   * 补全触发的最小前缀字符数
   */
  static get completionMinPrefix(): number {
    return vscode.workspace.getConfiguration('aiAssistant').get<number>('completionMinPrefix', 2);
  }

  /**
   * 补全上下文窗口：光标前字符数
   */
  static get completionContextBeforeChars(): number {
    return vscode.workspace.getConfiguration('aiAssistant').get<number>('completionContextBeforeChars', 800);
  }

  /**
   * 补全上下文窗口：光标后字符数
   */
  static get completionContextAfterChars(): number {
    return vscode.workspace.getConfiguration('aiAssistant').get<number>('completionContextAfterChars', 80);
  }

  /**
   * 补全单次请求的最大输出 token 数（硬上限，防止一次生成一大段）
   */
  static get completionMaxTokens(): number {
    return vscode.workspace.getConfiguration('aiAssistant').get<number>('completionMaxTokens', 128);
  }

  /**
   * 补全结果最多保留的行数（超出截断到语义完整的行）
   */
  static get completionMaxLines(): number {
    return vscode.workspace.getConfiguration('aiAssistant').get<number>('completionMaxLines', 5);
  }

  /**
   * 补全专用 temperature（低于对话温度，结果更稳定、更少幻觉）
   */
  static get completionTemperature(): number {
    return vscode.workspace.getConfiguration('aiAssistant').get<number>('completionTemperature', 0.1);
  }

  /**
   * Assistant / Agent 共用的系统 Prompt
   */
  static get chatSystemPrompt(): string {
    return vscode.workspace.getConfiguration('aiAssistant').get<string>(
      'chatSystemPrompt',
      '你是 Cody，一个专业的编程助手，内嵌在 VSCode 编辑器中。请用中文回答问题，提供准确、有帮助的编程建议。回答时可以使用 Markdown 格式，代码块请标注语言。'
    );
  }

  /** Agent 编辑模式：'normal' 审批后执行 | 'fast' 直接执行 */
  static get agentEditMode(): 'normal' | 'fast' {
    return vscode.workspace.getConfiguration('aiAssistant').get<'normal' | 'fast'>('agentEditMode', 'normal');
  }

  static async setAgentEditMode(mode: 'normal' | 'fast'): Promise<void> {
    await this.set('agentEditMode', mode);
  }

  /** Agent 最大操作轮数 */
  static get maxAgentRounds(): number {
    return vscode.workspace.getConfiguration('aiAssistant').get<number>('maxAgentRounds', 10);
  }

  /**
   * 写入配置项。value 为 undefined 时清除用户覆盖，回退到 package.json 默认值。
   */
  static async set(key: string, value: any): Promise<void> {
    await vscode.workspace.getConfiguration('aiAssistant').update(key, value, vscode.ConfigurationTarget.Global);
  }

  /**
   * 验证 API Key 是否已配置
   */
  static hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }
}

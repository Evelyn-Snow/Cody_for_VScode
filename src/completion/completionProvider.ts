import * as vscode from 'vscode';
import { Settings } from '../config/settings';
import { CompletionEngine } from './completionEngine';

// 兼容 VSCode <1.68
const _v = vscode as any;
const InlineCompletionItem: any = _v.InlineCompletionItem ?? (function dummy() {});
const InlineCompletionTriggerKindInvoke = _v.InlineCompletionTriggerKind?.Invoke ?? 0;

/**
 * inline 幽灵文字补全 Provider
 *
 * 全部请求管理下沉到 CompletionEngine：
 * - 防抖 / 单飞 / 真实取消（换词时 abort 在途 HTTP）
 * - 与 dropdown Provider 共享同一缓存与在途请求，同一击键不会打两次 API
 */
export class CompletionProvider {
  private isEnabled: boolean = true;

  constructor(private engine: CompletionEngine) {}

  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: any,
    token: vscode.CancellationToken
  ): Promise<any[]> {
    if (!this.isEnabled || !Settings.isInlineMode) return [];

    // Invoke（手动触发）跳过防抖立即请求；Automatic 走防抖
    const triggerKind = context?.triggerKind;
    const immediate = triggerKind === InlineCompletionTriggerKindInvoke;

    // 注意：不把 token 取消接到 engine.cancelUri —— 共享任务还要喂给 dropdown
    // 的缓存。token 取消只意味着本次 inline 展示作废，VSCode 会自动丢弃结果。
    const text = await this.engine.request(document, position, { immediate });
    if (token.isCancellationRequested || !text) return [];

    const item = new (InlineCompletionItem)(text, new vscode.Range(position, position));
    return [item];
  }
}

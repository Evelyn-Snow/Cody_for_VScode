import * as vscode from 'vscode';
import { CompletionProvider } from './completion/completionProvider';
import { DropdownCompletionProvider } from './completion/dropdownProvider';
import { CompletionEngine } from './completion/completionEngine';
import { ChatPanelProvider } from './chat/chatPanel';
import { registerExplainCommands } from './commands/explainCommands';
import { openAIClient } from './api/openaiClient';
import { Settings } from './config/settings';
import { SkillManager } from './skills/skillManager';

/**
 * Cody for VSCode - 扩展入口
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('[Cody] 插件已激活');

  // ========== 0. 初始化 SkillManager ==========
  const skillManager = new SkillManager(context);

  // ========== 1. 初始化聊天面板 Provider ==========
  const chatPanelProvider = new ChatPanelProvider(context, skillManager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatPanelProvider.viewType,
      chatPanelProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ========== 2. 注册双模补全（共享统一 CompletionEngine） ==========
  const documentSelector: vscode.DocumentSelector = [
    { scheme: 'file', language: '*' },
    { scheme: 'untitled', language: '*' },
  ];

  const completionEngine = new CompletionEngine();
  context.subscriptions.push(completionEngine);

  // 2a. Inline 幽灵文字补全（需要 VSCode 1.68+）
  const inlineProvider = new CompletionProvider(completionEngine);
  const _languages = vscode.languages as any;
  if (_languages.registerInlineCompletionItemProvider) {
    context.subscriptions.push(
      _languages.registerInlineCompletionItemProvider(documentSelector, inlineProvider)
    );
    console.log('[Cody] Inline 补全已注册 (VSCode ≥1.68)');
  } else {
    console.log('[Cody] Inline 补全跳过（需要 VSCode ≥1.68，当前版本不支持）');
  }

  const dropdownProvider = new DropdownCompletionProvider(completionEngine);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      documentSelector,
      dropdownProvider,
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.'.split('')
    )
  );

  // ========== 3. 注册命令 ==========
  const commandDisposables = registerExplainCommands(context, chatPanelProvider);
  context.subscriptions.push(...commandDisposables);

  // SKILL 导入命令
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.importSkill', async () => {
      const result = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Skill 文件': ['md', 'txt', 'skill'], '所有文件': ['*'] },
        title: '选择要导入的 SKILL 文件',
      });
      if (result && result[0]) {
        try {
          const skill = await skillManager.importFromFile(result[0].fsPath);
          vscode.window.showInformationMessage(`✅ SKILL "${skill.name}" 已导入`);
          chatPanelProvider.sendSkillsToWebview();
        } catch (e: any) {
          vscode.window.showErrorMessage(`导入 SKILL 失败: ${e.message}`);
        }
      }
    })
  );

  // ========== 4. 监听配置变更 ==========
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiAssistant')) {
        openAIClient.refreshConfig();
        const enabled = Settings.enableCompletion;
        inlineProvider.setEnabled(enabled);
        completionEngine.clearCache();
      }
    })
  );

  // ========== 5. 状态栏 ==========
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'aiAssistant.openChat';
  statusBarItem.text = '$(hubot) Cody';
  statusBarItem.tooltip = '打开 Cody 对话面板';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  console.log('[Cody] 初始化完成');
}

export function deactivate() {
  console.log('[Cody] 插件已停用');
}

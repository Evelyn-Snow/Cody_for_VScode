import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 聊天面板 Webview HTML 内容生成器
 *
 * 从 chat.html 读取 HTML 模板，
 * 嵌入 chat.js 的脚本逻辑，
 * 注入 CSP nonce 安全策略。
 */
export function getChatWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();

  // 读取 HTML 模板（打包后从 out/ 加载）
  const htmlPath = path.join(extensionUri.fsPath, 'out', 'chat', 'chat.html');
  let html = fs.readFileSync(htmlPath, 'utf-8');

  // 读取 JS 脚本（打包后从 out/ 加载）
  const jsPath = path.join(extensionUri.fsPath, 'out', 'chat', 'chat.js');
  let js = fs.readFileSync(jsPath, 'utf-8');

  // 注入 CSP 的 nonce
  html = html.replace(
    /<meta http-equiv="Content-Security-Policy".*?>/,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: https:;">`
  );

  // 替换脚本占位符。
  // 用函数形式替换：字符串形式会解释替换串中的 $&、$' 等特殊序列，
  // 而 chat.js 源码中出现这些序列时会破坏注入结果；
  // 同时转义 </script>，避免脚本内容提前终止 <script> 标签。
  const safeJs = js.replace(/<\/script>/gi, '<\\/script>');
  html = html.replace(
    /<script src="##NONCE_PLACEHOLDER##">[\s\S]*?<\/script>/,
    () => `<script nonce="${nonce}">${safeJs}</script>`
  );

  return html;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 64; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

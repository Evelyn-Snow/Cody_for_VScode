/**
 * 补全结果清洗模块 — 提供 inline & dropdown 共用
 *
 * 策略（由弱到强）：
 * 1. Markdown code fence 去除
 * 2. 去掉与 codeBefore 尾部重复的开头（逐字符比对）
 * 3. 已有区域边界（光标后紧跟闭合符）→ 补全不得越界，在首个越界闭合符处截断
 * 4. 补全尾部与 codeAfter 开头逐字符重叠 → 切除（重复输出已有配对符号 / 已有对应内容）
 * 5. 去掉尾部闭合符号后整体是 codeAfter 开头 → 内容已存在，丢弃
 * 6. 将补全结果中与 codeBefore 已存在的行全部切除
 * 7. 补全里出现 codeAfter 的行（含纯闭合行 } }; 等）→ 从该行起截断
 * 8. 去掉纯空白 / 过短的无效结果
 * 9. 补全整体是前后文的逐字复制 → 丢弃
 * 10. 截断到 maxLines 行内最后一个语义完整的行
 * 11. 最终验证：若结果与现有上下文高度重叠（>70%），丢弃
 */

/**
 * 清洗一条 AI 补全结果。
 * @param maxLines 最多保留的行数（截断到该窗口内最后一个语义完整的行）
 * @returns 清洗后的文本，或 null 表示应丢弃
 */
export function cleanCompletion(
  completion: string,
  codeBefore: string,
  codeAfter: string,
  _language?: string,
  maxLines: number = 5
): string | null {
  // ===== 0. 原始清洗 =====
  let text = completion;

  // 去掉 markdown 代码块标记
  text = text.replace(/^```[\w]*\n?/g, '').replace(/\n?```$/g, '');
  text = text.trim();
  if (text.length === 0) return null;

  // ===== 1. 逐字符去掉与 codeBefore 重叠的开头 =====
  text = stripLeadingOverlap(text, codeBefore);

  // ===== 2. 已有区域边界 → 补全不得越过边界 =====
  text = trimAtBoundary(text, codeAfter);

  // ===== 3. 补全尾部与 codeAfter 开头重叠 → 切除 =====
  text = trimDuplicatedSuffix(text, codeBefore, codeAfter);

  // ===== 4. 去掉尾部闭合符号后整体是 codeAfter 开头 → 内容已存在，丢弃 =====
  if (isEchoOfAfter(text, codeAfter)) return null;

  // ===== 5. 切除已存在于上下文中的完整行 =====
  text = stripExistingLinesAggressive(text, codeBefore);

  // ===== 6. 补全中出现 codeAfter 的行 → 截断 =====
  text = trimAtCodeAfterStart(text, codeAfter);

  // ===== 7. 去空白 / 过短拒绝 =====
  text = text.trim();
  if (text.length === 0) return null;
  if (/^[\s\t\n\r]+$/.test(text)) return null;
  // 拒绝仅 1 个字符且非配对符号
  if (text.length <= 1 && !/[)\]\}"'` ]$/.test(text)) return null;

  // ===== 8. 整体为前后文逐字复制 → 丢弃 =====
  if (isVerbatimEcho(text, codeBefore, codeAfter)) return null;

  // ===== 9. 截断到 maxLines 行内最后一个语义完整的行 =====
  text = truncateToCompleteBlock(text, maxLines);
  if (!text) return null;

  // ===== 10. 若清洗后的结果与 codeBefore 后半部分高度重叠，丢弃 =====
  if (isDuplicateOfContext(text, codeBefore)) return null;

  return text;
}

// ============================================================
//  内部函数
// ============================================================

/**
 * 逐字符去掉补全开头与 codeBefore 尾部重叠的部分。
 * 例如 codeBefore="console.log(" 补全="console.log('hello')" → "('hello')"
 */
function stripLeadingOverlap(text: string, codeBefore: string): string {
  const tail = codeBefore.length > 300 ? codeBefore.slice(-300) : codeBefore;
  let maxMatch = 0;

  // 从最长可能匹配开始（取 min(text, tail)）
  for (let i = Math.min(text.length, tail.length); i > 0; i--) {
    const tailEnd = tail.slice(-i);
    const textStart = text.slice(0, i);
    if (tailEnd === textStart) {
      maxMatch = i;
      break;
    }
  }

  if (maxMatch > 0) {
    return text.slice(maxMatch);
  }
  return text;
}

/**
 * 已有区域边界（光标后第一个非空白字符是闭合符）→ 补全不得越过该边界。
 *
 * 在补全文本中找到第一个「越界闭合符」并在此截断：
 * - 边界是 ) ] }：该符号出现时，若补全中此前没有配对的左符（深度为 0），
 *   说明它闭合的是用户已有区域 → 越界；
 * - 边界是引号（" ' `）：用户字符串已开启，补全中第一个未转义的同类引号
 *   即闭合它 → 越界。
 *
 * 扫描时跳过字符串字面量（避免误切 "a)b" 里的 )）并处理转义。
 * 例：前文 "foo(" + 后文 ")" + 补全 "x);\nconst y = foo(2)"
 *     → 第一个 ")" 深度为 0 → 截断为 "x"，不再把后面的语句塞进已有括号里。
 * 宁可少、不可多：若边界内没有任何内容，返回空串由后续步骤丢弃。
 */
function trimAtBoundary(text: string, codeAfter: string): string {
  const after = codeAfter.trimStart();
  if (after.length === 0) return text;
  const b = after[0];
  if (!')]}'.includes(b) && b !== '"' && b !== "'" && b !== '`') return text;

  const open = b === ')' ? '(' : b === ']' ? '[' : b === '}' ? '{' : null;
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      // 字符串内：处理转义，等待闭合
      if (c === '\\') { i++; continue; }
      if (c === quote) { quote = null; }
      continue;
    }
    // 引号边界：\ 转义下一个字符；补全插入在用户已开启的字符串内
    if (!open && c === '\\') { i++; continue; }
    // 引号边界：首个未转义的同类引号即闭合用户字符串 → 越界
    if (!open && c === b) return text.slice(0, i).trimEnd();
    // 字符串字面量：跳过其内容（括号边界避免误切 "a)b" 里的 )）
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    // 括号边界：配对深度跟踪，深度为 0 时的闭合符即越界
    if (c === open) { depth++; continue; }
    if (c === b) {
      if (depth === 0) return text.slice(0, i).trimEnd(); // 越界
      depth--;
    }
  }
  return text;
}

/**
 * 补全尾部与 codeAfter 开头逐字符重叠 → 切掉重叠的尾部。
 *
 * 处理两类问题：
 * 1. 光标后已有配对符号，模型又重复输出：
 *    前文 "console.log(" + 后文 ")" + 补全 "'hello')" → 切掉尾部 ")" → "'hello'"
 * 2. 光标后已有部分对应内容，模型重新生成了一遍：
 *    前文 "foo(" + 后文 "a, b, c)" + 补全 "foo(a, b)" → 头部先切掉 "foo("，
 *    尾部 "a, b" 与后文开头完全一致 → 再切掉 → 整体为空（丢弃）。
 *
 * 比对时同时尝试原始 codeAfter 与去掉前导空白后的版本，
 * 取更长的匹配；重叠部分插入后必然与已有内容重复，切除总是安全的。
 */
function trimDuplicatedSuffix(text: string, codeBefore: string, codeAfter: string): string {
  const raw = codeAfter;
  const trimmed = codeAfter.trimStart();
  const candidates = raw !== trimmed ? [raw, trimmed] : [raw];
  let best = 0;
  for (const after of candidates) {
    const max = Math.min(text.length, after.length);
    for (let k = max; k > 0; k--) {
      if (text.endsWith(after.slice(0, k))) {
        best = Math.max(best, k);
        break;
      }
    }
  }
  if (best <= 0) return text;

  // 重叠部分以括号类闭合符开头时，按「文档级配平」决定切除数量：
  // 前文未闭合数 + 补全自身开符数 === 补全保留的闭符数 + 光标后供应的闭符数。
  // 例1 前文 "foo(" 后文 ")" 补全 "bar(1)"：前文未闭合 1，补全 1/1，后文供 1
  //     → 需切 0，保留模型自己的 ")"（它闭合 bar(，用户的闭合 foo(）。
  // 例2 前文 "x = " 后文 ")" 补全 "f({a: [1, 2]})"：前文未闭合 0
  //     → 需切 1，把尾部 ")" 让位给用户已有的 ")"。
  // 计数按结构进行（跳过字符串字面量），避免 call(")") 里的 ")" 被误算。
  const overlap = text.slice(text.length - best);
  const type = overlap[0];
  if (type === ')' || type === ']' || type === '}') {
    const open = type === ')' ? '(' : type === ']' ? '[' : '{';
    const textStats = countStructuralChars(text, open, type);
    const beforeStats = countStructuralChars(codeBefore, open, type);
    const beforeUnclosed = Math.max(0, beforeStats.opens - beforeStats.closes);
    let afterLead = 0;
    while (afterLead < trimmed.length && trimmed[afterLead] === type) afterLead++;
    let lead = 0;
    while (lead < overlap.length && overlap[lead] === type) lead++;
    const stripClosers = Math.min(
      lead,
      Math.max(0, textStats.closes + afterLead - beforeUnclosed - textStats.opens)
    );
    // 切除量 = 重叠串中的非闭合符部分 + 配平判定要切的闭合符数
    best = best - lead + stripClosers;
  }
  return best > 0 ? text.slice(0, text.length - best) : text;
}

/**
 * 统计文本中括号对的结构性数量，跳过字符串字面量及其转义。
 * 返回 { opens, closes }。
 */
function countStructuralChars(
  s: string,
  open: string,
  close: string
): { opens: number; closes: number } {
  let opens = 0;
  let closes = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) { quote = null; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === open) opens++;
    else if (c === close) closes++;
  }
  return { opens, closes };
}

/**
 * 补全去掉尾部闭合符号（) ] } " ' ` ; , 等）后，整体恰好是 codeAfter 开头的一部分 →
 * 说明模型把光标后已有的内容又生成了一遍，直接丢弃。
 * 例：前文 "foo(" + 后文 "a, b, c)" + 补全 "foo(a, b)" → 头部切掉 "foo(" 后剩 "a, b)"，
 *     去掉尾部 ")" 得 "a, b"，正是后文的开头 → 丢弃。
 * 纯闭合符号（如单个 ")"）不在此判断（交给尾部重叠切除处理）。
 */
function isEchoOfAfter(text: string, codeAfter: string): boolean {
  const after = codeAfter.trimStart();
  if (after.length === 0) return false;
  const t = text.trim();
  if (t.length === 0) return false;
  const core = t.replace(/[)\]}"'`;,]+$/, '');
  if (core.length === 0) return false;
  return after.startsWith(core);
}

/**
 * 切除补全中与 codeBefore 中已存在的整行。
 * 与旧版不同：检查补全的*每一行前 N 行*是否在 codeBefore 中出现过。
 */
function stripExistingLinesAggressive(completion: string, codeBefore: string): string {
  const compLines = completion.split('\n');
  const contextLines = codeBefore.split('\n');
  const contextSet = new Set(contextLines.map(l => l.trim()));

  if (contextSet.size === 0) return completion;

  // 从开头检查：连续匹配的行全部移除
  let stripFromStart = 0;
  for (let i = 0; i < compLines.length; i++) {
    const line = compLines[i].trim();
    // 空行：如果后续还有内容且下一行也匹配，也跳过；否则停止
    if (line.length === 0) {
      if (i + 1 < compLines.length && contextSet.has(compLines[i + 1].trim())) {
        stripFromStart = i + 1;
        continue;
      }
      break;
    }
    if (contextSet.has(line)) {
      stripFromStart = i + 1;
    } else {
      break;
    }
  }

  return stripFromStart > 0 ? compLines.slice(stripFromStart).join('\n') : completion;
}

/**
 * 补全里出现了 codeAfter 的行 → 说明模型把光标后已有的代码又写了一遍，
 * 从第一个这样的行开始截断。
 * 普通行要求长度 ≥ 4 且整行一致（避免误伤碰巧相同的短词）；
 * 纯闭合行（} 、 }); 、 ] 等）长度不限，且允许互为前缀——
 * 例如后文是 "};" 而补全输出 "}" 时同样视为重复，忽略缩进差异。
 */
function trimAtCodeAfterStart(text: string, codeAfter: string): string {
  const afterLines = codeAfter.trimStart().split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .slice(0, 2);
  if (afterLines.length === 0) return text;

  const longLines = afterLines.filter(l => l.length >= 4);
  const closingLines = afterLines.filter(l => /^[)}\]]+;?$/.test(l));
  const closing = closingLines[0] || '';

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.length === 0) continue;
    const isLong = longLines.includes(t);
    const isClosing = closing.length > 0
      && /^[)}\]]+;?$/.test(t)
      && (t === closing || closing.startsWith(t) || t.startsWith(closing));
    if (isLong || isClosing) {
      if (i === 0) return '';
      return lines.slice(0, i).join('\n').trimEnd();
    }
  }
  return text;
}

/**
 * 补全整体（去空白后）原样存在于 codeBefore 或 codeAfter 中 → 纯复制，丢弃。
 * 长度 ≥ 4 才判断，避免把 "){}" 这类通用短串误判为回声。
 */
function isVerbatimEcho(text: string, codeBefore: string, codeAfter: string): boolean {
  const t = text.trim();
  if (t.length < 4) return false;
  return codeBefore.includes(t) || codeAfter.includes(t);
}

/**
 * 截断到最多 maxLines 行内最后一个语义完整的行。
 * "完整" = 以 ; {} () ] > " ' ` 结尾，或以 : 结尾（Python/TS 冒号），
 * 或不以运算符结尾。
 */
function truncateToCompleteBlock(text: string, maxLines: number): string {
  const lines = text.split('\n');

  // 去尾部空行
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (lines.length === 0) return '';

  // 只看前 maxLines 行，超出的一律丢弃
  const max = Math.max(1, maxLines);
  const window = lines.slice(0, max);
  // 确实发生了截断（窗口外还有内容）→ 末行必须更严格
  const truncated = lines.length > window.length;

  // 窗口内从后往前找最后一个完整行 → 保证不留半截行
  for (let i = window.length - 1; i >= 0; i--) {
    const line = window[i].trimEnd();
    if (!isCompleteLine(line)) continue;
    // 被截断时，若窗口末行没有终结符（; {} ) ] > 等），说明是半截续行，继续回退
    if (truncated && i === window.length - 1 && !/[;{})\]>'"`:]$/.test(line)) continue;
    return window.slice(0, i + 1).join('\n');
  }
  // 没找到完整行 → 只保留第一行
  return window[0];
}

function isCompleteLine(line: string): boolean {
  if (line.length === 0) return true;
  // 以下列字符结尾 → 语义完整
  if (/[;{})\]>'"`]$/.test(line)) return true;
  // 冒号结尾（if/for/def/class: 等）
  if (line.endsWith(':')) return true;
  // 以运算符结尾 → 不完整（需要下一行）
  if (/[+\-*/%=<>!&|^~,]$/.test(line)) return false;
  // 其他 → 认为完整
  return true;
}

/**
 * 检查清洗后的结果是否本质上是 codeBefore 中已经存在的代码。
 * 简单的启发式：若清洗结果的所有行中存在 ≥70% 的行在上下文中出现，则丢弃。
 */
function isDuplicateOfContext(text: string, codeBefore: string): boolean {
  const compLines = text.split('\n').filter(l => l.trim().length > 0);
  if (compLines.length === 0) return true;

  const contextLines = codeBefore.split('\n');
  const contextSet = new Set(contextLines.map(l => l.trim()));

  let matched = 0;
  for (const line of compLines) {
    if (contextSet.has(line.trim())) {
      matched++;
    }
  }

  // 超过 70% 的行都是已有的 → 视为重复
  return compLines.length > 0 && (matched / compLines.length) > 0.7;
}

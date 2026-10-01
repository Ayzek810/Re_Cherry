/**
 * 不可信文本进受信提示边界前的规范化（V2 untrustedContent.ts 逐字移植）。
 *
 * 应用面（本仓）：ensureAgent 组装快照节时插入的模型/用户可写文本——技能名/描述、
 * 附件文档名、memory FACT.md 正文。这些值进入 system prompt 上下文节，若携带
 * 不可见字符或伪造的 </system-reminder> 闭合标签，可借受信边界越权发言。
 */
export function sanitizeUntrustedText(text: string): string {
  return stripInvisibleCharacters(text.replace(/＜|〈/g, '<').replace(/＞|〉/g, '>'))
}

export function stripInvisibleCharacters(text: string): string {
  // eslint-disable-next-line no-misleading-character-class -- 故意的不可见字符侦测
  return text.replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD\u2060-\u2064\u2066-\u206F]/g, '')
}

export function defangSystemReminderTags(text: string): string {
  return text.replace(/<(\/?\s*system-reminder\b[^>]*)>/gi, '&lt;$1>')
}

/**
 * 不可信文本进受信边界的**唯一**入口：先归一，再拆解真标签。
 *
 * 为什么必须两步：`sanitizeUntrustedText` 会把全角
 * `＜/system-reminder＞` 归一成**真正的** `</system-reminder>`——只做这一步，等于把
 * 攻击者的逃逸写法洗成有效标签，反而打开伪造系统提醒信封的路。两步合起来才封住。
 * `untrustedContent.test.ts` 的用例示范的正是这个组合。
 */
export function hardenUntrustedText(text: string): string {
  return defangSystemReminderTags(sanitizeUntrustedText(text))
}

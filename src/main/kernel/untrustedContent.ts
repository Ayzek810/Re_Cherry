/**
 * 不可信文本进受信提示边界前的规范化（V2 untrustedContent.ts 逐字移植，v0.4.6）。
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

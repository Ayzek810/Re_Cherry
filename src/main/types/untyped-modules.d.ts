/**
 * 主进程无类型依赖的最小 ambient 声明（只声明 fork 实际用到的面，不做全量 API）。
 * mammoth：docx→HTML 转换器（extractors 的 Markdown 管线）——npm 包不带 types，
 * @types/mammoth 不存在（registry 404 实证 2026-09-20）。
 * turndown-plugin-gfm：turndown 的 GFM 插件集（表格/删除线/任务列表）——包不带
 * types，@types 无对应包。
 */
declare module 'mammoth' {
  export interface ConvertToHtmlInput {
    path: string
  }
  export interface ConvertToHtmlResult {
    value: string
    messages: Array<{ type: string; message: string }>
  }
  /** CJS 互操作：named 探测由 cjs-module-lexer 决定——运行时 named/default 两形态
   * 并存兼容（与 officeparser 同款访问模式），故 named 允许 undefined。 */
  export const convertToHtml: ((input: ConvertToHtmlInput) => Promise<ConvertToHtmlResult>) | undefined
  const mammoth: {
    convertToHtml: (input: ConvertToHtmlInput) => Promise<ConvertToHtmlResult>
  }
  export default mammoth
}

declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'

  export function gfm(service: TurndownService): void
  export function tables(service: TurndownService): void
  export function strikethrough(service: TurndownService): void
  export function taskListItems(service: TurndownService): void
}

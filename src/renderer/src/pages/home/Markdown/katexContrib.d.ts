/**
 * `katex/dist/contrib/*` 的模块声明（续）。
 *
 * 这两个文件是 **无类型声明的 ESM 副作用模块**：`katex` 的 `exports` 映射里
 * `"./contrib/copy-tex"` 指向 `./dist/contrib/copy-tex`（无扩展名），Node 解析会补 `.mjs`，
 * 但 TypeScript 的 bundler 解析拿不到声明 ⇒ TS2307。
 *
 * 为什么现在才需要：这两个 contrib 此前是 `Markdown.tsx` 的**顶层副作用导入**
 * （`import 'katex/dist/contrib/copy-tex'`，TS 对无类型副作用导入不报错）， 把它们改成
 * 函数内的 `await import(...)` 后才会走类型解析。声明成空模块即可——这里只需要它们的
 * 副作用（往 katex 实例注册宏/钩子），不消费任何导出。
 */
declare module 'katex/dist/contrib/copy-tex'
declare module 'katex/dist/contrib/mhchem'

export * from './api'
export * from './dataUrl'
export * from './matchPattern'
// 有意不 re-export './pdf'：该模块静态依赖 pdf-parse（约 0.8MB，含 pdfjs 闭包），
// 而渲染层多处从 '@shared/utils' 取 api/dataUrl 工具——barrel 会把整个 PDF 抽取栈
// 拖进渲染层首屏 bundle（v1 包体实测：pdf-parse 占 eager 面 0.82MB）。
// 主进程调用方按需直连子路径：`import { extractPdfText } from '@shared/utils/pdf'`。

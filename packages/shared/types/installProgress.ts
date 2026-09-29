// fork 缝（原创，v0.4.5-1）：受管工具安装进度的**共享词汇表**。
//
// 为什么要单列一件：进度此前是三处各自描述的字符串——主进程广播、preload 桥、渲染层状态
// 与组件 props 各写一遍形状，步骤名更是散在各安装路径里的裸字符串。后果正是用户指出的那类：
// 新工具/新步骤可以悄悄漏掉展示或漏掉文案（"进度条只给某一家做了"）。
//
// 现在它们是同一份契约：
// ① 主进程 `broadcastInstallProgress(tool, step, …)` 的 step 只能是这里的词汇——
//    写错步骤名是**编译错误**，不是运行时空白；
// ② preload 桥的载荷类型、渲染层状态、标准进度元素（InstallProgress）共用 `InstallProgressPayload`；
// ③ 每个步骤的文案键固定为 `code.install_progress.<step>`，由静态检查的 i18n-dynamic 注册表
//    逐条核对两语（新增步骤漏文案 → 门禁变红）。

/** 安装步骤词汇（唯一的步骤名来源）。 */
export const INSTALL_PROGRESS_STEPS = [
  /** 下载运行时（node / CPython）。 */
  'runtime',
  /** npm 安装（dsh 本体）。 */
  'install',
  /** 装配插件工具链（pnpm）。 */
  'toolchain',
  /** 安装插件市场（dshmarket）。 */
  'market',
  /** 安装演示文稿插件（dsh-ppt）。 */
  'ppt',
  /** 获取源码树（GitHub 归档）。 */
  'source',
  /** 解压归档（下载完成之后、安装之前）。 */
  'extract',
  /** 创建 Python 环境。 */
  'venv',
  /** pip 安装依赖（hermes）。 */
  'pip',
  /** pip 安装源码型依赖（paper-agent）。 */
  'deps',
  /** 构建前端（vite）。 */
  'front',
  /** 部署前端产物与用户态播种。 */
  'deploy'
] as const

export type InstallProgressStep = (typeof INSTALL_PROGRESS_STEPS)[number]

/** 进度广播的载荷（主进程 → preload → 渲染层，同一形状）。 */
export interface InstallProgressPayload {
  /** 工具的可执行名（= tools/<name> 目录名）。 */
  tool: string
  step: InstallProgressStep
  /**
   * 语言无关的补充事实（目前是下载字节进度，如 `43% · 12.3/30.5 MB`）。
   * 渲染层原样展示——不做二次拼装，避免两侧各有一套格式。
   */
  detail?: string
  /**
   * 可测阶段的确定性比例（0..1）。缺省表示"该阶段不可测"——渲染层据此画不确定态。
   * 只有真能算出比例的阶段才该给值：宁可显示"不确定"，不显示假进度。
   */
  fraction?: number
}

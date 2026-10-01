// fork 缝（原创，二轮审查 r2-79 / 跨区请求⑥）：按 id 读文件仓成员时，
// 「文件不存在」与「存在但读不出来」是**两个不同的事实**，此前 IPC 只回一个通用错误，
// 渲染层无法区分 ⇒ 全新安装时 `custom-minapps.json` 永远播种不了（用户第一次添加
// 自定义小应用就失败），而「读失败」又有被当成「不存在」后覆盖写的风险。
//
// 这份判别式联合是主进程 handler、preload 桥、渲染层三处共用的同一份契约（家规 §8）。

/**
 * 「按 id 读文件」的结果。
 *
 * 三值语义（家规 §9）：`ok:true` = 确定内容；`missing` = 确定的「不存在」（唯一允许
 * 授权「创建」的事实，因为它是文件系统的终局答案，不是推断）；`error` = 存在但读不出来
 * （不可判定 ⇒ **绝不**授权任何写动作，也绝不降级成空结果）。
 */
export type FileReadByIdResult =
  | { status: 'ok'; content: string }
  | { status: 'missing' }
  | { status: 'error'; message: string }

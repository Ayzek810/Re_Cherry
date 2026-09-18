/**
 * 确定性"内核注册表无此行"的判定（主进程侧，Dsh_TopicEvents 通道消费）。
 *
 * 唯一命中形状是 `src/main/kernel/topics.ts` openTopic 抛的
 * `kernel: topic "<id>" not found`（含 554/568 两个抛点）——它是**确定性答案**
 * （话题从未建册 / 已被删除），不是故障。Dsh_TopicEvents 在源头按空会话回答，
 * 而不是把 reject 丢给 ipcMain.handle：Electron 对 handler 的 reject 会无条件
 * 打印 "Error occurred in handler"（真机 2026-09-17 的吓人噪音，数据零损伤）。
 *
 * 与渲染层 `kernelEventStream.isDefinitiveTopicUnknown` 是同一判定在 IPC 两侧的
 * 双份（防御纵深：主进程漏放过的 reject 在渲染层仍按"确定性空会话"降级）。
 *
 * 刻意不命中的相邻形状（各自确定性，但**不属于本通道的判定域**，由各自的调用语义
 * 处理）：fork 的 `kernel: source topic ...`、锚点系的
 * `kernel: (user message|anchor user) seq ...`。瞬时失败（"session is not loaded"
 * 等）同样不命中——渲染层对它们有重试窗口，吞掉它们会把"暂时不知道"变成"空会话"。
 */
export function isTopicNotFoundError(error: unknown): boolean {
  return error instanceof Error && /^kernel: topic "[^"]+" not found$/.test(error.message)
}

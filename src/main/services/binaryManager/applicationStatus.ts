// fork 缝（原创，v0.4.5-1）：受管安装的"完好/损坏"判定（纯函数）。
//
// 为什么单列一件：这条判定原先藏在 BinaryManager.snapshotTool 里，且判据分散（npm 型看
// requiredPeer、源码型看 SHA 标记 + 前端产物、所有类别都看 --version 探针）——结果漏掉了
// 最要紧的一条：**受管安装是分步完成的，而"版本标记"是最后一步写的**。
//
// 真机形态（用户反馈）：dsh 核心换成新版、市场/PPT 装配那一步失败 → 可执行物在、`--version`
// 能跑，于是被判 applied，版本卡还显示"最新版本"；用户看到的是"升级成功了，但插件市场不可
// 用"，且没有任何重试入口。判据补齐后这种半成品一律 broken（卡片给重试）。
//
// 规则（与安装器写入顺序一一对应）：
// ① 版本标记缺失 ⇒ broken——安装器把它写在最后（bundle 装配 / pip / 前端部署之后），缺它即
//    "上次安装中途失败"；
// ② requiredPeer 缺失 ⇒ broken（npm 型；V2 语义）；
// ③ 源码型的用户态部署产物缺失 ⇒ broken（FastAPI 以 cwd 相对路径伺服 home/<tool>/front/dist）；
// ④ `--version` 探针失败 ⇒ broken（装了但跑不起来）。

import type { ManagedToolKind } from './layout'

export type ManagedApplicationStatus = 'applied' | 'broken'

export interface ApplicationFacts {
  kind: ManagedToolKind
  /** 受管安装完成的事实（安装器最后一步写的版本标记）。 */
  hasVersionMarker: boolean
  /** `--version` 探针是否通过。 */
  probeRunnable: boolean
  /** npm 型的宿主依赖完整性；无 requiredPeer 配方时为 undefined（不参与判定）。 */
  requiredPeerSatisfied?: boolean
  /** 源码型的用户态前端产物是否就位。 */
  frontDeployed?: boolean
}

export function judgeManagedApplication(facts: ApplicationFacts): ManagedApplicationStatus {
  if (!facts.hasVersionMarker) return 'broken'
  if (facts.requiredPeerSatisfied === false) return 'broken'
  if (facts.kind === 'source' && facts.frontDeployed === false) return 'broken'
  if (!facts.probeRunnable) return 'broken'
  return 'applied'
}

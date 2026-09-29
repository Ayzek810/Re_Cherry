// fork 缝（原创，v0.4.5-1）：pip 安装过程的进度计数（纯解析，可单测）。
//
// 为什么需要：pip 是受管工具安装里**最长**的一段（hermes 的 pip、paper-agent 的 deps，真机十几
// 分钟），而它在管道里没有任何百分比可算——一条脉冲干等十几分钟，用户读到的就是"进度条不动"。
//
// pip 在非 TTY 下把"在收集/在下载哪个包"逐行打到 stdout，这些行是**真实且单调**的事实：
//   Collecting anthropic>=0.111.0
//     Downloading anthropic-0.111.0-py3-none-any.whl (1.2 MB)
//   Using cached chromadb-1.5.9-py3-none-any.whl (1.1 MB)
// 于是我们给出**计数**（已处理 N 个包 · 已下载 X MB），而不是编一个百分比：分母（总共要装几个）
// 只有等 pip 解析完才知道，编不得。

export interface PipProgress {
  /** 已经 Collecting 的包数（含已缓存）。 */
  packages: number
  /** 已经从轮子/源码包下载的字节数（按 pip 自报的大小累加）。 */
  bytes: number
}

const COLLECTING_PATTERN = /^\s*Collecting\s+\S/
const SIZE_PATTERN = /(?:Downloading|Using cached)\s+\S+\s*\(([\d.]+)\s*(B|kB|KB|MB|GB)\)/i

const UNIT_BYTES: Record<string, number> = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 }

export function createPipProgress(): PipProgress {
  return { packages: 0, bytes: 0 }
}

/**
 * 喂 pip 的输出 → 就地更新计数。
 *
 * 输入契约：**完整行**（可多行，一次调用一段）。跨 chunk 的半行拼接由调用方负责——
 * 生产路径是 runCommand 的 `onOutputLine`（内部按流保存半行缓冲）；这里再拼一次就是第二份
 * 行组装逻辑，会与它漂移。半行**一律忽略**（认不出的行绝不猜：宁可少报一个包，
 * 不报一个假的）。
 */
export function feedPipProgress(progress: PipProgress, chunk: string): PipProgress {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue
    if (COLLECTING_PATTERN.test(line)) {
      progress.packages += 1
      continue
    }
    const size = SIZE_PATTERN.exec(line)
    if (size) {
      const unit = UNIT_BYTES[size[2].toLowerCase()]
      const value = Number(size[1])
      if (unit && Number.isFinite(value)) progress.bytes += value * unit
    }
  }
  return progress
}

/** 计数 → 展示文本（语言无关的数字串，风格与下载进度一致）。 */
export function formatPipProgress(progress: PipProgress): string | undefined {
  const parts: string[] = []
  if (progress.packages > 0) parts.push(`${progress.packages} package${progress.packages === 1 ? '' : 's'}`)
  if (progress.bytes > 0) parts.push(`${(progress.bytes / (1024 * 1024)).toFixed(1)} MB`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

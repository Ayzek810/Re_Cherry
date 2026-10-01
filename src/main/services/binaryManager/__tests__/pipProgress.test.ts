/**
 * pip 进度计数契约。
 *
 * 为什么值得单测：hermes 的 pip 与 paper-agent 的 deps 是安装里最长的一段，而这段**没有**可算的
 * 百分比——进度条能不能在这几分钟里给出真事实，全看这里的解析。真机判据（用户反馈）是
 * "别一动不动，也别编"，所以断言分两类：认识的行必须计数准确（含跨 chunk 切分），
 * 不认识的行必须**一个都不算**（不许猜）。
 */
import { describe, expect, it } from 'vitest'

import { createPipProgress, feedPipProgress, formatPipProgress } from '../pipProgress'

describe('feedPipProgress', () => {
  it('counts collecting lines and downloaded sizes from real pip output', () => {
    const progress = createPipProgress()
    feedPipProgress(
      progress,
      [
        'Collecting anthropic>=0.111.0',
        '  Downloading anthropic-0.111.0-py3-none-any.whl (1.2 MB)',
        'Collecting chromadb>=1.0.0',
        '  Using cached chromadb-1.5.9-py3-none-any.whl (1.1 MB)',
        'Collecting httpx>=0.27',
        '  Downloading httpx-0.28.1-py3-none-any.whl (73 kB)',
        ''
      ].join('\n')
    )
    expect(progress.packages).toBe(3)
    // 1.2 MB + 1.1 MB + 73 kB
    expect(progress.bytes).toBeCloseTo(1.2 * 1024 * 1024 + 1.1 * 1024 * 1024 + 73 * 1024, 0)
    expect(formatPipProgress(progress)).toBe('3 packages · 2.4 MB')
  })

  it('accumulates across calls (pip output arrives in several pieces of complete lines)', () => {
    const progress = createPipProgress()
    feedPipProgress(progress, 'Collecting a\n  Downloading a-1.0.0-py3-none-any.whl (2.0 MB)\n')
    feedPipProgress(progress, 'Collecting b\n')
    expect(progress.packages).toBe(2)
    expect(formatPipProgress(progress)).toBe('2 packages · 2.0 MB')
  })

  it('ignores a half line instead of reading a size off it', () => {
    // 半行由调用方（runCommand 的 onOutputLine）负责拼好；这里收到半行就什么都不算——
    // 从 "…whl (2.0" 上猜一个大小是编数据。
    const progress = createPipProgress()
    feedPipProgress(progress, '  Downloading a-1.0.0-py3-none-any.whl (2.0')
    expect(progress.bytes).toBe(0)
  })

  it('ignores every line it does not recognise', () => {
    const progress = createPipProgress()
    feedPipProgress(
      progress,
      [
        'Requirement already satisfied: click in ./venv/lib/python3.12/site-packages (8.1.7)',
        'Installing collected packages: anthropic, httpx',
        'Successfully installed anthropic-0.111.0 httpx-0.28.1',
        'ERROR: Could not find a version that satisfies the requirement nope',
        'Collecting',
        'Building wheel for foo (pyproject.toml) ... done'
      ].join('\n')
    )
    expect(progress).toEqual({ packages: 0, bytes: 0 })
    expect(formatPipProgress(progress)).toBeUndefined()
  })

  it('reads every unit pip prints, case-insensitively', () => {
    const progress = createPipProgress()
    feedPipProgress(progress, 'Downloading x (512 B)')
    feedPipProgress(progress, 'downloading y (3 KB)')
    feedPipProgress(progress, 'Downloading z (1.5 gb)')
    expect(progress.bytes).toBe(512 + 3 * 1024 + 1.5 * 1024 * 1024 * 1024)
  })

  it('reports packages alone when pip never printed a size, and drops the plural for one', () => {
    const progress = createPipProgress()
    feedPipProgress(progress, 'Collecting only-this-one\n')
    expect(formatPipProgress(progress)).toBe('1 package')
  })
})

import { mkdir,mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { extractFromVideoPair, listDirectoryFiles } from '../extractors'

// 切断 extractors → webFetch → SearchService 的传递图（electron CJS interop
// 收集期即炸，同存量 extractors.test.ts 的处理）；本测试不触及 sitemap 抓取。
vi.mock('@main/services/webSearchProviders/webFetch', () => ({
  fetchWebContent: vi.fn(async () => ({ content: '' })),
  noContent: 'No content found'
}))

const tempDirs: string[] = []
async function makeTempDir(): Promise<string> {
  // main.setup mock 掉了 os.tmpdir——用系统 TEMP 环境变量作临时根（存量同款）。
  const dir = await mkdtemp(path.join(process.env.TEMP ?? process.env.TMP ?? '.', 're-cherry-kb-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('extractFromVideoPair（V1 预留契约的新实现：视频 + SRT 对）', () => {
  it('parses cues into windows with timestamp markers', async () => {
    const dir = await makeTempDir()
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:04,000',
      '第一句字幕内容',
      '',
      '2',
      '00:00:05,000 --> 00:00:08,000',
      '第二句字幕内容',
      ''
    ].join('\n')
    const srtPath = path.join(dir, 'sample.srt')
    await writeFile(srtPath, srt, 'utf-8')
    const windows = await extractFromVideoPair(path.join(dir, 'sample.mp4'), srtPath)
    expect(windows.length).toBeGreaterThanOrEqual(1)
    expect(windows[0]?.source).toBe('sample.mp4')
    const joined = windows.map((w) => w.text).join('\n')
    expect(joined).toContain('[00:01]')
    expect(joined).toContain('第一句字幕内容')
    expect(joined).toContain('第二句字幕内容')
  })

  it('throws honestly when the srt has no cues', async () => {
    const dir = await makeTempDir()
    const srtPath = path.join(dir, 'empty.srt')
    await writeFile(srtPath, 'not a valid srt body', 'utf-8')
    await expect(extractFromVideoPair(path.join(dir, 'v.mp4'), srtPath)).rejects.toThrow('no cues')
  })
})

describe('listDirectoryFiles（目录摄取枚举）', () => {
  it('recursively collects supported files, skipping dot entries and generated dirs', async () => {
    const dir = await makeTempDir()
    await mkdir(path.join(dir, 'sub'))
    await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(path.join(dir, '.hidden'))
    await writeFile(path.join(dir, 'a.md'), '# hello', 'utf-8')
    await writeFile(path.join(dir, 'sub', 'b.txt'), 'text', 'utf-8')
    await writeFile(path.join(dir, 'c.bin'), 'binary?', 'utf-8')
    await writeFile(path.join(dir, 'node_modules', 'pkg', 'd.js'), 'js', 'utf-8')
    await writeFile(path.join(dir, '.hidden', 'e.md'), 'hidden', 'utf-8')
    const files = await listDirectoryFiles(dir)
    expect(files).toEqual([path.join(dir, 'a.md'), path.join(dir, 'sub', 'b.txt')])
  })

  it('returns an empty list for a directory with nothing ingestible', async () => {
    const dir = await makeTempDir()
    expect(await listDirectoryFiles(dir)).toEqual([])
  })
})

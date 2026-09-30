/**
 * v0.4.5-1 受管目录删除契约（真机反馈"卸载还是耗时过长"后的快路径 + 兜底路径）。
 *
 * 这一件用**真实文件系统**（main 测试把 `node:fs` / `node:os` mock 掉了，所以本件只用
 * `node:fs/promises` + `process.env.TEMP`——它们是真的），因为要钉住的正是文件系统语义：
 * ① 删除成功（含嵌套目录、空目录、非 ASCII 文件名）；
 * ② 缺失路径不是错误（`removeTree` 的既有语义）；
 * ③ **绝不经由链接删除目标**——这条以前由逐项遍历的 unlink 语义保证；现在常规路径换成了
 *    原生递归 rm，所以必须实测它同样不跟进（本机实测：Windows junction 只删链接、目标文件完好）。
 */
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTree, removeTreeIfPossible, removeTreeWithRetry } from '../removeTree'

/** 真实临时根：优先进程工作目录（本会话环境的符号链接授权按卷/作用域差异波动，
 * 工作区内稳定可建——kernel 测试族同先例），回退 TEMP/TMP。 */
const TMP_BASE = path.join(process.cwd(), '.tmp-binarymanager-removetree-tests')

const exists = (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false
  )

let root: string

beforeEach(async () => {
  await mkdir(TMP_BASE, { recursive: true })
  root = await mkdtemp(path.join(TMP_BASE, 'codemate-removetree-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

describe('removeTree', () => {
  it('removes a nested tree, empty directories and non-ASCII names alike', async () => {
    const nested = path.join(root, 'venv', 'Lib', 'site-packages', '包')
    await mkdir(nested, { recursive: true })
    await mkdir(path.join(root, 'venv', 'empty'), { recursive: true })
    await writeFile(path.join(nested, '模块.py'), 'x')
    await writeFile(path.join(root, 'venv', 'python.exe'), 'x')

    await removeTree(path.join(root, 'venv'))

    expect(await exists(path.join(root, 'venv'))).toBe(false)
  })

  it('treats a missing path as a no-op', async () => {
    await expect(removeTree(path.join(root, 'never-existed'))).resolves.toBeUndefined()
  })

  it('does not delete through a link (the pnpm junction discipline)', async () => {
    const target = path.join(root, 'store-content')
    const holder = path.join(root, 'tool-tree')
    await mkdir(target, { recursive: true })
    await mkdir(holder, { recursive: true })
    await writeFile(path.join(target, 'kept.bin'), 'store content must survive\n')
    // junction 不需要管理员权限；Node 在 Windows 上把它当链接（lstat.isSymbolicLink()）。
    await symlink(target, path.join(holder, 'link'), 'junction')

    await removeTree(holder)

    expect(await exists(holder)).toBe(false)
    expect(await exists(path.join(target, 'kept.bin'))).toBe(true)
  })

  it('is verified, not trusted: the tree is really gone afterwards', async () => {
    const tree = path.join(root, 'many')
    for (let i = 0; i < 40; i++) {
      await mkdir(path.join(tree, `d${i}`), { recursive: true })
      await writeFile(path.join(tree, `d${i}`, `f${i}.txt`), 'x'.repeat(64))
    }

    expect(await removeTreeIfPossible(tree)).toBe(true)
    expect(await exists(tree)).toBe(false)
  })
})

describe('removeTree fast path and fallback', () => {
  it('attempts the native fast path first and reports the tree gone without the walker', async () => {
    const tree = path.join(root, 'fast')
    await mkdir(tree, { recursive: true })
    await writeFile(path.join(tree, 'a.txt'), 'x')
    const calls: string[] = []

    await removeTree(tree, {
      nativeRemove: async (target) => {
        calls.push(target)
        await rm(target, { recursive: true, force: true })
      }
    })

    expect(calls).toEqual([tree])
    expect(await exists(tree)).toBe(false)
  })

  it('falls back to the entry-by-entry walker when the native path silently fails', async () => {
    // Windows 那个坑的等价物：原生删除"成功返回但什么都没删"（社区实测的非 ASCII 路径形态）。
    // 契约是核验必须接住它——所以这里注入一个什么都不做的端口，树仍然必须被删掉。
    const tree = path.join(root, 'silent')
    const nested = path.join(tree, 'Lib', 'site-packages')
    await mkdir(nested, { recursive: true })
    await writeFile(path.join(nested, 'mod.py'), 'x')

    await removeTree(tree, { nativeRemove: async () => undefined })

    expect(await exists(tree)).toBe(false)
  })
})

describe('removeTreeWithRetry', () => {
  it('reports success for a removable tree and for a path that is already gone', async () => {
    const tree = path.join(root, 'retry')
    await mkdir(tree, { recursive: true })
    await writeFile(path.join(tree, 'a.txt'), 'x')

    expect(await removeTreeWithRetry(tree)).toBe(true)
    expect(await removeTreeWithRetry(tree)).toBe(true)
  })
})

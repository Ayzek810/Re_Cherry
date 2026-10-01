import fs from 'node:fs'
import fsAsync from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

export function getResourcePath() {
  return path.join(app.getAppPath(), 'resources')
}

export function toAsarUnpackedPath(filePath: string): string {
  if (!app.isPackaged) {
    return filePath
  }

  const appPath = app.getAppPath()
  if (!appPath.endsWith('.asar')) {
    return filePath
  }

  const unpackedAppPath = appPath.replace(/\.asar$/, '.asar.unpacked')
  if (filePath === appPath) {
    return unpackedAppPath
  }

  const appPathPrefix = `${appPath}${path.sep}`
  if (!filePath.startsWith(appPathPrefix)) {
    return filePath
  }

  return path.join(unpackedAppPath, path.relative(appPath, filePath))
}

// 进程内缓存"已确保存在"的目录：getDataPath 在多个 IPC 热路径上被反复调用，
// 每次 existsSync+mkdirSync 是纯浪费
const ensuredDirs = new Set<string>()

export function getDataPath(subPath?: string) {
  const dataPath = path.join(app.getPath('userData'), 'Data')

  if (!ensuredDirs.has(dataPath)) {
    if (!fs.existsSync(dataPath)) {
      fs.mkdirSync(dataPath, { recursive: true })
    }
    ensuredDirs.add(dataPath)
  }

  if (subPath) {
    const fullPath = path.join(dataPath, subPath)
    if (!ensuredDirs.has(fullPath)) {
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true })
      }
      ensuredDirs.add(fullPath)
    }
    return fullPath
  }

  return dataPath
}

export async function calculateDirectorySize(directoryPath: string): Promise<number> {
  let totalSize = 0
  const items = await fsAsync.readdir(directoryPath)

  // 每层并行 stat（失败条目按 0 计）；子目录递归保持串行避免无界并发
  const statsWithNames = await Promise.all(
    items.map(async (item) => {
      const itemPath = path.join(directoryPath, item)
      try {
        return { item, stats: await fsAsync.stat(itemPath) }
      } catch {
        return null
      }
    })
  )

  for (const entry of statsWithNames) {
    if (!entry) continue
    if (entry.stats.isFile()) {
      totalSize += entry.stats.size
    } else if (entry.stats.isDirectory()) {
      totalSize += await calculateDirectorySize(path.join(directoryPath, entry.item))
    }
  }
  return totalSize
}

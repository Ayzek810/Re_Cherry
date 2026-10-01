import { loggerService } from '@logger'
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

const logger = loggerService.withContext('ObsidianVaultService')

export interface VaultInfo {
  path: string
  name: string
}

export interface FileInfo {
  path: string
  type: 'folder' | 'markdown'
  name: string
}

class ObsidianVaultService {
  // 测试注入口：默认 undefined 走平台默认解析（V1 原样路径逻辑）
  private configPathOverride: string | undefined
  private cachedConfigPath: string | null = null

  constructor(configPath?: string) {
    this.configPathOverride = configPath
  }

  private get obsidianConfigPath(): string {
    if (this.configPathOverride) {
      return this.configPathOverride
    }
    if (!this.cachedConfigPath) {
      this.cachedConfigPath = this.resolvePlatformConfigPath()
    }
    return this.cachedConfigPath
  }

  private resolvePlatformConfigPath(): string {
    // 根据操作系统获取Obsidian配置文件路径
    if (process.platform === 'win32') {
      return path.join(app.getPath('appData'), 'obsidian', 'obsidian.json')
    } else if (process.platform === 'darwin') {
      return path.join(app.getPath('home'), 'Library', 'Application Support', 'obsidian', 'obsidian.json')
    } else {
      // Linux
      const resolved = this.resolveLinuxObsidianConfigPath()
      logger.debug(`Resolved Obsidian config path (linux): ${resolved}`)
      return resolved
    }
  }

  /**
   * 获取所有的Obsidian Vault
   */
  getVaults(): VaultInfo[] {
    try {
      const configPath = this.obsidianConfigPath
      if (!fs.existsSync(configPath)) {
        return []
      }

      const configContent = fs.readFileSync(configPath, 'utf8')
      const config = JSON.parse(configContent)

      if (!config.vaults) {
        return []
      }

      return Object.entries(config.vaults).map(([, vault]: [string, any]) => ({
        path: vault.path,
        name: vault.name || path.basename(vault.path)
      }))
    } catch (error) {
      logger.error('Failed to get Obsidian Vault:', error as Error)
      return []
    }
  }

  /**
   * 获取Vault中的文件夹和Markdown文件结构
   *
   * `traverseDirectory` 此前用 `fs.readdirSync`/`fs.existsSync`/`fs.statSync`
   * 在主进程同步递归整个 vault 目录树。vault 内笔记上千时，一次 IPC 会阻塞主进程消息循环
   * （同仓 `FileStorage.getDirectoryStructure` 用的是异步 `scanDir`）。改为全异步 IO；
   * 方法因此返回 Promise，IPC 层 await。
   */
  async getVaultStructure(vaultPath: string): Promise<FileInfo[]> {
    const results: FileInfo[] = []

    try {
      // 检查vault路径是否存在
      try {
        await fs.promises.access(vaultPath)
      } catch {
        logger.error(`Vault path does not exist: ${vaultPath}`)
        return []
      }

      // 检查是否是目录
      const stats = await fs.promises.stat(vaultPath)
      if (!stats.isDirectory()) {
        logger.error(`Vault path is not a directory: ${vaultPath}`)
        return []
      }

      await this.traverseDirectory(vaultPath, '', results)
    } catch (error) {
      logger.error('Failed to read Vault folder structure:', error as Error)
    }

    return results
  }

  /**
   * 递归遍历目录获取所有文件夹和Markdown文件（全异步 IO）。
   */
  private async traverseDirectory(dirPath: string, relativePath: string, results: FileInfo[]): Promise<void> {
    try {
      // 首先添加当前文件夹
      if (relativePath) {
        results.push({
          path: relativePath,
          type: 'folder',
          name: path.basename(relativePath)
        })
      }

      let items: fs.Dirent[]
      try {
        items = await fs.promises.readdir(dirPath, { withFileTypes: true })
      } catch (err) {
        logger.error(`Failed to read directory ${dirPath}:`, err as Error)
        return
      }

      for (const item of items) {
        // 忽略以.开头的隐藏文件夹和文件
        if (item.name.startsWith('.')) {
          continue
        }

        const newRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name
        const fullPath = path.join(dirPath, item.name)

        if (item.isDirectory()) {
          await this.traverseDirectory(fullPath, newRelativePath, results)
        } else if (item.isFile() && item.name.endsWith('.md')) {
          // 收集.md文件
          results.push({
            path: newRelativePath,
            type: 'markdown',
            name: item.name
          })
        }
      }
    } catch (error) {
      logger.error(`Failed to traverse directory ${dirPath}:`, error as Error)
    }
  }

  /**
   * 获取指定Vault的文件夹和Markdown文件结构
   * @param vaultName vault名称
   */
  async getFilesByVaultName(vaultName: string): Promise<FileInfo[]> {
    try {
      const vaults = this.getVaults()
      const vault = vaults.find((v) => v.name === vaultName)

      if (!vault) {
        logger.error(`Vault not found: ${vaultName}`)
        return []
      }

      logger.debug(`Get Vault file structure: ${vault.name} ${vault.path}`)
      return await this.getVaultStructure(vault.path)
    } catch (error) {
      logger.error('Failed to get Vault file structure:', error as Error)
      return []
    }
  }

  /**
   * 在 Linux 下解析 Obsidian 配置文件路径，兼容多种安装方式。
   * 优先返回第一个存在的路径；若均不存在，则返回 XDG 默认路径。
   */
  private resolveLinuxObsidianConfigPath(): string {
    const home = app.getPath('home')
    const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')

    // 常见目录名与文件名大小写差异做兼容
    const configDirs = ['obsidian', 'Obsidian']
    const fileNames = ['obsidian.json', 'Obsidian.json']

    const candidates: string[] = []

    // 1) AppImage/DEB（XDG 标准路径）
    for (const dir of configDirs) {
      for (const file of fileNames) {
        candidates.push(path.join(xdgConfigHome, dir, file))
      }
    }

    // 2) Snap 安装：
    // - 常见：~/snap/obsidian/current/.config/obsidian/obsidian.json
    // - 兼容：~/snap/obsidian/common/.config/obsidian/obsidian.json
    for (const dir of configDirs) {
      for (const file of fileNames) {
        candidates.push(path.join(home, 'snap', 'obsidian', 'current', '.config', dir, file))
        candidates.push(path.join(home, 'snap', 'obsidian', 'common', '.config', dir, file))
      }
    }

    // 3) Flatpak 安装：~/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json
    for (const dir of configDirs) {
      for (const file of fileNames) {
        candidates.push(path.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', dir, file))
      }
    }

    const existing = candidates.find((p) => {
      try {
        return fs.existsSync(p)
      } catch {
        return false
      }
    })

    if (existing) return existing

    return path.join(xdgConfigHome, 'obsidian', 'obsidian.json')
  }
}

export default ObsidianVaultService

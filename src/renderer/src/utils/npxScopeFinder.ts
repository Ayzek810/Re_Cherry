/**
 * v0.3.2 批次1（UI）：内联移植的 npx-scope-finder@1.2.0（MIT, © MyPrototypeWhat）。
 *
 * 上游 cherry-studio 通过 npm 依赖 `npx-scope-finder` 提供该实现；fork 未引入该依赖，
 * 且 MCPSettings 的 McpDescription / NpxSearch 两处消费它。故按其 dist 源码原样移植为
 * 本地模块（ESM + 类型），仅将 console.error 改为 loggerService（fork 日志规范）。
 * imports 相应从 'npx-scope-finder' 改为 '@renderer/utils/npxScopeFinder'。
 */
import { loggerService } from '@logger'

const logger = loggerService.withContext('NpxScopeFinder')

export interface FetchWithRetryOptions {
  timeout?: number
  retries?: number
  retryDelay?: number
}

/** npm registry 单个版本元数据中本模块关心的字段（其余见 original） */
export interface NpmPackageVersion {
  name?: string
  description?: string
  version?: string
  bin?: Record<string, string>
  dependencies?: Record<string, string>
  scripts?: Record<string, unknown>
  keywords?: string[]
  homepage?: string
  repository?: { url?: string }
}

/** npm registry 包文档（packages/<name> 完整返回），消费方读取 readme 等 */
export interface NpmRegistryDocument {
  'dist-tags'?: Record<string, string>
  versions?: Record<string, NpmPackageVersion>
  readme?: string
  [key: string]: unknown
}

export interface NPMPackage {
  name: string
  description?: string
  version: string
  bin?: Record<string, string>
  dependencies?: Record<string, string>
  scripts?: Record<string, unknown>
  keywords?: string[]
  links: {
    npm: string
    repository?: string
    homepage?: string
  }
  original: NpmRegistryDocument
}

interface NpmSearchResponse {
  objects?: { package: { name: string } }[]
}

async function fetchWithRetry<T>(url: string, options: FetchWithRetryOptions = {}): Promise<T> {
  const { timeout = 10000, retries = 3, retryDelay = 1000 } = options
  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json'
        }
      })
      clearTimeout(timeoutId)
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
      return (await response.json()) as T
    } catch (error) {
      lastError = error
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay))
      }
    }
  }
  throw lastError
}

/**
 * Find all executable (npx-compatible) packages within a specific npm scope
 * @param scope The npm scope to search in (e.g., '@your-scope')
 * @param options Optional configuration options
 * @returns Promise<NPMPackage[]> Array of found packages
 * @throws Error if the scope is invalid or if there's an error fetching packages
 */
export async function npxFinder(scope: string, options: FetchWithRetryOptions = {}): Promise<NPMPackage[]> {
  if (!scope.startsWith('@')) {
    throw new Error('Scope must start with "@"')
  }
  try {
    // 使用 npm registry API 搜索包
    const searchUrl = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(scope)}`
    const searchResult = await fetchWithRetry<NpmSearchResponse>(searchUrl, options)
    if (!searchResult.objects || !Array.isArray(searchResult.objects)) {
      throw new Error('Invalid search response format')
    }

    // 筛选出属于指定 scope 的包
    const scopePackages = searchResult.objects
      .filter((pkg) => pkg.package.name.startsWith(scope))
      .map((pkg) => pkg.package.name)

    if (scopePackages.length === 0) {
      return []
    }

    // 并发获取包的详细信息
    const packagePromises = scopePackages.map((packageName) => {
      const packageUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`
      return fetchWithRetry<NpmRegistryDocument>(packageUrl, options).then((packageInfo) => ({
        packageName,
        packageInfo
      }))
    })

    const results = await Promise.allSettled(packagePromises)

    // 处理成功获取的包信息
    const packages: NPMPackage[] = []
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error(`Error fetching package details:`, result.reason)
        continue
      }
      const { packageName, packageInfo } = result.value
      if (!packageInfo['dist-tags'] || !packageInfo.versions) {
        logger.error(`Invalid package info format: ${packageName}`)
        continue
      }
      const latestVersion = packageInfo['dist-tags'].latest
      const latestVersionInfo = packageInfo.versions[latestVersion]
      if (!latestVersionInfo) {
        logger.error(`Missing latest version info: ${packageName}`)
        continue
      }
      if (isExecutablePackage(latestVersionInfo)) {
        packages.push({
          name: packageName,
          description: latestVersionInfo.description,
          version: latestVersion,
          bin: latestVersionInfo.bin,
          dependencies: latestVersionInfo.dependencies,
          scripts: latestVersionInfo.scripts,
          keywords: latestVersionInfo.keywords,
          links: {
            npm: `https://www.npmjs.com/package/${packageName}`,
            repository: latestVersionInfo.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, ''),
            homepage: latestVersionInfo.homepage
          },
          original: packageInfo // 保存原始完整数据
        })
      }
    }

    return packages
  } catch (error) {
    logger.error('Error fetching npm packages:', error as Error)
    throw error
  }
}

function isExecutablePackage(packageInfo: NpmPackageVersion): boolean {
  return !!packageInfo.bin
}

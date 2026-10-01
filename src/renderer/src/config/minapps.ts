import { loggerService } from '@logger'
import ApplicationLogo from '@renderer/assets/images/apps/application.png?url'
import DoubaoAppLogo from '@renderer/assets/images/apps/doubao.png?url'
import DuckDuckGoAppLogo from '@renderer/assets/images/apps/duckduckgo.webp?url'
import GithubCopilotLogo from '@renderer/assets/images/apps/github-copilot.webp?url'
import HuggingChatLogo from '@renderer/assets/images/apps/huggingchat.svg?url'
import KimiAppLogo from '@renderer/assets/images/apps/kimi.webp?url'
import NotebookLMAppLogo from '@renderer/assets/images/apps/notebooklm.svg?url'
import PerplexityAppLogo from '@renderer/assets/images/apps/perplexity.webp?url'
import ZaiAppLogo from '@renderer/assets/images/apps/zai.svg?url'
import QwenModelLogo from '@renderer/assets/images/models/qwen.png?url'
import DeepSeekProviderLogo from '@renderer/assets/images/providers/deepseek.png?url'
import OpenAiProviderLogo from '@renderer/assets/images/providers/openai.png?url'
import SiliconFlowProviderLogo from '@renderer/assets/images/providers/silicon.png?url'
import i18n from '@renderer/i18n'
import type { MinAppType } from '@renderer/types'
import type { FileReadByIdResult } from '@shared/types/fileRead'

const logger = loggerService.withContext('Config:minapps')

const CUSTOM_MINI_APPS_FILE = 'custom-minapps.json'

/**
 * 启动播种失败时待展示的提示文案（`null` = 没有失败）。
 *
 * 为什么不当场弹 toast：本模块在渲染层启动期求值（`store/migrate.ts` 依赖它），此刻
 * `window.toast` 还没赋值——`TopView/index.tsx` 在**挂载 effect** 里才设置它。当场调用会
 * 静默 no-op，失败就只剩一条日志。因此这里只记住事实，
 * 由应用页（用户能看到自定义小应用的地方）在挂载时取走并展示，展示后清空以免重复打扰。
 */
let pendingLoadErrorMessage: string | null = null

/** 取走启动播种失败的提示（一次性）。 */
export const takeCustomMiniAppsLoadError = (): string | null => {
  const message = pendingLoadErrorMessage
  pendingLoadErrorMessage = null
  return message
}

/**
 * 读自定义小应用的判别式结果（的消费侧）。
 *
 * 此前这里只有「数组」一种形状：读失败被折成空列表，于是两个相反的事实同形 ——
 * 「文件不存在」（全新安装的合法缺省，用户第一次添加小应用时**应当**创建文件）与
 * 「文件存在但读不出来」（不可判定状态，绝不允许被当成空的而覆盖写）。
 * 三值语义：`ok` = 确定内容；`missing` = 确定的「不存在」（唯一可授权创建的事实）；
 * `error` = 存在但读不出来（失败，必须可见）。
 */
export type CustomMiniAppsRead =
  | { status: 'ok'; apps: MinAppType[] }
  | { status: 'missing' }
  | { status: 'error'; error: Error }

/** 判定「按 id 读文件」的返回值是不是三值契约的形状。 */
function isFileReadByIdResult(value: unknown): value is FileReadByIdResult {
  if (typeof value !== 'object' || value === null) return false
  const status = (value as { status?: unknown }).status
  return status === 'ok' || status === 'missing' || status === 'error'
}

/**
 * 读 `custom-minapps.json` 并区分「不存在」与「读不出来」。
 *
 * 只读，任何分支都不写盘：`error` 分支返回失败事实由调用方报错，绝不降级成空列表。
 */
const readCustomMiniApps = async (): Promise<CustomMiniAppsRead> => {
  let result: unknown
  try {
    result = await window.api.file.readById(CUSTOM_MINI_APPS_FILE)
  } catch (error) {
    // 通道本身不可用（旧 preload、IPC 拒绝）：同样是"读不出来"，不得当成空列表。
    const cause = error instanceof Error ? error : new Error(String(error))
    logger.warn('Failed to read custom mini apps (IPC call rejected); keeping the file untouched', cause)
    return { status: 'error', error: cause }
  }

  if (!isFileReadByIdResult(result)) {
    const shapeError = new Error('custom mini apps read returned an unexpected payload shape')
    logger.warn('Failed to read custom mini apps (unexpected payload shape)', shapeError)
    return { status: 'error', error: shapeError }
  }

  if (result.status === 'missing') {
    // 确定的「不存在」：全新安装的合法缺省，不是失败。文件由用户首次添加自定义小应用时创建。
    logger.info('custom-minapps.json does not exist yet; using an empty custom list')
    return { status: 'missing' }
  }

  if (result.status === 'error') {
    const readError = new Error(result.message)
    logger.warn('custom-minapps.json exists but could not be read; keeping the file untouched', readError)
    return { status: 'error', error: readError }
  }

  try {
    const parsed = JSON.parse(result.content)
    if (!Array.isArray(parsed)) {
      throw new Error('custom-minapps.json does not contain an array')
    }
    const now = new Date().toISOString()

    return {
      status: 'ok',
      apps: parsed.map((app: any) => ({
        ...app,
        type: 'Custom',
        logo: app.logo && app.logo !== '' ? app.logo : ApplicationLogo,
        addTime: app.addTime || now,
        supportedRegions: ['CN', 'Global'] // Custom mini apps should always be visible for all regions
      }))
    }
  } catch (error) {
    // JSON 损坏同样不得降级为"用户没有小应用"后重写文件：保留原文件，如实记 warn。
    const parseError = error instanceof Error ? error : new Error(String(error))
    logger.warn('Failed to parse custom mini apps; keeping the file untouched', parseError)
    return { status: 'error', error: parseError }
  }
}

// 加载自定义小应用（启动播种路径）。
// `missing` 是合法缺省（返回空列表）；其余失败一律抛出——启动路径的调用方收到失败即空列表 +
// 用户提示，**任何分支都不写盘**。
const loadCustomMiniApp = async (): Promise<MinAppType[]> => {
  const result = await readCustomMiniApps()
  if (result.status === 'ok') return result.apps
  if (result.status === 'missing') return []
  throw result.error
}

/**
 * 用户显式动作下的自定义小应用**原子更新**。
 *
 * 主进程的读通道把「不存在」与「读不出来」分开了，这里据此给出两个相反的动作：
 * - `missing`（确定不存在）：从空列表开始，写文件即"首次创建"——这正是全新安装下
 *   用户第一次添加自定义小应用能成功的唯一路径（旧实现无论添加还是删除都会抛在
 *   `File_Read` 的通用错误上，然后弹一句"保存失败"）。
 * - `error`（存在但读不出来）：**抛出**。调用方的 catch 负责报错与不写盘，
 *   用户文件原样保留。失败绝不长得像空结果。
 */
const updateCustomMiniApps = async (mutate: (apps: MinAppType[]) => MinAppType[]): Promise<MinAppType[]> => {
  const result = await readCustomMiniApps()
  if (result.status === 'error') {
    throw result.error
  }

  const current = result.status === 'ok' ? result.apps : []
  const next = mutate([...current])
  await window.api.file.writeWithId(CUSTOM_MINI_APPS_FILE, JSON.stringify(next, null, 2))
  return next
}

// 初始化默认小应用
// 按用户裁决裁剪为 12 个保留项 + 3 个新增项（原 59 个内置项的其余 44 个移除）。
// 被移除应用的持久化残留由 migrate '221' 清理（防幽灵磁贴）。
const ORIGIN_DEFAULT_MIN_APPS: MinAppType[] = [
  {
    id: 'openai',
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    logo: OpenAiProviderLogo,
    bodered: true,
    supportedRegions: ['CN', 'Global']
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    logo: PerplexityAppLogo,
    url: 'https://www.perplexity.ai/',
    supportedRegions: ['CN', 'Global']
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    logo: DuckDuckGoAppLogo,
    url: 'https://duck.ai',
    supportedRegions: ['CN', 'Global']
  },
  {
    id: 'notebooklm',
    name: 'NotebookLM',
    logo: NotebookLMAppLogo,
    url: 'https://notebooklm.google.com/',
    supportedRegions: ['CN', 'Global']
  },
  {
    id: 'huggingchat',
    name: 'HuggingChat',
    url: 'https://huggingface.co/chat/',
    logo: HuggingChatLogo,
    bodered: true,
    style: {
      padding: 6
    },
    supportedRegions: ['CN', 'Global']
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    logo: GithubCopilotLogo,
    url: 'https://github.com/copilot',
    supportedRegions: ['CN', 'Global']
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    logo: DeepSeekProviderLogo,
    supportedRegions: ['CN', 'Global']
  },
  {
    id: 'moonshot',
    name: 'Kimi',
    url: 'https://kimi.moonshot.cn/',
    logo: KimiAppLogo,
    supportedRegions: ['CN', 'Global']
  },
  {
    id: 'dashscope',
    name: 'Qwen',
    nameKey: 'minapps.qwen',
    url: 'https://www.qianwen.com',
    logo: QwenModelLogo,
    supportedRegions: ['CN']
  },
  {
    id: 'zai',
    name: 'Z.ai',
    logo: ZaiAppLogo,
    url: 'https://chat.z.ai/',
    bodered: true,
    supportedRegions: ['CN', 'Global']
  },
  {
    id: 'silicon',
    name: 'SiliconFlow',
    url: 'https://cloud.siliconflow.cn/playground/chat',
    logo: SiliconFlowProviderLogo,
    supportedRegions: ['CN', 'Global']
  },
  {
    id: 'doubao',
    name: 'Doubao',
    nameKey: 'minapps.doubao',
    url: 'https://www.doubao.com/chat/',
    logo: DoubaoAppLogo,
    supportedRegions: ['CN']
  },
  // ---- 新增（用户提供 URL 与图标）----
  {
    id: 'scnet',
    name: 'SCNET',
    url: 'https://www.scnet.cn/ui/console/index.html#',
    logo: 'https://www.scnet.cn//help/docs/mainsite/images/favicon.ico',
    supportedRegions: ['CN', 'Global']
  },
  {
    id: 'ark',
    name: '火山方舟',
    url: 'https://console.volcengine.com/ark',
    logo: 'https://res.gcloudcache.com/volc-fe/console-ark/ark-new-main/static/image/volc-180.png',
    supportedRegions: ['CN', 'Global']
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    url: 'https://openrouter.ai/',
    logo: 'https://openrouter.ai/favicon/glyph.png',
    supportedRegions: ['CN', 'Global']
  }
]

// All mini apps: built-in defaults + custom apps loaded from user config.
// 启动播种：读不出来（文件存在但不可读 / IPC 失败）时降级为"只有内置应用"，
// 但**不写盘**，并记一条 error 与用户可见提示——失败绝不静默，也绝不长得像"用户没有自定义应用"。
let allMinApps = [...ORIGIN_DEFAULT_MIN_APPS]
try {
  allMinApps = [...ORIGIN_DEFAULT_MIN_APPS, ...(await loadCustomMiniApp())]
} catch (error) {
  const cause = error instanceof Error ? error : new Error(String(error))
  logger.error('Failed to load custom mini apps at startup; built-in apps only, file untouched', cause)
  pendingLoadErrorMessage = i18n.t('settings.miniapps.custom.load_error')
}

function updateAllMinApps(apps: MinAppType[]) {
  allMinApps = apps
}

export {
  allMinApps,
  loadCustomMiniApp,
  ORIGIN_DEFAULT_MIN_APPS,
  readCustomMiniApps,
  updateAllMinApps,
  updateCustomMiniApps
}

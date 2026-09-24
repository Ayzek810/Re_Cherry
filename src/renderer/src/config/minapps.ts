import { loggerService } from '@logger'
import ApplicationLogo from '@renderer/assets/images/apps/application.png?url'
import DuckDuckGoAppLogo from '@renderer/assets/images/apps/duckduckgo.webp?url'
import GithubCopilotLogo from '@renderer/assets/images/apps/github-copilot.webp?url'
import HuggingChatLogo from '@renderer/assets/images/apps/huggingchat.svg?url'
import NotebookLMAppLogo from '@renderer/assets/images/apps/notebooklm.svg?url'
import PerplexityAppLogo from '@renderer/assets/images/apps/perplexity.webp?url'
import DoubaoAppLogo from '@renderer/assets/images/apps/doubao.png?url'
import KimiAppLogo from '@renderer/assets/images/apps/kimi.webp?url'
import ZaiAppLogo from '@renderer/assets/images/apps/zai.svg?url'
import QwenModelLogo from '@renderer/assets/images/models/qwen.png?url'
import DeepSeekProviderLogo from '@renderer/assets/images/providers/deepseek.png?url'
import OpenAiProviderLogo from '@renderer/assets/images/providers/openai.png?url'
import SiliconFlowProviderLogo from '@renderer/assets/images/providers/silicon.png?url'
import type { MinAppType } from '@renderer/types'

const logger = loggerService.withContext('Config:minapps')

// 加载自定义小应用
const loadCustomMiniApp = async (): Promise<MinAppType[]> => {
  try {
    let content: string
    try {
      content = await window.api.file.read('custom-minapps.json')
    } catch (error) {
      // 如果文件不存在，创建一个空的 JSON 数组
      content = '[]'
      await window.api.file.writeWithId('custom-minapps.json', content)
    }

    const customApps = JSON.parse(content)
    const now = new Date().toISOString()

    return customApps.map((app: any) => ({
      ...app,
      type: 'Custom',
      logo: app.logo && app.logo !== '' ? app.logo : ApplicationLogo,
      addTime: app.addTime || now,
      supportedRegions: ['CN', 'Global'] // Custom mini apps should always be visible for all regions
    }))
  } catch (error) {
    logger.error('Failed to load custom mini apps:', error as Error)
    return []
  }
}

// 初始化默认小应用
// v0.3.4：按用户裁决裁剪为 12 个保留项 + 3 个新增项（原 59 个内置项的其余 44 个移除）。
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
  },  {
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
  // ---- v0.3.4 新增（用户提供 URL 与图标）----
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

// All mini apps: built-in defaults + custom apps loaded from user config
let allMinApps = [...ORIGIN_DEFAULT_MIN_APPS, ...(await loadCustomMiniApp())]

function updateAllMinApps(apps: MinAppType[]) {
  allMinApps = apps
}

export { allMinApps, loadCustomMiniApp, ORIGIN_DEFAULT_MIN_APPS, updateAllMinApps }

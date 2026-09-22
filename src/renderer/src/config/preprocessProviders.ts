/** v0.3.2 自 CS_V1 移植（文档预处理服务商默认表）。
 * 独立成 config 的原因：store/preprocess（initialState 种子）与 hooks/usePreprocess
 * （向后兼容 re-export，store/migrate.ts 消费）双向需要，放 hooks 侧会成循环导入。
 * 形态照上游 store/preprocess initialState；preprocessProviders 配置（logo/官网）fork 未移植。 */
import type { PreprocessProvider } from '@renderer/types'

export const defaultPreprocessProviders: PreprocessProvider[] = [
  {
    id: 'mineru',
    name: 'MinerU',
    apiKey: '',
    apiHost: 'https://mineru.net'
  },
  {
    id: 'doc2x',
    name: 'Doc2x',
    apiKey: '',
    apiHost: 'https://v2.doc2x.noedgeai.com'
  },
  {
    id: 'mistral',
    name: 'Mistral',
    model: 'mistral-ocr-latest',
    apiKey: '',
    apiHost: 'https://api.mistral.ai'
  },
  {
    id: 'open-mineru',
    name: 'Open MinerU',
    apiKey: '',
    apiHost: ''
  },
  {
    id: 'paddleocr',
    name: 'PaddleOCR',
    apiKey: '',
    apiHost: ''
  },
  {
    /** 本地推理条目（v0.3.2 自 CS_V2 local-paddleocr 移植）：无密钥无 apiHost，
     * 设置面板渲染模型下载卡片；执行缝在 KnowledgeService（扫描件 OCR 回退）。 */
    id: 'local-paddle',
    name: 'LocalPaddle'
  }
]

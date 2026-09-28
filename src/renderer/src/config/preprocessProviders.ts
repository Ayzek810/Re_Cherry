/** v0.3.2 自 CS_V1 移植（文档预处理服务商默认表）。
 * 独立成 config 的原因：store/preprocess（initialState 种子）与 hooks/usePreprocess
 * （向后兼容 re-export，store/migrate.ts 消费）双向需要，放 hooks 侧会成循环导入。
 * 形态照上游 store/preprocess initialState。v0.4 验收轮补 PREPROCESS_PROVIDER_CONFIG
 * （官网/取密钥外链，V1 同款 URL；logo 资产 fork 未移植）——真机反馈服务商设置
 * 界面缺"点击获取密钥"跳转。 */
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
    /** 本地推理条目（v0.3.2 自 CS_V2 local-paddleocr 移植；v0.4.4 收编为文档处理
     * 子系统 src/main/services/preprocess/localPaddle/）：无密钥无 apiHost，
     * 设置面板渲染模型下载卡片；执行缝走文档处理通道 parsePdf 路由。 */
    id: 'local-paddle',
    name: 'LocalPaddle'
  }
]

type PreprocessProviderWebsites = { official: string; apiKey: string }

/** 官网/取密钥 URL（V1 config/preprocessProviders 逐条一致）。 */
export const PREPROCESS_PROVIDER_CONFIG: Record<string, PreprocessProviderWebsites> = {
  doc2x: {
    official: 'https://doc2x.noedgeai.com',
    apiKey: 'https://open.noedgeai.com/apiKeys'
  },
  mistral: {
    official: 'https://mistral.ai',
    apiKey: 'https://mistral.ai/api-keys'
  },
  mineru: {
    official: 'https://mineru.net/',
    apiKey: 'https://mineru.net/apiManage'
  },
  'open-mineru': {
    official: 'https://github.com/opendatalab/MinerU/',
    apiKey: 'https://github.com/opendatalab/MinerU/'
  },
  paddleocr: {
    official: 'https://aistudio.baidu.com/paddleocr/',
    apiKey: 'https://aistudio.baidu.com/paddleocr/'
  }
}

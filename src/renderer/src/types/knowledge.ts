export type KnowledgeReference = {
  id: string
  source: string
  content: string
}

export type KnowledgeBase = {
  id: string
  name: string
  model: string
  embeddingModel: string
  items: KnowledgeReference[]
}

export const PreprocessProviderIds = {
  doc2x: 'doc2x',
  mistral: 'mistral',
  mineru: 'mineru',
  'open-mineru': 'open-mineru',
  paddleocr: 'paddleocr'
} as const

export type PreprocessProviderId = keyof typeof PreprocessProviderIds

export const isPreprocessProviderId = (id: string): id is PreprocessProviderId => {
  return Object.hasOwn(PreprocessProviderIds, id)
}

export interface PreprocessProvider {
  id: PreprocessProviderId
  name: string
  apiKey?: string
  apiHost?: string
  model?: string
  options?: any
}

export type KnowledgeNoteItem = {
  id: string
  baseId: string
  type: 'note'
  content: string
  remark?: string
  created_at: number
  updated_at: number
}

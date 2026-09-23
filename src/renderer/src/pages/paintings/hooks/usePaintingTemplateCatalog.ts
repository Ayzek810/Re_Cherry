/**
 * 绘画模板目录 hook（v0.3.3 批次4，② 薄适配）：读取逻辑原样（manifest 校验/
 * 翻译归一/洗牌）；资源根 = fork 静态资源 resources/painting-templates/。
 * 渲染进程读法：window.api.fs.readText（fork 既有 IPC，主进程
 * readTextFileWithAutoEncoding 直读绝对路径）；图片经 file:// URL
 * （resourcesPath 来自 redux runtime，useAppInit 已填充）。
 */
import { useAppSelector } from '@renderer/store'
import { useCallback, useEffect, useState } from 'react'

const PAINTING_TEMPLATE_RESOURCE_DIRECTORY = 'painting-templates'
const PAINTING_TEMPLATE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

interface PaintingTemplateTranslation {
  label: string
  prompt: string
}

export interface PaintingTemplatePreset extends PaintingTemplateTranslation {
  id: string
  imageUrl: string
}

function normalizeManifest(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return value.filter((item): item is string => typeof item === 'string' && PAINTING_TEMPLATE_ID_PATTERN.test(item))
}

function normalizeTranslations(value: unknown): Record<string, PaintingTemplateTranslation> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, PaintingTemplateTranslation] => {
      const translation = entry[1]
      return Boolean(
        translation &&
          typeof translation === 'object' &&
          typeof (translation as PaintingTemplateTranslation).label === 'string' &&
          typeof (translation as PaintingTemplateTranslation).prompt === 'string'
      )
    })
  )
}

function getLocaleFileName(language: string) {
  return language.toLowerCase() === 'zh-cn' ? 'zh-cn.json' : 'en-us.json'
}

function shuffleTemplates(templates: PaintingTemplatePreset[]) {
  const shuffled = [...templates]

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    const current = shuffled[index]
    const replacement = shuffled[randomIndex]
    if (!current || !replacement) continue

    shuffled[index] = replacement
    shuffled[randomIndex] = current
  }

  return shuffled
}

function joinResourcePath(resourcesPath: string, ...segments: string[]): string {
  const normalized = resourcesPath.replace(/[\\/]+$/, '')
  return [normalized, ...segments].join('/')
}

async function loadPaintingTemplateCatalog(resourcesPath: string, language: string): Promise<PaintingTemplatePreset[]> {
  const resourceRoot = joinResourcePath(resourcesPath, PAINTING_TEMPLATE_RESOURCE_DIRECTORY)
  const [manifestContent, translationContent] = await Promise.all([
    window.api.fs.readText(joinResourcePath(resourceRoot, 'catalog.json')),
    window.api.fs.readText(joinResourcePath(resourceRoot, `locales/${getLocaleFileName(language)}`))
  ])
  const manifest = normalizeManifest(JSON.parse(manifestContent))
  const translations = normalizeTranslations(JSON.parse(translationContent))

  const templates = manifest.map((id) => {
    const translation = translations[id]
    if (!translation) {
      throw new Error(`Missing painting template translation: ${id}`)
    }

    const previewPath = joinResourcePath(resourceRoot, `images/${id}.webp`)
    return {
      id,
      imageUrl: `file://${previewPath.replace(/\\/g, '/')}`,
      ...translation
    }
  })

  return shuffleTemplates(templates)
}

export function usePaintingTemplateCatalog() {
  const resourcesPath = useAppSelector((state) => state.runtime.resourcesPath)
  const language = useAppSelector((state) => state.settings.language)
  const [templates, setTemplates] = useState<PaintingTemplatePreset[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async () => {
    if (!resourcesPath) return
    setIsLoading(true)
    try {
      const loaded = await loadPaintingTemplateCatalog(resourcesPath, language)
      setTemplates(loaded)
    } catch (error) {
      // 模板目录缺失/损坏只降级为空轮播，不阻塞绘画页。
      console.error('[usePaintingTemplateCatalog] failed to load catalog', error)
      setTemplates([])
    } finally {
      setIsLoading(false)
    }
  }, [language, resourcesPath])

  useEffect(() => {
    void load()
  }, [load])

  return { templates, isLoading }
}

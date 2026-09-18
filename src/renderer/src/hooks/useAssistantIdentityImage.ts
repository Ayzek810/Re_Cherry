import { getIdentityImage } from '@renderer/services/assistantIdentity'
import { useLiveQuery } from 'dexie-react-hooks'

/**
 * 图片标识 → 数据 URL（`img:` 引用从 ImageStorage 异步解析）。
 * 非图片引用恒 undefined；图片加载完成前也为 undefined（短暂空白后出现）。
 */
export default function useAssistantIdentityImage(identity: string | undefined | null): string | undefined {
  return useLiveQuery(() => getIdentityImage(identity), [identity])
}

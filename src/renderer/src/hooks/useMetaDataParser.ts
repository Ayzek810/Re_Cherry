import axios from 'axios'
import * as htmlparser2 from 'htmlparser2'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * 元数据与其所属 link 绑定：只有 current link 的解析结果才允许展示，
 * 其它 link 的结果一律不回传 —— 流式重渲染按位置复用组件时 link 会变，
 * 旧实现会把上一个 link 的 `og:title` 配到新 hostname 上（过期数据被当成有效结果）。
 */
interface MetadataState<T extends string> {
  link: string
  metadata: Record<T, string>
  isLoading: boolean
  error: Error | null
}

export function useMetaDataParser<T extends string>(
  link: string,
  properties: readonly T[],
  options?: {
    timeout?: number
  }
) {
  const { timeout = 5000 } = options || {}

  const [state, setState] = useState<MetadataState<T>>(() => ({
    link,
    metadata: {} as Record<T, string>,
    isLoading: true,
    error: null
  }))
  /** 非 current link 时返回的稳定空对象（不因每次渲染换引用而打穿消费方 memo）。 */
  const emptyMetadata = useMemo(() => ({}) as Record<T, string>, [])

  const abortControllerRef = useRef<AbortController | null>(null)
  /** 在途请求的 link：仅用于「同一 link 防重入」。旧实现把 `!isLoading` 当门槛，
   *  首次解析完成后函数恒空转（消费方的 `show && isLoading` 同样恒假）。 */
  const inFlightLinkRef = useRef<string | null>(null)
  /** 请求代数：link 变化/卸载时递增，作废旧请求的迟到写入。 */
  const requestIdRef = useRef(0)

  const parseMetadata = useCallback(async () => {
    if (!link || inFlightLinkRef.current === link) return

    inFlightLinkRef.current = link
    const requestId = ++requestIdRef.current

    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller

    setState({ link, metadata: {} as Record<T, string>, isLoading: true, error: null })

    try {
      const response = await axios.get(link, { timeout, signal: controller.signal })

      const htmlContent = response.data
      const parsedMetadata = {} as Record<T, string>

      const parser = new htmlparser2.Parser({
        onopentag(tagName, attributes) {
          if (tagName === 'meta') {
            const { name: metaName, property: metaProperty, content } = attributes
            const metaKey = metaName || metaProperty
            if (!metaKey || !properties.includes(metaKey as T)) return
            parsedMetadata[metaKey as T] = content
          }
        }
      })

      parser.parseComplete(htmlContent)

      if (requestIdRef.current !== requestId) return
      setState({ link, metadata: parsedMetadata, isLoading: false, error: null })
    } catch (err) {
      // Don't set error if request was aborted
      if (axios.isCancel(err) || (err instanceof Error && err.name === 'AbortError')) {
        return
      }
      if (requestIdRef.current !== requestId) return
      setState({
        link,
        metadata: {} as Record<T, string>,
        isLoading: false,
        error: err instanceof Error ? err : new Error('Failed to fetch HTML')
      })
    } finally {
      if (inFlightLinkRef.current === link) inFlightLinkRef.current = null
    }
  }, [link, properties, timeout])

  // link 变化 / 卸载：作废在途请求。旧 link 的迟到响应既不能改本 link 的状态，
  // 也不能把新 link 已解析好的结果盖回去。
  const invalidateInFlightRequest = useCallback(() => {
    requestIdRef.current += 1
    inFlightLinkRef.current = null
    abortControllerRef.current?.abort()
  }, [])

  useEffect(() => invalidateInFlightRequest, [invalidateInFlightRequest, link])

  const isCurrent = state.link === link

  return {
    metadata: isCurrent ? state.metadata : emptyMetadata,
    isLoading: isCurrent ? state.isLoading : true,
    error: isCurrent ? state.error : null,
    parseMetadata
  }
}

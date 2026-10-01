/**
 * `customCss` 注入的唯一实现（r2-65）。
 *
 * 此前同一段「取 `#user-defined-custom-css` → remove → 建 style → 写入 textContent → append」
 * 在主窗口（`hooks/useAppInit.ts`）与 mini 窗口（`windows/mini/MiniWindowApp.tsx`）各写一遍，
 * 两处只靠人工保持一致（清理时机、`!important` 处理等任一侧修改都会漂移）。两个 React root
 * 共用本 hook，注入结果（元素 id 与位置）与原先逐字一致。
 *
 * @param customCss - 用户自定义 CSS；空值表示不注入（此时仅清掉旧元素）。
 */
import { useEffect } from 'react'

export function useInjectCustomCss(customCss: string | undefined): void {
  useEffect(() => {
    let customCssElement = document.getElementById('user-defined-custom-css') as HTMLStyleElement
    if (customCssElement) {
      customCssElement.remove()
    }

    if (customCss) {
      customCssElement = document.createElement('style')
      customCssElement.id = 'user-defined-custom-css'
      customCssElement.textContent = customCss
      document.head.appendChild(customCssElement)
    }
  }, [customCss])
}

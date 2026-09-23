// fork 缝：V2 `pages/paintings/components/PaintingImageGallery.tsx` 的作曲条侧两件
// （`PaintingImageGallery` = 参考图托盘 / `PaintingImageAddButton` = 加图按钮）。
// V2 这两个组件直接读 composer 上下文（`useComposerToolState`）；fork 同名组件是
// props 驱动的页部件（页面还在用），故在此缝里接上下文与页面草稿，不改 fork 原件。
import { PaintingImageAddButton as PaintingImageAddButtonView, PaintingInputTray } from '@renderer/pages/paintings/components/PaintingImageGallery'
import { usePaintingSession } from '@renderer/pages/paintings/context/PaintingSessionContext'
import { usePaintingComposerInputFiles } from '@renderer/pages/paintings/hooks/usePaintingComposerInputFiles'
import { useEffect, useRef } from 'react'

import { useComposerToolDispatch, useComposerToolState } from '../../ComposerToolRuntime'

/** V2 侧：编辑模型的输入图托盘（草稿附件读 composer 上下文，删图回写上下文）。 */
export const PaintingImageGallery = () => {
  const { files } = useComposerToolState()
  const { setFiles } = useComposerToolDispatch()
  return (
    <PaintingInputTray files={files} onRemove={(id) => setFiles((prev) => prev.filter((file) => file.id !== id))} />
  )
}

/**
 * V2 侧：加图按钮 + 草稿种子的宿主。
 * fork 缝：草稿附件由 composer provider 持有（fork 里 key=currentPainting.id，天然
 * 按画重置），但 provider 不知道页面的存档输入，故这里补两件 V2 由 provider 承担的事：
 * SEED（画切换时把 `painting.inputFiles` 投影成草稿附件）与加图（系统选择框 → 草稿）。
 */
export const PaintingImageAddButton = () => {
  const { currentPainting } = usePaintingSession()
  const { setFiles } = useComposerToolDispatch()
  const tray = usePaintingComposerInputFiles({
    paintingId: currentPainting.id,
    archivedInputFiles: currentPainting.inputFiles ?? [],
    // fork 缝：V2 由 `couldAddImageFile` 派生能力；fork 侧托盘 hook 的 CLEAR 只关心
    // "能力是否从 accept 掉到 reject"，模型存在即为 accept。
    inputCapability: currentPainting.model ? 'accept' : 'unknown',
    providerId: currentPainting.providerId
  })

  const seededRef = useRef<string | null>(null)
  useEffect(() => {
    if (seededRef.current === currentPainting.id) return
    seededRef.current = currentPainting.id
    setFiles(currentPainting.inputFiles ?? [])
    // 只在画切换时播种：后续变化（重新生成回填存档输入）不覆盖用户草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPainting.id])

  useEffect(() => {
    return () => {
      // 卸载即视为离开本画编辑，下一次挂载由 SEED 重新播种。
      seededRef.current = null
    }
  }, [])

  return <PaintingImageAddButtonView onPick={() => void tray.pickImages()} selecting={tray.selecting} />
}

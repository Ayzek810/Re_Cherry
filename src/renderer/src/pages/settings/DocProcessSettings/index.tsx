/**
 * v0.3.2 自 CS_V1 移植（设置 → 文档处理，/settings/docprocess）。
 *
 * fork 裁剪：上游页由两个 SettingGroup 组成——OcrSettings（OCR 服务，system/
 * tesseract/ppocr/OV 等后端表单）+ PreprocessSettings（文档处理 provider）。
 * OCR 区块不搬：其全部后端与 useOcrProvider 本 fork 均不存在（本地图片理解走
 * describe_images 模型路线）；i18n 的 settings.tool.ocr.* 留作孤儿键不裁。
 */
import { useTheme } from '@renderer/context/ThemeProvider'
import type { FC } from 'react'

import { SettingContainer } from '..'
import PreprocessSettings from './PreprocessSettings'

const DocProcessSettings: FC = () => {
  const { theme: themeMode } = useTheme()
  return (
    <SettingContainer theme={themeMode}>
      <PreprocessSettings />
    </SettingContainer>
  )
}

export default DocProcessSettings

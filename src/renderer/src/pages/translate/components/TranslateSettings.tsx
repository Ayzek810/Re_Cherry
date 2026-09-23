/**
 * 设置抽屉（V2 TranslateSettings.tsx 的抽屉形态 + fork 现有内容）：翻译模型选择与当前模型标识。
 * V2 的偏好项（markdown/自动复制/语言检测/自定义语言）在 fork 无对应数据层，不引入。
 */
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { getModelUniqId } from '@renderer/services/ModelService'
import type { Model } from '@renderer/types'
import { Drawer } from 'antd'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  visible: boolean
  model?: Model
  onClose: () => void
  onSelectModel: () => void
}

const TranslateSettings: FC<Props> = ({ visible, model, onClose, onSelectModel }) => {
  const { t } = useTranslation()

  return (
    <Drawer open={visible} onClose={onClose} placement="right" width={320} title={t('translate.settings')}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{t('translate.model')}</span>
          <button
            type="button"
            onClick={onSelectModel}
            className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
            {model ? (
              <>
                <ModelAvatar model={model} size={20} />
                <span className="max-w-40 truncate">{model.name}</span>
              </>
            ) : (
              <span className="text-muted-foreground">{t('translate.select_model')}</span>
            )}
          </button>
        </div>
        {model && (
          <p className="text-foreground-tertiary text-xs break-all">
            {t('translate.model_hint_prefix')}
            {getModelUniqId(model)}
          </p>
        )}
      </div>
    </Drawer>
  )
}

export default TranslateSettings

/**
 * v0.3.2 自 CS_V1 移植（单个文档处理 provider 表单）。
 * fork 裁剪：provider logo 与官网/取 key 外链不搬（config/preprocessProviders 的
 * PREPROCESS_PROVIDER_CONFIG 未移植）；多 Key 管理弹窗（ApiKeyListPopup）保留。
 * 表单为本地 state + blur 提交（apiKey 经 formatApiKeys 规范化逗号分隔多 key；
 * apiHost trim 去尾 /）；无 model 字段 UI（mistral 默认值来自切片初始表）。
 */
import { ApiKeyListPopup } from '@renderer/components/Popups/ApiKeyListPopup'
import { useLocalModel } from '@renderer/hooks/useLocalModel'
import { usePreprocessProvider } from '@renderer/hooks/usePreprocess'
import type { PreprocessProvider } from '@renderer/types'
import { formatApiKeys, hasObjectKey } from '@renderer/utils'
import { Button, Divider, Flex, Input, Progress, Tooltip } from 'antd'
import { List } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { SettingHelpText, SettingHelpTextRow, SettingSubtitle, SettingTitle } from '..'

interface Props {
  provider: PreprocessProvider
}

const PreprocessProviderSettings: FC<Props> = ({ provider: _provider }) => {
  const { provider: preprocessProvider, updateProvider } = usePreprocessProvider(_provider.id)
  const { t } = useTranslation()
  const [apiKey, setApiKey] = useState(preprocessProvider?.apiKey || '')
  const [apiHost, setApiHost] = useState(preprocessProvider?.apiHost || '')

  useEffect(() => {
    setApiKey(preprocessProvider?.apiKey ?? '')
    setApiHost(preprocessProvider?.apiHost ?? '')
  }, [preprocessProvider?.apiKey, preprocessProvider?.apiHost, preprocessProvider?.options])

  // 真实切片下 id 恒在默认五家之内；防线仅为类型诚实（未知 id 无表单可渲）。
  // 位置在全部 hooks 之后——hook 顺序不得条件化。
  if (!preprocessProvider) return null

  const onUpdateApiKey = () => {
    if (apiKey !== preprocessProvider.apiKey) {
      updateProvider({ apiKey })
    }
  }

  const openApiKeyList = async () => {
    await ApiKeyListPopup.show({
      providerId: preprocessProvider.id,
      title: `${preprocessProvider.name} ${t('settings.provider.api.key.list.title')}`,
      showHealthCheck: false
    })
  }

  const onUpdateApiHost = () => {
    let trimmedHost = apiHost?.trim() || ''
    if (trimmedHost.endsWith('/')) {
      trimmedHost = trimmedHost.slice(0, -1)
    }
    if (trimmedHost !== preprocessProvider.apiHost) {
      updateProvider({ apiHost: trimmedHost })
    } else {
      setApiHost(preprocessProvider.apiHost || '')
    }
  }

  return (
    <>
      <SettingTitle>
        <Flex align="center" gap={8}>
          <ProviderName>{preprocessProvider.name}</ProviderName>
        </Flex>
      </SettingTitle>
      <Divider className="my-[10px] w-full" />
      {preprocessProvider.id === 'local-paddle' && <LocalPaddleModelPanel />}
      {hasObjectKey(preprocessProvider, 'apiKey') && (
        <>
          <SettingSubtitle className="mt-[5px] mb-[10px] flex items-center justify-between">
            {preprocessProvider.id === 'paddleocr'
              ? t('settings.tool.preprocess.paddleocr.aistudio_access_token')
              : t('settings.provider.api_key.label')}
            {preprocessProvider.id !== 'paddleocr' && (
              <Tooltip title={t('settings.provider.api.key.list.open')} mouseEnterDelay={0.5}>
                <Button type="text" size="small" onClick={openApiKeyList} icon={<List size={14} />} />
              </Tooltip>
            )}
          </SettingSubtitle>
          <Flex gap={8}>
            <Input.Password
              value={apiKey}
              placeholder={
                preprocessProvider.id === 'paddleocr'
                  ? t('settings.tool.preprocess.paddleocr.aistudio_access_token')
                  : t('settings.provider.api_key.label')
              }
              onChange={(e) => setApiKey(formatApiKeys(e.target.value))}
              onBlur={onUpdateApiKey}
              spellCheck={false}
              type="password"
              autoFocus={apiKey === ''}
            />
          </Flex>
          {preprocessProvider.id !== 'paddleocr' && (
            <SettingHelpTextRow className="mt-[5px]">
              <SettingHelpText>{t('settings.provider.api_key.tip')}</SettingHelpText>
            </SettingHelpTextRow>
          )}
        </>
      )}

      {hasObjectKey(preprocessProvider, 'apiHost') && (
        <>
          <SettingSubtitle className="mt-[5px] mb-[10px]">
            {preprocessProvider.id === 'paddleocr'
              ? t('settings.tool.preprocess.paddleocr.api_url')
              : t('settings.provider.api_host')}
          </SettingSubtitle>
          <Flex>
            <Input
              value={apiHost}
              placeholder={
                preprocessProvider.id === 'paddleocr'
                  ? t('settings.tool.preprocess.paddleocr.api_url')
                  : t('settings.provider.api_host')
              }
              onChange={(e) => setApiHost(e.target.value)}
              onBlur={onUpdateApiHost}
            />
          </Flex>
          {preprocessProvider.id === 'paddleocr' && (
            <SettingHelpTextRow className="!flex-col">
              <SettingHelpText>{t('settings.tool.preprocess.paddleocr.api_url_label')}</SettingHelpText>
            </SettingHelpTextRow>
          )}
        </>
      )}
    </>
  )
}

const ProviderName = styled.span`
  font-size: 14px;
  font-weight: 500;
`

/** LocalPaddle 模型下载卡片（v0.3.2 自 CS_V2 LocalModelRequirement 形态裁剪）：
 * 状态机 not_downloaded/downloading/ready/error/unsupported，进度轮询自 useLocalModel。 */
const LocalPaddleModelPanel: FC = () => {
  const { status, download, cancel, remove } = useLocalModel()
  const { t } = useTranslation()

  return (
    <>
      <SettingSubtitle className="mt-[5px] mb-[10px]">
        {t('settings.tool.preprocess.local_paddle.model_title')}
      </SettingSubtitle>
      {status.status === 'ready' && (
        <>
          <SettingHelpTextRow>
            <SettingHelpText>{t('settings.tool.preprocess.local_paddle.ready')}</SettingHelpText>
          </SettingHelpTextRow>
          <Button className="mt-2" size="small" onClick={() => void remove()}>
            {t('settings.tool.preprocess.local_paddle.remove')}
          </Button>
        </>
      )}
      {status.status === 'downloading' && (
        <>
          <Progress percent={status.percent ?? 0} />
          <Button className="mt-2" size="small" onClick={cancel}>
            {t('settings.tool.preprocess.local_paddle.cancel')}
          </Button>
        </>
      )}
      {(status.status === 'not_downloaded' || status.status === 'error') && (
        <>
          <SettingHelpTextRow>
            <SettingHelpText>{t('settings.tool.preprocess.local_paddle.not_downloaded')}</SettingHelpText>
          </SettingHelpTextRow>
          {status.status === 'error' && status.error !== undefined && (
            <SettingHelpTextRow>
              <SettingHelpText>
                {`${t('settings.tool.preprocess.local_paddle.error_prefix')}: ${status.error}`}
              </SettingHelpText>
            </SettingHelpTextRow>
          )}
          <Button className="mt-2" type="primary" size="small" onClick={() => void download()}>
            {status.status === 'error'
              ? t('settings.tool.preprocess.local_paddle.retry')
              : t('settings.tool.preprocess.local_paddle.download')}
          </Button>
        </>
      )}
      {status.status === 'unsupported' && (
        <SettingHelpTextRow>
          <SettingHelpText>{t('settings.tool.preprocess.local_paddle.unsupported')}</SettingHelpText>
        </SettingHelpTextRow>
      )}
      <SettingHelpTextRow className="!flex-col">
        <SettingHelpText>{t('settings.tool.preprocess.local_paddle.help')}</SettingHelpText>
      </SettingHelpTextRow>
    </>
  )
}

export default PreprocessProviderSettings

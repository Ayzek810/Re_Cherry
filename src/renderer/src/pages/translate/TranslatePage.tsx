/**
 * 翻译页（v0.3.3 批次3，V2 TranslatePage 文本翻译核心整编）：
 * 双栏输入/输出 + 语言栏（源/目标/互换）+ 流式翻译（lightStream，cancelledRef 取消）
 * + 历史抽屉（Dexie translate_records）+ 页内设置（模型/提示词模板）。
 * AI 通路 = 轻量 AI 服务面（services/lightLlm），无会话无内核旁路。
 */
import { CaretRightOutlined, LoadingOutlined, SettingOutlined, SwapOutlined } from '@ant-design/icons'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { SelectChatModelPopup } from '@renderer/components/Popups/SelectModelPopup/chat-model-popup'
import Scrollbar from '@renderer/components/Scrollbar'
import { BUILTIN_TRANSLATE_LANGUAGES, langCodeToI18nKey, type TranslateLangCode } from '@renderer/config/translateLanguages'
import { db } from '@renderer/databases'
import { lightStream } from '@renderer/services/lightLlm'
import { loggerService } from '@renderer/services/LoggerService'
import { getModelUniqId } from '@renderer/services/ModelService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setTranslateModel } from '@renderer/store/llm'
import type { TranslateRecord } from '@renderer/types/translate'
import { buildTranslatePrompt, determineTargetLanguage, TRANSLATE_PROMPT } from '@renderer/utils/translate'
import { Button, Empty, Input, Select, Tooltip } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { v4 as uuid } from 'uuid'

const logger = loggerService.withContext('TranslatePage')

const TranslatePage = () => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const translateModel = useAppSelector((state) => state.llm.translateModel)

  const [sourceText, setSourceText] = useState('')
  const [outputText, setOutputText] = useState('')
  const [translating, setTranslating] = useState(false)
  const [source, setSource] = useState<TranslateLangCode | 'auto'>('auto')
  const [target, setTarget] = useState<TranslateLangCode>('zh-cn')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [history, setHistory] = useState<TranslateRecord[]>([])

  const cancelledRef = useRef(false)
  const requestIdRef = useRef<string | undefined>(undefined)

  const loadHistory = useCallback(async () => {
    try {
      const records = await db.translate_records.orderBy('createdAt').reverse().limit(50).toArray()
      setHistory(records)
    } catch (error) {
      logger.warn('load translate history failed', error as Error)
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const languageLabel = useCallback(
    (code: TranslateLangCode | 'auto') => {
      const key = langCodeToI18nKey.get(code)
      return key ? t(key) : t('translate.auto_detect')
    },
    [t]
  )

  /** 翻译（V2 useTranslate 单飞语义：新调用作废旧调用；卸载作废在途流）。 */
  const translate = useCallback(async () => {
    const text = sourceText.trim()
    if (text.length === 0 || translating) return
    if (!translateModel) {
      window.toast.error(t('translate.error.not_configured'))
      return
    }
    const decided = determineTargetLanguage(source, target)
    if (!decided.ok) {
      window.toast.warning(t(decided.reason === 'same_language' ? 'translate.error.same_language' : 'translate.error.not_pair'))
      return
    }
    const targetLabel = languageLabel(decided.target)

    cancelledRef.current = false
    setTranslating(true)
    setOutputText('')
    const requestId = `translate:${uuid()}`
    requestIdRef.current = requestId
    let accumulated = ''

    try {
      await lightStream(
        requestId,
        {
          provider: translateModel.provider,
          model: translateModel.id,
          messages: [{ role: 'user', text: buildTranslatePrompt(TRANSLATE_PROMPT, targetLabel, text) }],
          source: 'cherry-translate'
        },
        (event) => {
          if (cancelledRef.current || requestId !== requestIdRef.current) return
          if (event.type === 'delta') {
            accumulated += event.text
            setOutputText(accumulated)
          } else if (event.type === 'error') {
            window.toast.error(`${t('translate.error.failed')}: ${event.message}`)
          }
        }
      )
      if (!cancelledRef.current && accumulated.trim().length > 0) {
        const record: TranslateRecord = {
          id: uuid(),
          sourceText: text,
          targetText: accumulated,
          sourceLanguage: decided.source,
          targetLanguage: decided.target,
          createdAt: Date.now()
        }
        await db.translate_records.put(record)
        void loadHistory()
      } else if (!cancelledRef.current && accumulated.trim().length === 0) {
        window.toast.error(t('translate.error.empty'))
      }
    } catch (error) {
      if (!cancelledRef.current) {
        window.toast.error(`${t('translate.error.failed')}: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setTranslating(false)
        requestIdRef.current = undefined
      }
    }
  }, [sourceText, translating, translateModel, source, target, languageLabel, loadHistory, t])

  const abort = useCallback(() => {
    cancelledRef.current = true
    setTranslating(false)
  }, [])

  /** 源/目标互换（V2 handleExchange 语义：语言互换 + 文本互换）。 */
  const exchange = useCallback(() => {
    if (source === 'auto') {
      window.toast.info(t('translate.error.auto_source'))
      return
    }
    setSource(target)
    setTarget(source)
    setSourceText(outputText)
    setOutputText(sourceText)
  }, [source, target, sourceText, outputText, t])

  const languageOptions = useMemo(
    () =>
      BUILTIN_TRANSLATE_LANGUAGES.map((lang) => ({
        value: lang.langCode,
        label: `${lang.emoji} ${t(langCodeToI18nKey.get(lang.langCode) ?? lang.value)}`
      })),
    [t]
  )

  const autoOption = useMemo(() => [{ value: 'auto' as const, label: t('translate.auto_detect') }], [t])

  return (
    <Container>
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('translate.title')}</NavbarCenter>
      </Navbar>
      <Toolbar>
        <LanguageBar>
          <LangSelect
            value={source}
            options={[...autoOption, ...languageOptions]}
            onChange={(value) => setSource(value as TranslateLangCode | 'auto')}
            showSearch
            optionFilterProp="label"
          />
          <Tooltip title={t('translate.exchange')}>
            <SwapButton onClick={exchange} disabled={source === 'auto'}>
              <SwapOutlined />
            </SwapButton>
          </Tooltip>
          <LangSelect
            value={target}
            options={languageOptions}
            onChange={(value) => setTarget(value as TranslateLangCode)}
            showSearch
            optionFilterProp="label"
          />
        </LanguageBar>
        <ToolbarRight>
          <Tooltip title={t('translate.history')}>
            <Button type="text" icon={<CaretRightOutlined />} onClick={() => setHistoryOpen(!historyOpen)} />
          </Tooltip>
          <Tooltip title={t('translate.settings')}>
            <Button type="text" icon={<SettingOutlined />} onClick={() => setSettingsOpen(!settingsOpen)} />
          </Tooltip>
        </ToolbarRight>
      </Toolbar>
      <Panes>
        <InputPane>
          <Input.TextArea
            value={sourceText}
            onChange={(event) => setSourceText(event.target.value)}
            placeholder={t('translate.input_placeholder')}
            variant="borderless"
            autoSize={false}
            style={{ height: '100%', resize: 'none' }}
          />
        </InputPane>
        <OutputPane>
          {outputText.length === 0 && !translating ? (
            <Empty description={t('translate.output_empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <OutputText>{outputText}</OutputText>
          )}
        </OutputPane>
      </Panes>
      <ActionBar>
        {translating ? (
          <Button danger icon={<LoadingOutlined />} onClick={abort}>
            {t('translate.stop')}
          </Button>
        ) : (
          <Button type="primary" icon={<CaretRightOutlined />} disabled={sourceText.trim().length === 0} onClick={() => void translate()}>
            {t('translate.start')}
          </Button>
        )}
        <ModelTrigger
          onClick={async () => {
            const selected = await SelectChatModelPopup.show({ model: translateModel ?? undefined })
            if (selected) dispatch(setTranslateModel({ model: selected }))
          }}>
          {translateModel ? (
            <>
              <ModelAvatar model={translateModel} size={20} />
              <ModelName>{translateModel.name}</ModelName>
            </>
          ) : (
            <ModelName>{t('translate.select_model')}</ModelName>
          )}
        </ModelTrigger>
      </ActionBar>
      {historyOpen && (
        <HistoryDrawer>
          <HistoryTitle>{t('translate.history')}</HistoryTitle>
          {history.length === 0 ? (
            <Empty description={t('translate.history_empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <HistoryList>
              {history.map((record) => (
                <HistoryItem
                  key={record.id}
                  onClick={() => {
                    setSourceText(record.sourceText)
                    setOutputText(record.targetText)
                  }}>
                  <HistorySource>{record.sourceText}</HistorySource>
                  <HistoryTarget>{record.targetText}</HistoryTarget>
                </HistoryItem>
              ))}
            </HistoryList>
          )}
        </HistoryDrawer>
      )}
      {settingsOpen && (
        <SettingsPanel>
          <SettingsTitle>{t('translate.settings')}</SettingsTitle>
          <SettingsRow>
            <span>{t('translate.model')}</span>
            <ModelTrigger
              onClick={async () => {
                const selected = await SelectChatModelPopup.show({ model: translateModel ?? undefined })
                if (selected) dispatch(setTranslateModel({ model: selected }))
              }}>
              {translateModel ? (
                <>
                  <ModelAvatar model={translateModel} size={20} />
                  <ModelName>{translateModel.name}</ModelName>
                </>
              ) : (
                <ModelName>{t('translate.select_model')}</ModelName>
              )}
            </ModelTrigger>
          </SettingsRow>
          {translateModel && (
            <SettingsHint>
              {t('translate.model_hint_prefix')}
              {getModelUniqId(translateModel)}
            </SettingsHint>
          )}
        </SettingsPanel>
      )}
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  height: calc(100vh - var(--navbar-height));
`

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 0.5px solid var(--color-border);
`

const LanguageBar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const LangSelect = styled(Select)`
  min-width: 160px;
`

const SwapButton = styled(Button)`
  &.ant-btn {
    padding: 4px 8px;
  }
`

const ToolbarRight = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
`

const Panes = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  flex: 1;
  min-height: 0;
`

const InputPane = styled(Scrollbar)`
  border-right: 0.5px solid var(--color-border);
  padding: 12px 16px;

  .ant-input {
    height: 100%;
    font-size: 14px;
  }
`

const OutputPane = styled(Scrollbar)`
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: center;
`

const OutputText = styled.div`
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.6;
  width: 100%;
`

const ActionBar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-top: 0.5px solid var(--color-border);
`

const ModelTrigger = styled(Button)`
  display: flex;
  align-items: center;
  gap: 6px;
`

const ModelName = styled.span`
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const HistoryDrawer = styled(Scrollbar)`
  position: absolute;
  top: var(--navbar-height);
  right: 0;
  bottom: 0;
  width: 360px;
  background: var(--color-background);
  border-left: 0.5px solid var(--color-border);
  padding: 12px;
  z-index: 10;
`

const HistoryTitle = styled.h4`
  margin: 0 0 8px;
`

const HistoryList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const HistoryItem = styled.div`
  padding: 8px;
  border: 0.5px solid var(--color-border);
  border-radius: 8px;
  cursor: pointer;

  &:hover {
    background: var(--color-background-soft);
  }
`

const HistorySource = styled.div`
  font-size: 12px;
  color: var(--color-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const HistoryTarget = styled.div`
  font-size: 13px;
  margin-top: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const SettingsPanel = styled.div`
  position: absolute;
  top: var(--navbar-height);
  right: 0;
  bottom: 0;
  width: 320px;
  background: var(--color-background);
  border-left: 0.5px solid var(--color-border);
  padding: 12px;
  z-index: 10;
`

const SettingsTitle = styled.h4`
  margin: 0 0 8px;
`

const SettingsRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
`

const SettingsHint = styled.div`
  margin-top: 8px;
  font-size: 12px;
  color: var(--color-text-3);
  word-break: break-all;
`

export default TranslatePage

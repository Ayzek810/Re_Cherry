import { loggerService } from '@logger'
import { useAppStore } from '@renderer/store'
import { getSerializableShortcuts } from '@renderer/store/shortcuts'
import { type FC, useEffect } from 'react'

const logger = loggerService.withContext('useBootConfigSync')

/**
 * 启动对账：把 renderer redux（UI 真相）一次性推平到主进程 config.json。
 *
 * 背景（快捷助手已关闭但 Ctrl+Space 仍呼出小窗的根因）：
 * 快捷键注册（ShortcutService）与触发守卫只读主进程 config.json，而开关的
 * 真实状态在 renderer redux（redux-persist 迁移只改 redux、从不回写主进程），
 * 两半各自演化形成 split-brain。本组件在 rehydrate 完成后（挂于 PersistGate
 * 之内）执行一次性对账：
 * - enableQuickAssistant / clickTrayToShowQuickAssistant：与设置页保存写法逐字一致
 *   （前者带 notify，托盘菜单即时刷新）；
 * - shortcuts：走既有 Shortcuts_Update（主进程重存 + 按新表重注册）。
 * 幂等：每次启动以 renderer 为准，历史脏值自愈。
 * 仅主窗口挂载；mini 窗口入口不挂，避免双窗口竞争。
 */
const BootConfigSync: FC = () => {
  const store = useAppStore()

  useEffect(() => {
    const push = async () => {
      try {
        const { settings, shortcuts } = store.getState()
        await window.api.config.set('enableQuickAssistant', settings.enableQuickAssistant, true)
        await window.api.config.set('clickTrayToShowQuickAssistant', settings.clickTrayToShowQuickAssistant)
        await window.api.shortcuts.update(getSerializableShortcuts(shortcuts.shortcuts))
        logger.info('Boot config synced to main process')
      } catch (error) {
        logger.warn(
          'Failed to sync boot config to main process',
          error instanceof Error ? error : new Error(String(error))
        )
      }
    }

    void push()
  }, [store])

  return null
}

export default BootConfigSync

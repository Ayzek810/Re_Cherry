import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { BaseSettingsPopup } from '../BaseSettingsPopup'

describe('BaseSettingsPopup 的「确认」键与取消之别', () => {
  it('渲染确认键，点击后以 confirmed=true 关闭（v0.3.1-2：此前 footer 为 null，只能靠 X 关闭）', async () => {
    const onClose = vi.fn()

    render(
      <BaseSettingsPopup
        onClose={onClose}
        titleContent={<span>默认助手</span>}
        menuItems={[{ key: 'essential', label: '基础' }]}
        renderTabContent={() => <div>基础内容</div>}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /confirm|确认/i }))

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true))
  })

  it('点 X 关闭时 confirmed=false（新建草稿流程靠它区分"确认建"与"不建"）', async () => {
    const onClose = vi.fn()

    render(
      <BaseSettingsPopup
        onClose={onClose}
        titleContent={<span>默认助手</span>}
        menuItems={[{ key: 'essential', label: '基础' }]}
        renderTabContent={() => <div>基础内容</div>}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /close/i }))

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(false))
  })
})

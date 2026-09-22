import type { FC } from 'react'

/**
 * v0.3.1-2：持久化重放期的可见占位。
 *
 * `PersistGate loading={null}` 在重放完成前不渲染任何东西；一旦重放失败/卡住，用户看到的
 * 就是**永久白屏且零线索**（会被误当成"渲染崩了"）。此占位让该状态可被一眼识别。
 *
 * 单独成文件是为了可被行为测试直接驱动（配合未 bootstrapped 的 persistor）。
 */
const PersistLoadingFallback: FC = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100vw',
      height: '100vh',
      fontFamily: 'system-ui, sans-serif',
      fontSize: 13,
      color: '#888'
    }}>
    正在恢复本地数据…
  </div>
)

export default PersistLoadingFallback

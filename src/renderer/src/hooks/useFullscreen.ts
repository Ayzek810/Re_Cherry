import { useEffect, useState } from 'react'

export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    // 首次挂载时请求一次状态
    void window.api.isFullScreen().then((value) => {
      setIsFullscreen(value)
    })

    const cleanup = window.api.events.onFullscreenStatusChanged((fullscreen) => {
      setIsFullscreen(fullscreen)
    })

    return () => {
      cleanup()
    }
  }, [])

  return isFullscreen
}

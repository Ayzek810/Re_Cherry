export type FileChangeEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'refresh'

export type FileChangeEvent = {
  eventType: FileChangeEventType
  filePath: string
  watchPath: string
}

export type WebviewKeyEvent = {
  webviewId: number
  key: string
  control: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

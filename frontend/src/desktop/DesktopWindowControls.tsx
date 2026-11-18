import { useEffect, useState } from 'react'
import { isDesktopClient } from '../api/mcp-chat-api'

async function withCurrentWindow<T>(fn: (win: Awaited<ReturnType<typeof import('@tauri-apps/api/window').getCurrentWindow>>) => Promise<T>) {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return fn(getCurrentWindow())
}

/**
 * 桌面客户端（Tauri 无边框窗口）右上角自定义窗口控制三键。
 * 在普通浏览器环境中自动返回 null，不影响网页端界面。
 */
export function DesktopWindowControls() {
  const desktop = isDesktopClient()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let disposed = false
    let unlisten: (() => void) | undefined

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const win = getCurrentWindow()
        const current = await win.isMaximized()
        if (!disposed) setMaximized(current)
        unlisten = await win.onResized(async () => {
          const next = await win.isMaximized().catch(() => false)
          if (!disposed) setMaximized(next)
        })
      } catch {
        // 非完整 Tauri 运行环境（如单元测试仅挂载标记对象）时安全忽略。
      }
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [desktop])

  if (!desktop) return null

  return (
    <div className="desktop-window-controls" data-tauri-drag-region="false" role="group" aria-label="窗口控制">
      <button
        type="button"
        className="desktop-win-button"
        aria-label="最小化窗口"
        title="最小化"
        onClick={() => {
          void withCurrentWindow((win) => win.minimize()).catch(() => {})
        }}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
          <path d="M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        className="desktop-win-button"
        aria-label={maximized ? '还原窗口' : '最大化窗口'}
        title={maximized ? '向下还原' : '最大化'}
        onClick={() => {
          void withCurrentWindow(async (win) => {
            await win.toggleMaximize()
            setMaximized(await win.isMaximized())
          }).catch(() => {})
        }}
      >
        {maximized ? (
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M4 3.5V2.2h5.8V8H8.5" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
            <rect x="2.2" y="3.8" width="6" height="6" rx="0.6" stroke="currentColor" strokeWidth="1.25" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
            <rect x="2.2" y="2.2" width="7.6" height="7.6" rx="0.8" stroke="currentColor" strokeWidth="1.25" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="desktop-win-button is-close"
        aria-label="关闭窗口"
        title="关闭"
        onClick={() => {
          void withCurrentWindow((win) => win.close()).catch(() => {})
        }}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

/**
 * 未进入主框架的页面（如登录页、加载页、错误页）在桌面无边框窗口下提供的顶部拖拽与关闭条。
 */
export function DesktopStandaloneTitlebar({ title = 'AI Sales Agent' }: { title?: string }) {
  if (!isDesktopClient()) return null
  return (
    <header className="desktop-standalone-titlebar" data-tauri-drag-region>
      <span className="desktop-standalone-title" data-tauri-drag-region>
        <img src="/brand-mark.png" alt="" />
        <strong>{title}</strong>
      </span>
      <DesktopWindowControls />
    </header>
  )
}

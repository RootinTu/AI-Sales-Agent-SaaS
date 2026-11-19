import {
  BookOpen,
  Package,
  Receipt,
  Buildings,
  CaretDown,
  ChatCircleText,
  ChartLineUp,
  CheckSquareOffset,
  GearSix,
  EnvelopeSimple,
  House,
  List,
  Lock,
  MagnifyingGlass,
  Robot,
  SignOut,
  SquaresFour,
  Eye,
  FileText,
  Funnel,
  Kanban,
  PresentationChart,
  Target,
  UsersThree,
  UserList,
  Question,
  X,
  type IconProps,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getPendingApprovals } from '../../api/approvals-api'
import { logout } from '../../api/auth-api'
import * as mcpChatApi from '../../api/mcp-chat-api'
import { isDesktopClient, type AssistantCapabilities } from '../../api/mcp-chat-api'
import { useAuth } from '../../auth/use-auth'
import { leaveGuestMode } from '../../auth/guest-session'
import { DesktopUpdateIndicator } from '../../desktop/DesktopUpdatePrompt'
import { DesktopWindowControls } from '../../desktop/DesktopWindowControls'
import { FollowUpNotifications } from '../followup/FollowUpNotifications'
import { FeatureGuides, type GuideMode } from '../guides/FeatureGuides'

interface NavItem {
  to: string
  label: string
  icon: ComponentType<IconProps>
}

const workNavigation: NavItem[] = [
  { to: '/app/today', label: '今日工作台', icon: House },
  { to: '/app/leads', label: '线索', icon: Funnel },
  { to: '/app/customers', label: '客户', icon: UsersThree },
  { to: '/app/opportunities', label: '商机', icon: Kanban },
  { to: '/app/follow-ups', label: '跟进任务', icon: Target },
  { to: '/app/mail', label: '客户邮件', icon: EnvelopeSimple },
  { to: '/app/approvals', label: '审批', icon: CheckSquareOffset },
]

const insightNavigation: NavItem[] = [
  { to: '/app/mcp', label: 'MCP 助手', icon: ChatCircleText },
  { to: '/app/knowledge', label: '企业知识库', icon: BookOpen },
  { to: '/app/agent-runs', label: 'Agent 运行', icon: Robot },
  { to: '/app/forecast', label: '销售预测', icon: PresentationChart },
  { to: '/app/analytics', label: '效果分析', icon: ChartLineUp },
  { to: '/app/settings', label: '设置', icon: GearSix },
]

const commercialNavigation: NavItem[] = [
  { to: '/app/products', label: '产品与价格', icon: Package },
  { to: '/app/quotes', label: '报价单', icon: Receipt },
  { to: '/app/contracts', label: '合同与回款', icon: FileText },
]

const adminNavigation: NavItem[] = [
  { to: '/app/admin/members', label: '成员管理', icon: UserList },
  { to: '/app/admin/team', label: '团队管理', icon: Buildings },
  { to: '/app/audit-logs', label: '日志管理', icon: FileText },
]

function NavigationGroup({
  label,
  items,
  onNavigate,
}: {
  label: string
  items: NavItem[]
  onNavigate?: () => void
}) {
  return (
    <div className="navigation-group">
      <p className="navigation-label">{label}</p>
      <nav className="navigation-list" aria-label={label}>
        {items.map(({ to, label: itemLabel, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            className={({ isActive }) => `navigation-item${isActive ? ' is-active' : ''}`}
          >
            <Icon size={18} aria-hidden />
            <span>{itemLabel}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

function Sidebar({
  open,
  onClose,
  organizationName,
  displayName,
  email,
  role,
  onLogout,
  logoutPending,
}: {
  open: boolean
  onClose: () => void
  organizationName: string
  displayName: string
  email: string
  role: string
  onLogout: () => void
  logoutPending: boolean
}) {
  const roleLabel = role === 'GUEST' ? '只读浏览' : role === 'OWNER' ? '所有者' : role === 'ADMIN' ? '管理员' : '销售成员'

  return (
    <aside className={`app-sidebar${open ? ' is-open' : ''}`} aria-label="应用导航">
      <div className="sidebar-brand">
        <span className="sidebar-drawer-title">导航菜单</span>
        <button className="icon-button sidebar-close" type="button" onClick={onClose} aria-label="关闭导航">
          <X size={18} />
        </button>
      </div>

      <button className="workspace-switcher" type="button" disabled title="多工作区即将开放">
        <span className="workspace-avatar">{organizationName.slice(0, 1)}</span>
        <span>
          <small>当前工作区</small>
          <strong>{organizationName}</strong>
        </span>
        <CaretDown size={14} aria-hidden />
      </button>

      <div className="sidebar-navigation">
        <NavigationGroup label="销售工作" items={workNavigation} onNavigate={onClose} />
        <NavigationGroup label="报价与成交" items={commercialNavigation} onNavigate={onClose} />
        <NavigationGroup label="智能工具与管理" items={insightNavigation} onNavigate={onClose} />
        {role === 'OWNER' || role === 'ADMIN' ? (
          <NavigationGroup label="管理员" items={adminNavigation} onNavigate={onClose} />
        ) : null}
      </div>

      <div className="sidebar-footer">
        <span className="user-avatar" aria-hidden>{displayName.slice(0, 1)}</span>
        <span className="sidebar-user-copy" title={email}>
          <strong>{displayName}</strong>
          <small>{roleLabel}</small>
        </span>
        <button
          className="sidebar-logout"
          type="button"
          onClick={onLogout}
          disabled={logoutPending}
          aria-label={role === 'GUEST' ? '退出游客模式' : '退出登录'}
          title={role === 'GUEST' ? '退出游客模式' : '退出登录'}
        ><SignOut size={17} /></button>
      </div>
    </aside>
  )
}

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [agentNotice, setAgentNotice] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useAuth()
  const guestMode = session.role === 'GUEST'
  const desktopClient = isDesktopClient()
  const isAgentWorkspace = location.pathname.startsWith('/app/agent') && !location.pathname.startsWith('/app/agent-runs')
  const lastBusinessPathRef = useRef('/app/today')

  useEffect(() => {
    if (!isAgentWorkspace && location.pathname.startsWith('/app')) {
      const target = `${location.pathname}${location.search}`
      lastBusinessPathRef.current = target
      try {
        sessionStorage.setItem('sales-agent:last-business-path', target)
      } catch {
        // 忽略受限存储异常。
      }
    }
  }, [isAgentWorkspace, location.pathname, location.search])

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        if (isAgentWorkspace) return
        event.preventDefault()
        searchRef.current?.focus()
      }
      if (event.key === 'Escape') { setSearch(''); setSidebarOpen(false) }
    }
    document.addEventListener('keydown', shortcut)
    return () => document.removeEventListener('keydown', shortcut)
  }, [isAgentWorkspace])

  const [guideMode, setGuideMode] = useState<GuideMode>(() => session.role === 'GUEST' && sessionStorage.getItem('sales-agent:guest-guide-seen') !== 'true' ? 'catalog' : null)
  const closeGuide = useCallback(() => { sessionStorage.setItem('sales-agent:guest-guide-seen', 'true'); setGuideMode(null) }, [])

  const approvalsQuery = useQuery({
    queryKey: ['approvals', 'topbar', 'PENDING'],
    queryFn: getPendingApprovals,
    enabled: !guestMode,
    staleTime: 30_000,
    refetchInterval: 30_000,
  })
  const capabilitiesQuery = useQuery<AssistantCapabilities>({
    queryKey: ['mcp-capabilities', desktopClient],
    queryFn: () => typeof mcpChatApi.getMcpCapabilities === 'function'
      ? mcpChatApi.getMcpCapabilities()
      : Promise.resolve({
        planCode: 'STARTER',
        svip: false,
        desktopClient,
        agentModeAvailable: desktopClient,
        defaultMode: 'LIGHT',
        availableModes: desktopClient ? ['LIGHT', 'AGENT'] : ['LIGHT'],
        unavailableReason: desktopClient ? null : '自主 Agent 独立空间仅开放给桌面客户端和企业 SVIP 用户',
        agentCapabilities: [],
      }),
    enabled: !guestMode,
  })
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled: () => {
      queryClient.removeQueries({ queryKey: ['auth-session'] })
      navigate('/login', { replace: true })
    },
  })

  function exitSession() {
    if (guestMode) {
      leaveGuestMode()
      queryClient.clear()
      navigate('/login', { replace: true })
      return
    }
    logoutMutation.mutate()
  }

  const capabilities = capabilitiesQuery.data
  const agentModeAvailable = !guestMode && Boolean(capabilities?.agentModeAvailable || desktopClient)
  const agentPillLabel = capabilities?.svip
    ? '企业 SVIP'
    : (capabilities?.desktopClient || desktopClient)
      ? '桌面端'
      : '专享'
  const appVersion = import.meta.env.VITE_APP_VERSION || '1.5.0'

  function handleSwitchToBusiness() {
    setAgentNotice('')
    if (!isAgentWorkspace) return
    navigate(lastBusinessPathRef.current || '/app/today')
  }

  function handleSwitchToAgent() {
    setSidebarOpen(false)
    if (!agentModeAvailable) {
      setAgentNotice(
        guestMode
          ? '游客模式仅可浏览业务演示数据；登录后使用桌面客户端或企业 SVIP 账号可开启自主 Agent 空间'
          : (capabilities?.unavailableReason ?? '自主 Agent 独立空间仅开放给桌面客户端和企业 SVIP 用户'),
      )
      return
    }
    setAgentNotice('')
    if (!isAgentWorkspace) {
      navigate('/app/agent')
    }
  }

  const searchResults = [...workNavigation, ...commercialNavigation, ...insightNavigation,
    ...(['OWNER', 'ADMIN'].includes(session.role) ? adminNavigation : [])]
    .filter(item => item.label.toLowerCase().includes(search.trim().toLowerCase()))
  const pendingApprovals = approvalsQuery.data?.totalElements ?? 0

  return (
    <div className={`app-shell${guestMode ? ' is-guest' : ''}${isAgentWorkspace ? ' is-agent-workspace' : ''}${desktopClient ? ' is-desktop' : ''}`}>
      <header className="app-topbar" data-tauri-drag-region={desktopClient ? '' : undefined}>
        <div className="topbar-left" data-tauri-drag-region={desktopClient ? '' : undefined}>
          {!isAgentWorkspace ? (
            <button
              className="icon-button mobile-menu"
              type="button"
              data-tauri-drag-region="false"
              onClick={() => setSidebarOpen(true)}
              aria-label="打开导航"
            >
              <List size={20} />
            </button>
          ) : null}

          <div className="topbar-brand" data-tauri-drag-region={desktopClient ? '' : undefined}>
            <span className="topbar-brand-mark"><img src="/brand-mark.png" alt="" /></span>
            <span className="topbar-brand-copy">
              <strong>AI Sales Agent</strong>
              <small>v{appVersion}</small>
            </span>
          </div>

          <nav className="topbar-workspace-switch" role="tablist" aria-label="工作空间切换" data-tauri-drag-region="false">
            <button
              type="button"
              role="tab"
              aria-selected={!isAgentWorkspace}
              className={!isAgentWorkspace ? 'is-active' : ''}
              onClick={handleSwitchToBusiness}
            >
              <SquaresFour size={15} />
              <span>全部业务</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isAgentWorkspace}
              aria-disabled={!agentModeAvailable}
              className={`${isAgentWorkspace ? 'is-active' : ''}${!agentModeAvailable ? ' is-locked' : ''}`}
              title={agentModeAvailable ? '切换到独立的自主 Agent 工作空间' : '自主 Agent 独立空间仅开放给桌面客户端和企业 SVIP 用户'}
              onClick={handleSwitchToAgent}
            >
              {agentModeAvailable ? <Robot size={15} /> : <Lock size={13} />}
              <span>自主 Agent</span>
              <em className="topbar-agent-pill">{agentPillLabel}</em>
            </button>
          </nav>

          {!isAgentWorkspace ? (
            <div className="feature-search" data-tauri-drag-region="false" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSearch('') }}>
              <label className="global-search">
                <MagnifyingGlass size={17} aria-hidden />
                <input
                  ref={searchRef}
                  type="search"
                  placeholder="搜索功能，如报价、邮件、客户"
                  aria-label="搜索功能"
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && search.trim() && searchResults[0]) { navigate(searchResults[0].to); setSearch('') }
                  }}
                />
                <kbd>Ctrl K</kbd>
              </label>
              {search.trim() && <nav className="feature-search-results" aria-label="功能搜索结果">
                {searchResults.length ? searchResults.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} onClick={() => setSearch('')}><Icon size={18} /><span>{label}</span></NavLink>) : <p>未找到匹配功能，请尝试其他关键词。</p>}
              </nav>}
            </div>
          ) : null}
        </div>

        <div className="topbar-drag-spacer" data-tauri-drag-region={desktopClient ? '' : undefined} />

        <div className="topbar-actions" data-tauri-drag-region="false">
          <button className="feature-guide-topbar" type="button" title="查看所有功能的详细使用引导" aria-label="打开功能使用指南" onClick={() => setGuideMode('catalog')}><Question size={18} /><span>功能指南</span></button>
          {guestMode ? (
            <span className="environment-pill is-guest">
              <Eye size={14} />游客只读
            </span>
          ) : null}
          <DesktopUpdateIndicator />
          <FollowUpNotifications pendingApprovals={pendingApprovals} guest={guestMode} />
          <span className="topbar-avatar" aria-label={session.displayName}>{session.displayName.slice(0, 1)}</span>
          <DesktopWindowControls />
        </div>
      </header>

      {!isAgentWorkspace ? (
        <>
          <Sidebar
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            organizationName={session.organizationName}
            displayName={session.displayName}
            email={session.email}
            role={session.role}
            onLogout={exitSession}
            logoutPending={logoutMutation.isPending}
          />
          {sidebarOpen ? (
            <button
              className="sidebar-backdrop"
              type="button"
              aria-label="关闭导航"
              onClick={() => setSidebarOpen(false)}
            />
          ) : null}
        </>
      ) : null}

      <div className="shell-content">
        {guestMode ? (
          <div className="guest-readonly-banner" role="status">
            <span><Eye size={15} />游客模式 · 所有业务数据均为演示内容，修改和实际执行已禁用。</span>
            <div className="guest-banner-actions"><button type="button" onClick={() => setGuideMode('current')}><Question size={15} />本页引导</button><button type="button" onClick={() => setGuideMode('catalog')}>功能目录</button><button type="button" onClick={exitSession}>登录后使用完整功能</button></div>
          </div>
        ) : null}

        {agentNotice ? (
          <div className="topbar-agent-notice" role="status">
            <Lock size={14} />
            <span>{agentNotice}</span>
            <button type="button" aria-label="关闭自主 Agent 提示" onClick={() => setAgentNotice('')}><X size={13} /></button>
          </div>
        ) : null}

        <main className={`app-main${isAgentWorkspace ? ' is-agent-main' : ''}`}>
          <Outlet />
        </main>
      </div>
      <FeatureGuides mode={guideMode} onClose={closeGuide} role={session.role} userId={session.userId} />
    </div>
  )
}

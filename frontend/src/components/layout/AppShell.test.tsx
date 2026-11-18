import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from './AppShell'
import { availableGuides } from '../guides/feature-guides'
import { getMcpCapabilities, isDesktopClient } from '../../api/mcp-chat-api'

const auth = vi.hoisted(() => ({ role: 'GUEST' }))
vi.mock('../../auth/use-auth', () => ({ useAuth: () => ({ role: auth.role, userId: 'test-user', displayName: '游客', organizationName: '演示团队', email: 'guest@local' }) }))
vi.mock('../../desktop/DesktopUpdatePrompt', () => ({ DesktopUpdateIndicator: () => null }))
vi.mock('../../api/approvals-api', () => ({ getPendingApprovals: async () => ({ content: [], totalElements: 0 }) }))
vi.mock('../../api/follow-ups-api', () => ({ getFollowUpReminders: async () => ({ unreadCount: 0, items: [] }), readFollowUpReminder: async () => {}, readAllFollowUpReminders: async () => {} }))
vi.mock('../../api/mcp-chat-api', () => ({
  isDesktopClient: vi.fn(() => false),
  getMcpCapabilities: vi.fn(),
}))

function mount(initialEntry = '/app/today') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Routes>
          <Route path="/app" element={<AppShell />}>
            <Route path="today" element={<div>今日工作台内容</div>} />
            <Route path="customers" element={<div>客户管理内容</div>} />
            <Route path="agent" element={<div>自主 Agent 独立空间内容</div>} />
          </Route>
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

afterEach(() => { cleanup(); sessionStorage.clear() })
beforeEach(() => {
  auth.role = 'GUEST'
  vi.mocked(isDesktopClient).mockReturnValue(false)
  vi.mocked(getMcpCapabilities).mockResolvedValue({
    planCode: 'STARTER',
    svip: false,
    desktopClient: false,
    agentModeAvailable: false,
    defaultMode: 'LIGHT',
    availableModes: ['LIGHT'],
    unavailableReason: '自主 Agent 独立空间仅开放给桌面客户端和企业 SVIP 用户',
    agentCapabilities: [],
  })
})

const originalShow = HTMLDialogElement.prototype.showModal
const originalClose = HTMLDialogElement.prototype.close
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterAll(() => { HTMLDialogElement.prototype.showModal = originalShow; HTMLDialogElement.prototype.close = originalClose })

describe('guest guide', () => {
  it('offers detailed guides per feature, remembers dismissal and can be reopened', async () => {
    const user = userEvent.setup(); const view = mount()
    const dialog = screen.getByRole('dialog', { name: '功能使用指南' })
    expect(within(dialog).getByText(`已完成 0 / ${availableGuides('GUEST').length}`)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /企业知识库与带引用问答/ }))
    expect(within(dialog).getByRole('heading', { name: '核对回答来源' })).toBeInTheDocument()
    expect(within(dialog).getByRole('heading', { name: '维护资料版本' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /成员账号与角色权限/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '关闭使用引导' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(sessionStorage.getItem('sales-agent:guest-guide-seen')).toBe('true')
    view.unmount(); mount()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '打开功能使用指南' }))
    expect(screen.getByRole('dialog', { name: '功能使用指南' })).toBeInTheDocument()
  })
  it('makes all management guides available to an owner', async () => {
    auth.role = 'OWNER'
    const user = userEvent.setup(); mount()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '打开功能使用指南' }))
    const dialog = screen.getByRole('dialog', { name: '功能使用指南' })
    expect(within(dialog).getByText(`已完成 0 / ${availableGuides('OWNER').length}`)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /团队 Token 预算与成员分配/ })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /操作日志查询与审计/ })).toBeInTheDocument()
  })
  it('does not expose administrator guides to a read-only member', async () => {
    auth.role = 'VIEWER'
    const user = userEvent.setup(); mount()
    await user.click(screen.getByRole('button', { name: '打开功能使用指南' }))
    const dialog = screen.getByRole('dialog', { name: '功能使用指南' })
    expect(within(dialog).getByText(`已完成 0 / ${availableGuides('VIEWER').length}`)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /团队 Token 预算与成员分配/ })).not.toBeInTheDocument()
  })
})

describe('feature navigation', () => {
  it.each(['GUEST', 'VIEWER', 'SALES', 'MANAGER', 'ADMIN', 'OWNER'])('includes a usable guide for every navigation entry visible to %s', (role) => {
    auth.role = role
    mount()
    const sidebar = screen.getByRole('complementary', { name: '应用导航' })
    const guides = availableGuides(role)
    for (const link of within(sidebar).getAllByRole('link')) {
      const matching = guides.filter(guide => guide.path === link.getAttribute('href'))
      expect(matching.length, `缺少“${link.textContent}”的功能引导`).toBeGreaterThan(0)
      expect(matching.every(guide => guide.steps.length > 0 && guide.steps.every(step => step.title && step.description && step.target))).toBe(true)
    }
  })
  it('searches new commercial features and supports the keyboard shortcut', async () => {
    sessionStorage.setItem('sales-agent:guest-guide-seen', 'true')
    const user = userEvent.setup(); mount()
    await user.keyboard('{Control>}k{/Control}')
    const input = screen.getByRole('searchbox', { name: '搜索功能' })
    expect(input).toHaveFocus()
    await user.type(input, '报价')
    const results = screen.getByRole('navigation', { name: '功能搜索结果' })
    expect(within(results).getByRole('link', { name: '报价单' })).toHaveAttribute('href', '/app/quotes')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('navigation', { name: '功能搜索结果' })).not.toBeInTheDocument()
  })
  it('does not expose administrator destinations to members in search', async () => {
    auth.role = 'VIEWER'
    const user = userEvent.setup(); mount()
    await user.type(screen.getByRole('searchbox', { name: '搜索功能' }), '成员管理')
    expect(screen.getByText('未找到匹配功能，请尝试其他关键词。')).toBeInTheDocument()
  })
})

describe('workspace separation topbar', () => {
  it('defaults to 全部业务 with CRM sidebar and locks 自主 Agent for Web STARTER users', async () => {
    auth.role = 'SALES'
    const user = userEvent.setup()
    mount('/app/customers')

    expect(screen.getByRole('tab', { name: /全部业务/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('complementary', { name: '应用导航' })).toBeInTheDocument()
    expect(screen.getByText('客户管理内容')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '关闭窗口' })).not.toBeInTheDocument()

    const agentTab = screen.getByRole('tab', { name: /自主 Agent/ })
    expect(agentTab).toHaveAttribute('aria-disabled', 'true')
    await user.click(agentTab)
    expect(await screen.findByText(/自主 Agent 独立空间仅开放给桌面客户端和企业 SVIP 用户/)).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: '应用导航' })).toBeInTheDocument()
  })

  it('switches SVIP users between 全部业务 and standalone 自主 Agent workspace without CRM sidebar', async () => {
    auth.role = 'OWNER'
    vi.mocked(getMcpCapabilities).mockResolvedValue({
      planCode: 'SVIP',
      svip: true,
      desktopClient: false,
      agentModeAvailable: true,
      defaultMode: 'LIGHT',
      availableModes: ['LIGHT', 'AGENT'],
      unavailableReason: null,
      agentCapabilities: [],
    })
    const user = userEvent.setup()
    mount('/app/customers')

    const agentTab = screen.getByRole('tab', { name: /自主 Agent/ })
    await waitFor(() => expect(agentTab).toHaveAttribute('aria-disabled', 'false'))
    await user.click(agentTab)

    expect(await screen.findByText('自主 Agent 独立空间内容')).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: '应用导航' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /全部业务/ }))
    expect(await screen.findByText('客户管理内容')).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: '应用导航' })).toBeInTheDocument()
  })

  it('renders desktop window controls and unlocks 自主 Agent for desktop client users', async () => {
    auth.role = 'SALES'
    vi.mocked(isDesktopClient).mockReturnValue(true)
    const user = userEvent.setup()
    mount('/app/today')

    expect(screen.getByRole('button', { name: '最小化窗口' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '最大化窗口' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭窗口' })).toBeInTheDocument()

    const agentTab = screen.getByRole('tab', { name: /自主 Agent/ })
    expect(agentTab).toHaveAttribute('aria-disabled', 'false')
    await user.click(agentTab)
    expect(await screen.findByText('自主 Agent 独立空间内容')).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: '应用导航' })).not.toBeInTheDocument()
  })
})

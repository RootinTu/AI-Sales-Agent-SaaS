import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getMembers,
  getTeam,
  getTeamTokenBudget,
  resetMemberPassword,
  revokeMemberSessions,
  updateMemberTokenQuota,
  updateTeamTokenBudget,
} from '../api/admin-api'
import { getAiModelStatus } from '../api/ai-settings-api'
import { getAuditEvents } from '../api/audit-logs-api'
import { AdminMembersPage } from './AdminMembersPage'
import { AdminTeamPage } from './AdminTeamPage'
import { AuditLogsPage } from './AuditLogsPage'

vi.mock('../auth/use-auth', () => ({
  useAuth: () => ({ role: 'OWNER', memberId: 'owner-1', displayName: '团队所有者' }),
}))

vi.mock('../api/admin-api', () => ({
  getMembers: vi.fn(),
  createMember: vi.fn(),
  updateMember: vi.fn(),
  updateMemberTokenQuota: vi.fn(),
  getTeamTokenBudget: vi.fn(),
  updateTeamTokenBudget: vi.fn(),
  resetMemberPassword: vi.fn(),
  revokeMemberSessions: vi.fn(),
  getTeam: vi.fn(),
  updateTeam: vi.fn(),
}))

vi.mock('../api/ai-settings-api', () => ({
  getAiModelStatus: vi.fn(),
}))

vi.mock('../api/audit-logs-api', () => ({
  getAuditEvents: vi.fn(),
}))

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('Admin Console Enhancements', () => {
  beforeEach(() => {
    vi.mocked(getMembers).mockResolvedValue({
      content: [{
        id: 'member-2',
        userId: 'user-2',
        email: 'sales@example.test',
        displayName: '李销售',
        role: 'SALES',
        status: 'ACTIVE',
        joinedAt: '2026-10-01T08:00:00Z',
        lastLoginAt: '2026-11-18T08:00:00Z',
        createdAt: '2026-10-01T08:00:00Z',
        allocatedTokens: 50_000,
        usedTokens: 12_000,
        remainingTokens: 38_000,
      }],
      page: 0,
      size: 20,
      totalElements: 1,
      totalPages: 1,
      first: true,
      last: true,
    })
    vi.mocked(getTeamTokenBudget).mockResolvedValue({
      totalTokens: 200_000,
      allocatedTokens: 50_000,
      unallocatedTokens: 150_000,
    })
    vi.mocked(updateMemberTokenQuota).mockResolvedValue({
      id: 'member-2',
      userId: 'user-2',
      email: 'sales@example.test',
      displayName: '李销售',
      role: 'SALES',
      status: 'ACTIVE',
      joinedAt: '2026-10-01T08:00:00Z',
      lastLoginAt: '2026-11-18T08:00:00Z',
      createdAt: '2026-10-01T08:00:00Z',
      allocatedTokens: 80_000,
      usedTokens: 12_000,
      remainingTokens: 68_000,
    })
    vi.mocked(resetMemberPassword).mockResolvedValue(undefined)
    vi.mocked(revokeMemberSessions).mockResolvedValue({ revokedSessions: 2 })
    vi.mocked(getTeam).mockResolvedValue({
      id: 'org-1',
      slug: 'demo-team',
      name: '演示销售团队',
      timezone: 'Asia/Shanghai',
      locale: 'zh-CN',
      planCode: 'SVIP',
      status: 'ACTIVE',
      totalMembers: 4,
      activeMembers: 4,
      adminMembers: 1,
      createdAt: '2026-09-01T08:00:00Z',
      updatedAt: '2026-11-18T08:00:00Z',
    })
    vi.mocked(updateTeamTokenBudget).mockResolvedValue({
      totalTokens: 500_000,
      allocatedTokens: 50_000,
      unallocatedTokens: 450_000,
    })
    vi.mocked(getAiModelStatus).mockResolvedValue({
      provider: 'QWEN',
      model: 'qwen3.5-plus',
      baseUrl: 'https://example.test',
      apiKeyConfigured: true,
      ready: true,
      status: 'READY',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
        successfulCalls: 0,
        lastCalledAt: null,
        remainingTokens: null,
        remainingStatus: 'UNKNOWN',
        memberAllocatedTokens: null,
        memberUsedTokens: 0,
        memberRemainingTokens: null,
      },
    })
    vi.mocked(getAuditEvents).mockResolvedValue({
      content: [{
        id: 1,
        actorIdentifier: 'owner@example.test',
        action: 'HTTP_PUT',
        targetType: 'TEAM_MEMBER',
        targetId: 'member-2',
        result: 'SUCCEEDED',
        requestId: 'req-1',
        ipAddress: '127.0.0.1',
        userAgent: 'Chrome/130',
        metadata: { routePattern: '/api/v1/admin/members/{memberId}/password', status: 204, durationMs: 32 },
        occurredAt: '2026-11-19T01:00:00Z',
      }],
      page: 0,
      size: 20,
      totalElements: 1,
      totalPages: 1,
      first: true,
      last: true,
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('成员管理支持查看并调整 Token 额度、重置密码和强制下线', async () => {
    const user = userEvent.setup()
    wrap(<AdminMembersPage />)

    expect(await screen.findByText('李销售')).toBeInTheDocument()
    expect(screen.getByText('AI Token 额度')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '管理' }))
    const quotaInput = screen.getByLabelText('成员 Token 额度')
    await user.clear(quotaInput)
    await user.type(quotaInput, '80000')
    await user.click(screen.getByRole('button', { name: '保存额度' }))
    await waitFor(() => expect(updateMemberTokenQuota).toHaveBeenCalledWith('member-2', 80000))

    await user.type(screen.getByLabelText('重置新密码'), 'NewSecurePass123')
    await user.click(screen.getByRole('button', { name: '重置密码' }))
    await waitFor(() => expect(resetMemberPassword).toHaveBeenCalledWith('member-2', 'NewSecurePass123'))
    expect(await screen.findByText(/已重置登录密码/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '强制下线' }))
    await waitFor(() => expect(revokeMemberSessions).toHaveBeenCalledWith('member-2'))
    expect(await screen.findByText(/共吊销 2 个有效会话/)).toBeInTheDocument()
  })

  it('团队管理支持查看并保存团队 AI Token 总额及展示治理入口', async () => {
    const user = userEvent.setup()
    wrap(<AdminTeamPage />)

    expect(await screen.findByText('团队 AI Token 预算总控')).toBeInTheDocument()
    const totalInput = await screen.findByLabelText('团队 Token 总额')
    await user.clear(totalInput)
    await user.type(totalInput, '500000')
    await user.click(screen.getByRole('button', { name: '保存总额' }))

    await waitFor(() => expect(updateTeamTokenBudget).toHaveBeenCalledWith(500000))
    expect(await screen.findByText('团队 Token 总额已更新。')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /成员管理与额度分配/ })).toHaveAttribute('href', '/app/admin/members')
  })

  it('日志管理支持仅看失败快捷筛选和导出 CSV', async () => {
    const user = userEvent.setup()
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    wrap(<AuditLogsPage />)
    expect(await screen.findByText('owner@example.test')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /导出 CSV/ }))
    expect(createObjectURL).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock')

    await user.click(screen.getByRole('button', { name: /仅看失败/ }))
    await waitFor(() => expect(getAuditEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: 'FAILED' }),
    ))
  })
})

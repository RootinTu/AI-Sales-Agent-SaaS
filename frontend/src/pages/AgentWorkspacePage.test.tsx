import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentRuns, getAgentRunSteps } from '../api/agent-runs-api'
import { getAiModelStatus } from '../api/ai-settings-api'
import { getMcpCapabilities, getMcpConversations, getMcpMessages, isDesktopClient, streamMcpChatMessage } from '../api/mcp-chat-api'
import { AgentWorkspacePage } from './AgentWorkspacePage'

vi.mock('../auth/use-auth', () => ({
  useIsGuest: () => false,
  useAuth: () => ({ role: 'OWNER', memberId: 'member-1' }),
}))

vi.mock('../api/mcp-chat-api', () => ({
  isDesktopClient: vi.fn(() => false),
  getMcpCapabilities: vi.fn(),
  getMcpConversations: vi.fn(),
  getMcpMessages: vi.fn(),
  streamMcpChatMessage: vi.fn(),
}))

vi.mock('../api/ai-settings-api', () => ({
  getAiModelStatus: vi.fn(),
}))

vi.mock('../api/agent-runs-api', () => ({
  getAgentRuns: vi.fn(),
  getAgentRunSteps: vi.fn(),
}))

function mountAgentWorkspace() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <MemoryRouter initialEntries={['/app/agent']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/app/agent" element={<AgentWorkspacePage />} />
          <Route path="/app/today" element={<div>返回全部业务成功</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('AgentWorkspacePage', () => {
  beforeEach(() => {
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
    vi.mocked(getMcpConversations).mockResolvedValue({
      content: [],
      page: 0,
      size: 30,
      totalElements: 0,
      totalPages: 0,
      first: true,
      last: true,
    })
    vi.mocked(getMcpMessages).mockResolvedValue({
      content: [],
      page: 0,
      size: 100,
      totalElements: 0,
      totalPages: 0,
      first: true,
      last: true,
    })
    vi.mocked(getAiModelStatus).mockResolvedValue({
      provider: 'QWEN',
      model: 'qwen3.5-plus',
      baseUrl: 'https://example.test',
      apiKeyConfigured: true,
      ready: true,
      status: 'READY',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 0,
        totalTokens: 150,
        successfulCalls: 3,
        lastCalledAt: '2026-11-18T08:00:00Z',
        remainingTokens: null,
        remainingStatus: 'CHAT_API_DOES_NOT_RETURN_ACCOUNT_REMAINING',
        memberAllocatedTokens: 10_000,
        memberUsedTokens: 150,
        memberRemainingTokens: 9_850,
      },
    })
    vi.mocked(getAgentRuns).mockResolvedValue({
      content: [{
        id: 'run-1',
        name: '云岚科技自主分析',
        triggerType: 'MCP',
        status: 'COMPLETED',
        businessDate: '2026-11-18',
        scope: {},
        outputSummary: {},
        totalCandidates: 1,
        processedCount: 1,
        succeededCount: 1,
        skippedCount: 0,
        failedCount: 0,
        pendingApprovalCount: 1,
        errorMessage: null,
        queuedAt: '2026-11-18T08:00:00Z',
        startedAt: '2026-11-18T08:00:01Z',
        completedAt: '2026-11-18T08:00:03Z',
        createdAt: '2026-11-18T08:00:00Z',
      }],
      page: 0,
      size: 20,
      totalElements: 1,
      totalPages: 1,
      first: true,
      last: true,
    })
    vi.mocked(getAgentRunSteps).mockResolvedValue({
      content: [{
        id: 'step-1',
        customerId: 'customer-1',
        sequenceNo: 1,
        stepType: 'TOOL',
        name: '读取客户历史与报价',
        status: 'COMPLETED',
        inputSnapshot: {},
        outputSnapshot: {},
        errorMessage: null,
        startedAt: '2026-11-18T08:00:01Z',
        completedAt: '2026-11-18T08:00:02Z',
        durationMs: 320,
      }],
      page: 0,
      size: 20,
      totalElements: 1,
      totalPages: 1,
      first: true,
      last: true,
    })
    vi.mocked(streamMcpChatMessage).mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('未授权网页普通版直接访问时展示锁定页并可返回全部业务', async () => {
    const user = userEvent.setup()
    mountAgentWorkspace()

    expect(await screen.findByRole('heading', { name: '自主 Agent 独立空间未解锁' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '返回全部业务' }))
    expect(await screen.findByText('返回全部业务成功')).toBeInTheDocument()
  })

  it('企业 SVIP 用户可在独立空间发送 AGENT 指令、切换子视图并返回全部业务', async () => {
    vi.mocked(getMcpCapabilities).mockResolvedValue({
      planCode: 'SVIP',
      svip: true,
      desktopClient: false,
      agentModeAvailable: true,
      defaultMode: 'LIGHT',
      availableModes: ['LIGHT', 'AGENT'],
      unavailableReason: null,
      agentCapabilities: ['多轮记忆', 'ReAct 多步推理'],
    })
    vi.mocked(streamMcpChatMessage).mockResolvedValue({
      conversationId: 'c2',
      messageId: 'm2',
      role: 'assistant',
      content: '已完成多步推理并起草邮件。',
      reasoningSummary: '自主 Agent 共执行 2 步工具推理',
      toolTraces: [{ name: 'assistant.agent.step', status: 'SUCCEEDED', summary: '第 1 步：查客户档案' }],
      data: { assistantMode: 'AGENT' },
      createdAt: '2026-11-18T08:00:00Z',
    })
    const user = userEvent.setup()
    mountAgentWorkspace()

    expect(await screen.findByText('企业 SVIP专享')).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText(/自主 Agent 模式/), '查云岚科技报价并写邮件')
    await user.click(screen.getByRole('button', { name: /发送指令/ }))
    await waitFor(() => expect(streamMcpChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'AGENT' }),
      expect.any(Function),
      expect.any(AbortSignal),
    ))
    expect(await screen.findByText('已完成多步推理并起草邮件。')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '运行历史与轨迹' }))
    expect(await screen.findByRole('heading', { name: '云岚科技自主分析' })).toBeInTheDocument()
    expect(await screen.findByText('读取客户历史与报价')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '工具与知识范围' }))
    expect(screen.getByText('knowledge.query')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: '填入示例指令到对话' })[0])
    expect(screen.getByPlaceholderText(/自主 Agent 模式/)).toHaveValue('帮我检索云岚科技的最新档案、互动记录和有效报价单。')

    await user.click(screen.getByRole('button', { name: '切回全部业务' }))
    expect(await screen.findByText('返回全部业务成功')).toBeInTheDocument()
  })

  it('桌面客户端用户无需 SVIP 也可直接进入自主 Agent 空间', async () => {
    vi.mocked(isDesktopClient).mockReturnValue(true)
    mountAgentWorkspace()

    expect(await screen.findByText('桌面客户端专享')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/自主 Agent 模式/)).toBeInTheDocument()
  })
})

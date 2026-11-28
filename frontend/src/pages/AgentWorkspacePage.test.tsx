import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentRuns, getAgentRunSteps } from '../api/agent-runs-api'
import { calibrateAgentAfp, getAiModelStatus } from '../api/ai-settings-api'
import { getMcpCapabilities, getMcpConversations, getMcpMessages, isDesktopClient, streamMcpChatMessage } from '../api/mcp-chat-api'
import { AgentWorkspacePage } from './AgentWorkspacePage'

vi.mock('../auth/use-auth', () => ({
  useIsGuest: () => false,
  useAuth: () => ({ role: 'OWNER', memberId: 'member-1', organizationId: 'org-1' }),
}))

vi.mock('../api/mcp-chat-api', () => ({
  isDesktopClient: vi.fn(() => false),
  getMcpCapabilities: vi.fn(),
  getMcpConversations: vi.fn(),
  deleteMcpConversation: vi.fn(),
  getMcpMessages: vi.fn(),
  streamMcpChatMessage: vi.fn(),
}))

vi.mock('../api/ai-settings-api', () => ({
  getAiModelStatus: vi.fn(),
  calibrateAgentAfp: vi.fn(),
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
    window.localStorage.clear()
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

  it('支持左下角一键切换 Agent 模型、展示独立 Agent 用量，并可切换本地存储模式', async () => {
    vi.mocked(isDesktopClient).mockReturnValue(true)
    vi.mocked(getAiModelStatus).mockResolvedValue({
      provider: 'QWEN',
      model: 'qwen4-max',
      embeddingModel: 'qwen3.7-text-embedding-flash',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKeyConfigured: true,
      ready: true,
      status: 'READY',
      agent: {
        enabled: true,
        provider: 'VOLCENGINE_ARK',
        model: 'doubao-seed-2.1-pro',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
        apiKeyConfigured: true,
        ready: true,
        status: 'READY',
        availableModels: ['doubao-seed-2.0-mini', 'doubao-seed-2.1-lite', 'doubao-seed-2.1-pro', 'deepseek-v4-pro', 'kimi-k3.1-pro'],
      },
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 0,
        totalTokens: 150,
        successfulCalls: 3,
        lastCalledAt: '2026-11-18T08:00:00Z',
        remainingTokens: null,
        remainingStatus: 'CHAT_API_DOES_NOT_RETURN_ACCOUNT_REMAINING',
        // 即便 MCP 免费对话额度为 0，Agent 独立通道也应正常可用
        memberAllocatedTokens: 0,
        memberUsedTokens: 0,
        memberRemainingTokens: 0,
        agent: {
          inputTokens: 1200,
          outputTokens: 800,
          cachedInputTokens: 0,
          totalTokens: 2000,
          successfulCalls: 6,
          lastCalledAt: '2026-11-18T09:00:00Z',
          totalEstimatedAfp: 0.5,
          last5HoursAfp: 0.5,
          last7DaysAfp: 0.5,
          last30DaysAfp: 0.5,
          fiveHourAfpLimit: 2000,
          weeklyAfpLimit: 7000,
          monthlyAfpLimit: 20000,
          models: [{
            provider: 'VOLCENGINE_ARK',
            model: 'doubao-seed-2.1-pro',
            inputTokens: 1200,
            outputTokens: 800,
            cachedInputTokens: 0,
            totalTokens: 2000,
            successfulCalls: 6,
            lastCalledAt: '2026-11-18T09:00:00Z',
            estimatedAfp: 0.5,
          }],
        },
      },
    })
    vi.mocked(streamMcpChatMessage).mockResolvedValue({
      conversationId: 'local-conv-1',
      messageId: 'local-msg-1',
      role: 'assistant',
      content: '已使用 deepseek-v4-pro 在本地会话完成分析。',
      reasoningSummary: '本地会话不写入服务器表',
      toolTraces: [],
      data: { assistantMode: 'AGENT', storageMode: 'LOCAL' },
      createdAt: '2026-11-18T09:05:00Z',
    })
    const user = userEvent.setup()
    mountAgentWorkspace()

    // 左侧栏不再堆叠 MCP Token 分配按钮，点击顶栏用量胶囊即可展开独立 Agent AFP 统计
    expect(screen.queryByRole('button', { name: 'Token 分配' })).not.toBeInTheDocument()
    const usagePill = await screen.findByRole('button', { name: '查看自主 Agent 通道与用量' })
    await user.click(usagePill)
    expect(await screen.findByLabelText('自主 Agent 用量统计')).toBeInTheDocument()
    expect(screen.getByText('独立通道已就绪')).toBeInTheDocument()
    expect(screen.getByLabelText('Agent 燃料值 AFP 估算')).toBeInTheDocument()
    vi.mocked(calibrateAgentAfp).mockResolvedValue({
      provider: 'QWEN',
      model: 'qwen4-max',
      embeddingModel: 'qwen3.7-text-embedding-flash',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKeyConfigured: true,
      ready: true,
      status: 'READY',
      agent: {
        enabled: true,
        provider: 'VOLCENGINE_ARK',
        model: 'doubao-seed-2.1-pro',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
        apiKeyConfigured: true,
        ready: true,
        status: 'READY',
        availableModels: ['doubao-seed-2.0-mini', 'doubao-seed-2.1-lite', 'doubao-seed-2.1-pro', 'deepseek-v4-pro', 'kimi-k3.1-pro'],
      },
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 0,
        totalTokens: 150,
        successfulCalls: 3,
        lastCalledAt: '2026-11-18T08:00:00Z',
        remainingTokens: null,
        remainingStatus: 'CHAT_API_DOES_NOT_RETURN_ACCOUNT_REMAINING',
        memberAllocatedTokens: 0,
        memberUsedTokens: 0,
        memberRemainingTokens: 0,
        agent: {
          inputTokens: 1200,
          outputTokens: 800,
          cachedInputTokens: 0,
          totalTokens: 2000,
          successfulCalls: 6,
          lastCalledAt: '2026-11-18T09:00:00Z',
          totalEstimatedAfp: 95,
          last5HoursAfp: 95,
          last7DaysAfp: 95,
          last30DaysAfp: 95,
          fiveHourAfpLimit: 2000,
          weeklyAfpLimit: 7000,
          monthlyAfpLimit: 20000,
          calibratedAt: '2026-11-18T09:10:00Z',
          models: [],
        },
      },
    })
    await user.click(screen.getByRole('button', { name: '查看完整看板' }))
    expect(await screen.findByRole('heading', { name: 'Agent 通道与燃料值（AFP）看板' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '校准控制台 AFP' }))
    const calInput = screen.getByLabelText('近 5 小时已用 AFP')
    await user.clear(calInput)
    await user.type(calInput, '95')
    await user.click(screen.getByRole('button', { name: '保存校准' }))
    await waitFor(() => expect(calibrateAgentAfp).toHaveBeenCalledWith(
      expect.objectContaining({ fiveHourUsedAfp: 95 }),
      expect.anything(),
    ))
    await user.click(screen.getByRole('button', { name: '回到自主对话' }))

    // 左下角一键选模型：左右分栏，左侧切换分类、右侧选择模型
    await user.click(screen.getByRole('button', { name: '选择 Agent 模型' }))
    expect(screen.getByRole('tab', { name: /文本生成（极速）/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /文本生成（标准）/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /文本生成（进阶）/ })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /文本生成（极速）/ }))
    expect(screen.getByRole('option', { name: /doubao-seed-2\.0-mini/ })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /文本生成（进阶）/ }))
    await user.click(screen.getByRole('option', { name: /deepseek-v4-pro/ }))

    // 切换到「存本地」会话存储模式
    await user.click(screen.getByRole('button', { name: /存本地/ }))
    expect(screen.getByText(/仅存本机，不写入云端会话表/)).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText(/自主 Agent 模式/), '帮我梳理本地草稿')
    await user.click(screen.getByRole('button', { name: /发送指令/ }))

    await waitFor(() => expect(streamMcpChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'AGENT',
        model: 'deepseek-v4-pro',
        storageMode: 'LOCAL',
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    ))
    expect(await screen.findByText('已使用 deepseek-v4-pro 在本地会话完成分析。')).toBeInTheDocument()
    // 本地会话应立即出现在左侧会话列表中，并带删除按钮
    expect(await screen.findByRole('button', { name: /^帮我梳理本地草稿/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除会话 帮我梳理本地草稿' })).toBeInTheDocument()
  })
})

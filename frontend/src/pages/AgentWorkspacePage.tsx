import {
  ArrowLeft,
  BookOpen,
  ChatCircleDots,
  CheckCircle,
  Clock,
  Lock,
  PlusSquare,
  Robot,
  ShieldCheck,
  Sparkle,
  WarningCircle,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { getAgentRuns, getAgentRunSteps, type AgentRunPage } from '../api/agent-runs-api'
import * as mcpChatApi from '../api/mcp-chat-api'
import { isDesktopClient, type AssistantCapabilities } from '../api/mcp-chat-api'
import { useAuth, useIsGuest } from '../auth/use-auth'
import {
  formatTime,
  useAssistantChatSession,
  type AssistantToolGuide,
  type ChatMessage,
} from '../components/assistant/assistant-session'
import {
  AssistantConversationPane,
  ModelInfoPanel,
  TokenAllocationDialog,
} from '../components/assistant/AssistantWorkspaceParts'

type AgentWorkspaceTab = 'chat' | 'runs' | 'tools'

const agentToolGuides: AssistantToolGuide[] = [
  {
    tool: 'agent.react.email',
    label: '全景分析并起草邮件',
    say: '先查一下云岚科技最近的聊天记录和报价，结合企业知识库折扣政策，帮我起草一封有针对性的跟进邮件。',
    result: '自主跨模块检索客户档案、沟通记录、报价和知识库，并撰写待审批定制邮件',
  },
  {
    tool: 'agent.react.pipeline',
    label: '商机与报价联动排查',
    say: '帮我查一下当前进行中的商机和关联报价单，看看哪些客户需要先安排跟进任务。',
    result: '多步读取商机与报价单状态，梳理推进优先级',
  },
  {
    tool: 'agent.react.memory',
    label: '连续多轮追问',
    say: '帮我检索近期互动过的客户，列出最需要今天联系的 3 家并说明原因。',
    result: '结合上下文记忆进行连续追问与多步执行',
  },
]

const agentToolGroups = [
  {
    title: 'CRM 只读检索（自主读取）',
    scope: '跨模块采集客户档案、沟通背景与商机报价现状',
    items: ['customer.search', 'customer.detail', 'interaction.list', 'opportunity.list', 'quote.list', 'mail.list'],
    samplePrompt: '帮我检索云岚科技的最新档案、互动记录和有效报价单。',
  },
  {
    title: 'Agentic RAG 知识库问答',
    scope: '检索企业产品定价、签约合规、实施交付政策并返回可核对引用',
    items: ['knowledge.query'],
    samplePrompt: '查一下知识库里的私有化报价与审批折扣规则，总结重点。',
  },
  {
    title: '低/中风险业务动作（自主执行）',
    scope: '按用户目标直接新建客户、导入沟通、创建商机与跟进任务',
    items: ['customer.create', 'interaction.chat_import', 'opportunity.create', 'follow_up.create', 'follow_up.list', 'agent.sales_follow_up.run'],
    samplePrompt: '帮我梳理近期互动过的客户并给优先客户建立跟进任务。',
  },
  {
    title: '高风险外发与人工门控（强制审批）',
    scope: '邮件正文由大模型结合上下文起草，并生成审批单交由人工确认',
    items: ['email.draft.intelligent', 'approval.list', 'approval.approve', 'approval.reject'],
    samplePrompt: '先查一下云岚科技最近沟通和报价，再起草一封待审批跟进邮件。',
  },
]

const agentWelcomeMessage: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content: '已进入独立的自主销售 Agent 工作空间。在这里下达跨模块业务目标，我会自动结合多轮上下文记忆、执行最多 5 步 ReAct 规划与纠错，并将生成的跟进任务与待审批动作自动回写业务工作台。',
  reasoningSummary: '等待用户下达自主任务目标。',
  createdAt: new Date().toISOString(),
}

/**
 * 独立的「自主 Agent」工作空间（通过顶部全局切换栏进入，与业务侧边栏彻底切割）。
 * 仅开放给 Tauri 桌面客户端与企业 SVIP 组织。
 */
export function AgentWorkspacePage() {
  const session = useAuth()
  const isGuest = useIsGuest()
  const navigate = useNavigate()
  const desktopClient = isDesktopClient()
  const [activeTab, setActiveTab] = useState<AgentWorkspaceTab>('chat')
  const [tokenAllocationOpen, setTokenAllocationOpen] = useState(false)

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
    enabled: !isGuest,
  })

  const capabilities = capabilitiesQuery.data
  const agentModeAvailable = !isGuest && Boolean(capabilities?.agentModeAvailable || desktopClient)
  const accessBadgeLabel = capabilities?.svip ? '企业 SVIP' : '桌面客户端'

  function returnToBusinessWorkspace() {
    const savedPath = sessionStorage.getItem('sales-agent:last-business-path')
    navigate(savedPath && savedPath.startsWith('/app') && !savedPath.startsWith('/app/agent') ? savedPath : '/app/today')
  }

  if (isGuest || (!capabilitiesQuery.isLoading && !agentModeAvailable)) {
    return (
      <section className="agent-locked-page" aria-label="自主 Agent 权限说明">
        <div className="agent-locked-card">
          <span className="agent-locked-icon"><Lock size={26} /></span>
          <h1>自主 Agent 独立空间未解锁</h1>
          <p>{capabilities?.unavailableReason ?? '自主 Agent 独立空间仅开放给桌面客户端与企业 SVIP 用户。当前账号可继续在全部业务中使用日常 CRM 模块与轻辅助 MCP 助手。'}</p>
          <button type="button" className="button button-primary" onClick={returnToBusinessWorkspace}>
            <ArrowLeft size={16} />返回全部业务
          </button>
        </div>
      </section>
    )
  }

  return (
    <AgentAuthorizedWorkspace
      role={session.role}
      accessBadgeLabel={accessBadgeLabel}
      activeTab={activeTab}
      onChangeTab={setActiveTab}
      tokenAllocationOpen={tokenAllocationOpen}
      onOpenTokenAllocation={() => setTokenAllocationOpen(true)}
      onCloseTokenAllocation={() => setTokenAllocationOpen(false)}
      onReturnBusiness={returnToBusinessWorkspace}
    />
  )
}

function AgentAuthorizedWorkspace({
  role,
  accessBadgeLabel,
  activeTab,
  onChangeTab,
  tokenAllocationOpen,
  onOpenTokenAllocation,
  onCloseTokenAllocation,
  onReturnBusiness,
}: {
  role: string
  accessBadgeLabel: string
  activeTab: AgentWorkspaceTab
  onChangeTab: (tab: AgentWorkspaceTab) => void
  tokenAllocationOpen: boolean
  onOpenTokenAllocation: () => void
  onCloseTokenAllocation: () => void
  onReturnBusiness: () => void
}) {
  const chat = useAssistantChatSession({
    mode: 'AGENT',
    welcomeMessage: agentWelcomeMessage,
    guestDemoMessages: [],
    pendingProgressText: '自主 Agent 正在启动多步规划…',
  })

  return (
    <section className="agent-workspace-page">
      <div className="agent-workspace-layout">
        <aside className="agent-ws-sidebar" aria-label="Agent 空间导航">
          <div className="agent-ws-sidebar-top">
            <div className="agent-ws-brand">
              <span className="agent-ws-brand-badge"><Robot size={18} /></span>
              <div>
                <strong>自主 Agent 空间</strong>
                <small>{accessBadgeLabel}专享</small>
              </div>
            </div>
            <button
              type="button"
              className="button button-primary agent-new-task-button"
              disabled={chat.isPending}
              onClick={() => {
                chat.startNewConversation()
                onChangeTab('chat')
              }}
            >
              <PlusSquare size={16} />
              <span>新建 Agent 任务</span>
            </button>
            <nav className="agent-ws-nav" aria-label="Agent 工作台视图">
              <button type="button" className={activeTab === 'chat' ? 'is-active' : ''} onClick={() => onChangeTab('chat')}>
                <ChatCircleDots size={16} />
                <span>自主对话与执行</span>
              </button>
              <button type="button" className={activeTab === 'runs' ? 'is-active' : ''} onClick={() => onChangeTab('runs')}>
                <Clock size={16} />
                <span>运行历史与轨迹</span>
              </button>
              <button type="button" className={activeTab === 'tools' ? 'is-active' : ''} onClick={() => onChangeTab('tools')}>
                <BookOpen size={16} />
                <span>工具与知识范围</span>
              </button>
            </nav>
          </div>

          <div className="agent-ws-history">
            <p className="agent-ws-section-label">最近 Agent 会话</p>
            {chat.conversations.length === 0 ? (
              <div className="mcp-empty-history">
                <Robot size={40} />
                <p>{chat.conversationsQuery.isLoading ? '正在读取会话…' : '暂无历史会话'}</p>
              </div>
            ) : (
              <div className="mcp-history-list">
                {chat.conversations.map((conversation) => (
                  <button
                    key={conversation.id}
                    type="button"
                    className={conversation.id === chat.activeConversationId ? 'is-active' : ''}
                    disabled={chat.isPending}
                    onClick={() => {
                      chat.selectConversation(conversation.id)
                      onChangeTab('chat')
                    }}
                  >
                    <strong>{conversation.title}</strong>
                    <span>{formatTime(conversation.lastMessageAt ?? conversation.createdAt)} · {conversation.channel}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="agent-ws-sidebar-bottom">
            <ModelInfoPanel
              status={chat.modelQuery.data}
              loading={chat.modelQuery.isLoading}
              canAllocate={role === 'OWNER' || role === 'ADMIN'}
              onAllocate={onOpenTokenAllocation}
            />
            <button type="button" className="agent-return-button" onClick={onReturnBusiness}>
              <ArrowLeft size={15} />
              <span>切回全部业务</span>
            </button>
          </div>
        </aside>

        <section className="agent-ws-main">
          {activeTab === 'chat' ? (
            <div className="mcp-chat-panel agent-chat-panel">
              <header className="mcp-chat-header">
                <div className="agent-chat-title">
                  <span className="agent-live-dot" aria-hidden />
                  <div>
                    <h1>自主销售 Agent 工作台</h1>
                    <p>多轮短期记忆 · 5 步 ReAct 自主规划 · 跨模块读写与知识库引用</p>
                  </div>
                </div>
                <span className="mcp-status"><Sparkle size={14} />{chat.readableStatus}</span>
              </header>

              <AssistantConversationPane
                session={chat}
                guides={agentToolGuides}
                guidesAriaLabel="Agent 快捷指令"
                emptyTitle="自主销售 Agent 工作台"
                emptyIntro="在这里向 Agent 下达复杂销售目标。支持多轮连续追问、跨客户/互动/商机/报价/知识库多步推理，并自动生成高风险待审批邮件；产物会实时同步回业务工作台。"
                loadingHistoryTitle="正在加载 Agent 记忆上下文"
                attachmentAriaLabel="选择 Agent 附件"
                placeholder={chat.quotaUnavailable ? '尚未分配 Token 额度，请联系管理员' : '自主 Agent 模式：输入跨模块目标或连续追问（按 Enter 发送，Shift + Enter 换行）'}
                extraFooterMeta={<span><Robot size={15} />ReAct 多步自主规划</span>}
              />
            </div>
          ) : activeTab === 'runs' ? (
            <AgentRunsPanel onBackToChat={() => onChangeTab('chat')} />
          ) : (
            <AgentToolsPanel
              onUsePrompt={(prompt) => {
                onChangeTab('chat')
                chat.applyToolTemplate(prompt)
              }}
              onBackToChat={() => onChangeTab('chat')}
            />
          )}
        </section>
      </div>
      {tokenAllocationOpen ? <TokenAllocationDialog onClose={onCloseTokenAllocation} /> : null}
    </section>
  )
}

function AgentRunsPanel({ onBackToChat }: { onBackToChat: () => void }) {
  const runsQuery = useQuery({
    queryKey: ['agent-runs'],
    queryFn: getAgentRuns,
    refetchInterval: (query) => {
      const runs = (query.state.data as AgentRunPage | undefined)?.content ?? []
      return runs.some((run) => run.status === 'RUNNING' || run.status === 'WAITING_APPROVAL') ? 3000 : false
    },
  })
  const runs = useMemo(() => runsQuery.data?.content ?? [], [runsQuery.data])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedRun = runs.find((run) => run.id === selectedId) ?? runs[0]
  const stepsQuery = useQuery({
    queryKey: ['agent-run-steps', selectedRun?.id],
    queryFn: () => getAgentRunSteps(selectedRun!.id),
    enabled: Boolean(selectedRun?.id),
  })

  return (
    <div className="agent-subview-container">
      <header className="agent-subview-header">
        <div>
          <h1>运行历史与步骤轨迹</h1>
          <p>追踪每次 Agent 自主分析与业务执行的输入、耗时和待审批产出。</p>
        </div>
        <button type="button" className="button button-secondary" onClick={onBackToChat}>
          回到自主对话
        </button>
      </header>
      <div className="agent-subview-body runs-layout">
        <section className="surface run-history-panel">
          <div className="module-toolbar"><div><h2>最近运行</h2><span>{runsQuery.isPending ? '读取中…' : `共 ${runs.length} 条记录`}</span></div></div>
          <div className="run-history-list">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                className={selectedRun?.id === run.id ? 'run-history-item is-selected' : 'run-history-item'}
                onClick={() => setSelectedId(run.id)}
              >
                <span className="run-icon"><Robot size={16} /></span>
                <span><strong>{run.name}</strong><small>处理 {run.processedCount}/{run.totalCandidates} · {run.status}</small></span>
                <time>{formatTime(run.createdAt)}</time>
              </button>
            ))}
            {!runsQuery.isPending && runs.length === 0 ? (
              <div className="approval-empty"><Robot size={24} /><strong>暂无运行记录</strong><span>可以在“自主对话与执行”中下达多步任务开始运行。</span></div>
            ) : null}
          </div>
        </section>

        <section className="surface run-detail-panel">
          {selectedRun ? (
            <>
              <div className="panel-header">
                <div><h2>{selectedRun.name}</h2><p>{selectedRun.triggerType}</p></div>
                <span className="status-badge">{selectedRun.status}</span>
              </div>
              <div className="execution-flow" aria-label="执行步骤">
                {(stepsQuery.data?.content ?? []).map((step) => (
                  <div key={step.id}>
                    <span>{step.status === 'FAILED' ? <WarningCircle size={15} /> : <CheckCircle size={15} />}</span>
                    <strong>{step.name}</strong>
                    <small>{step.durationMs ?? 0} ms</small>
                  </div>
                ))}
                {stepsQuery.isPending ? <div><span><Clock size={15} /></span><strong>正在读取步骤</strong><small>请稍候</small></div> : null}
              </div>
            </>
          ) : (
            <div className="approval-empty"><Clock size={22} /><strong>请选择一条运行记录查看详细步骤</strong></div>
          )}
        </section>
      </div>
    </div>
  )
}

function AgentToolsPanel({ onUsePrompt, onBackToChat }: {
  onUsePrompt: (prompt: string) => void
  onBackToChat: () => void
}) {
  return (
    <div className="agent-subview-container">
      <header className="agent-subview-header">
        <div>
          <h1>工具能力与知识范围（17 项）</h1>
          <p>UI 与业务侧栏彻底解耦，Agent 底层通过安全受控的工具接口读取客户/商机/报价与知识库，高风险动作均需审批确认。</p>
        </div>
        <button type="button" className="button button-secondary" onClick={onBackToChat}>
          回到自主对话
        </button>
      </header>
      <div className="agent-tools-grid">
        {agentToolGroups.map((group) => (
          <article key={group.title} className="surface agent-tool-card">
            <div className="agent-tool-card-head">
              <strong><ShieldCheck size={16} />{group.title}</strong>
              <p>{group.scope}</p>
            </div>
            <div className="agent-tool-badges">
              {group.items.map((toolName) => (
                <code key={toolName}>{toolName}</code>
              ))}
            </div>
            <button type="button" className="button button-secondary" onClick={() => onUsePrompt(group.samplePrompt)}>
              填入示例指令到对话
            </button>
          </article>
        ))}
      </div>
    </div>
  )
}

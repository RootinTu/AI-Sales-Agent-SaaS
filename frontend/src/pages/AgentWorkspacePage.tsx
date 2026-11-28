import {
  ArrowLeft,
  BookOpen,
  CaretDown,
  ChartBar,
  ChatCircleDots,
  Check,
  CheckCircle,
  Clock,
  Cloud,
  GearSix,
  HardDrive,
  Lock,
  PlusSquare,
  Robot,
  ShieldCheck,
  Sparkle,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { getAgentRuns, getAgentRunSteps, type AgentRunPage } from '../api/agent-runs-api'
import { calibrateAgentAfp, getAiModelStatus, type AiModelStatus } from '../api/ai-settings-api'
import * as mcpChatApi from '../api/mcp-chat-api'
import { isDesktopClient, type AssistantCapabilities, type AssistantStorageMode } from '../api/mcp-chat-api'
import { useAuth, useIsGuest } from '../auth/use-auth'
import {
  readPreferredAgentModel,
  readPreferredAgentStorageMode,
  savePreferredAgentModel,
  savePreferredAgentStorageMode,
} from '../components/assistant/agent-local-storage'
import {
  AGENT_PLAN_SMALL_DEFAULTS,
  formatAfpCoeff,
  formatAfpValue,
  getAgentModelMeta,
  groupAgentModelsByTier,
} from '../components/assistant/agent-model-catalog'
import {
  formatCompactNumber,
  formatTime,
  useAssistantChatSession,
  type AssistantToolGuide,
  type ChatMessage,
} from '../components/assistant/assistant-session'
import {
  AssistantConversationPane,
} from '../components/assistant/AssistantWorkspaceParts'

type AgentWorkspaceTab = 'chat' | 'runs' | 'tools' | 'usage'

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
      storageScope={`${session.organizationId || 'org'}:${session.memberId || 'member'}`}
      accessBadgeLabel={accessBadgeLabel}
      activeTab={activeTab}
      onChangeTab={setActiveTab}
      onReturnBusiness={returnToBusinessWorkspace}
    />
  )
}

function AgentAuthorizedWorkspace({
  storageScope,
  accessBadgeLabel,
  activeTab,
  onChangeTab,
  onReturnBusiness,
}: {
  storageScope: string
  accessBadgeLabel: string
  activeTab: AgentWorkspaceTab
  onChangeTab: (tab: AgentWorkspaceTab) => void
  onReturnBusiness: () => void
}) {
  const [storageMode, setStorageMode] = useState<AssistantStorageMode>(() => readPreferredAgentStorageMode(storageScope))
  const [preferredModel, setPreferredModel] = useState<string>(() => readPreferredAgentModel(storageScope))

  const modelStatusQuery = useQuery({
    queryKey: ['ai-model-status'],
    queryFn: getAiModelStatus,
  })
  const modelStatus = modelStatusQuery.data

  const agentModels = useMemo(() => {
    const agent = modelStatus?.agent
    if (!agent?.enabled || !agent.ready) return []
    const list = agent.availableModels && agent.availableModels.length > 0
      ? agent.availableModels
      : (agent.model ? [agent.model] : [])
    return Array.from(new Set(list.filter(Boolean)))
  }, [modelStatus])

  const defaultMcpModel = modelStatus?.model ?? 'qwen4-max'
  const effectiveModel = useMemo(() => {
    if (preferredModel) {
      if (agentModels.includes(preferredModel)) return preferredModel
      if (preferredModel === defaultMcpModel) return preferredModel
    }
    if (agentModels.length > 0) return modelStatus?.agent?.model || agentModels[0]
    return defaultMcpModel
  }, [preferredModel, agentModels, defaultMcpModel, modelStatus?.agent?.model])

  const usesIndependentChannel = Boolean(modelStatus?.agent?.enabled && modelStatus.agent.ready && agentModels.includes(effectiveModel))

  const chat = useAssistantChatSession({
    mode: 'AGENT',
    welcomeMessage: agentWelcomeMessage,
    guestDemoMessages: [],
    pendingProgressText: '自主 Agent 正在启动多步规划…',
    selectedModel: effectiveModel,
    usesIndependentChannel,
    storageMode,
    storageScope,
  })

  function handleSelectModel(nextModel: string) {
    setPreferredModel(nextModel)
    savePreferredAgentModel(storageScope, nextModel)
  }

  function handleChangeStorageMode(nextMode: AssistantStorageMode) {
    if (nextMode === storageMode || chat.isPending) return
    setStorageMode(nextMode)
    savePreferredAgentStorageMode(storageScope, nextMode)
    chat.startNewConversation()
  }

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
              <button type="button" className={activeTab === 'usage' ? 'is-active' : ''} onClick={() => onChangeTab('usage')}>
                <ChartBar size={16} />
                <span>通道与用量</span>
              </button>
            </nav>
          </div>

          <div className="agent-ws-history">
            <div className="agent-ws-history-head">
              <p className="agent-ws-section-label">Agent 会话</p>
              <div className="agent-storage-switch" role="group" aria-label="Agent 会话存储方式">
                <button
                  type="button"
                  aria-pressed={storageMode === 'LOCAL'}
                  className={storageMode === 'LOCAL' ? 'is-active' : ''}
                  disabled={chat.isPending}
                  onClick={() => handleChangeStorageMode('LOCAL')}
                >
                  <HardDrive size={12} />
                  <span>存本地</span>
                </button>
                <button
                  type="button"
                  aria-pressed={storageMode === 'CLOUD'}
                  className={storageMode === 'CLOUD' ? 'is-active' : ''}
                  disabled={chat.isPending}
                  onClick={() => handleChangeStorageMode('CLOUD')}
                >
                  <Cloud size={12} />
                  <span>存线上</span>
                </button>
              </div>
            </div>
            <p className="agent-storage-hint">
              {storageMode === 'LOCAL'
                ? '仅存本机，不写入云端会话表'
                : '云端独立保存，不随 MCP 清除'}
            </p>
            {chat.conversations.length === 0 ? (
              <div className="mcp-empty-history">
                <Robot size={36} />
                <p>{storageMode === 'CLOUD' && chat.conversationsQuery.isLoading ? '正在读取云端会话…' : storageMode === 'LOCAL' ? '暂无本地会话' : '暂无云端会话'}</p>
              </div>
            ) : (
              <div className="mcp-history-list">
                {chat.conversations.map((conversation) => (
                  <div
                    key={conversation.id}
                    className={`mcp-history-item-wrap${conversation.id === chat.activeConversationId ? ' is-active' : ''}`}
                  >
                    <button
                      type="button"
                      className={conversation.id === chat.activeConversationId ? 'is-active' : ''}
                      disabled={chat.isPending}
                      onClick={() => {
                        chat.selectConversation(conversation.id)
                        onChangeTab('chat')
                      }}
                    >
                      <strong>{conversation.title}</strong>
                      <span>
                        {formatTime(conversation.lastMessageAt ?? conversation.createdAt)} · {storageMode === 'LOCAL' ? '本地' : conversation.channel}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="mcp-history-delete"
                      aria-label={`删除会话 ${conversation.title}`}
                      title="删除会话"
                      disabled={chat.isPending}
                      onClick={() => void chat.deleteConversation(conversation.id)}
                    >
                      <Trash size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="agent-ws-sidebar-bottom">
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
                <div className="mcp-header-actions">
                  <AgentHeaderUsagePill
                    status={modelStatus}
                    loading={modelStatusQuery.isLoading}
                    activeModel={effectiveModel}
                    usesIndependentChannel={usesIndependentChannel}
                    onOpenDashboard={() => onChangeTab('usage')}
                  />
                  <span className="mcp-status"><Sparkle size={14} />{chat.readableStatus}</span>
                </div>
              </header>

              <AssistantConversationPane
                session={chat}
                guides={agentToolGuides}
                guidesAriaLabel="Agent 快捷指令"
                emptyTitle="自主销售 Agent 工作台"
                emptyIntro="在这里向 Agent 下达复杂销售目标。支持多轮连续追问、跨客户/互动/商机/报价/知识库多步推理，并自动生成高风险待审批邮件；产物会实时同步回业务工作台。"
                loadingHistoryTitle="正在加载 Agent 记忆上下文"
                attachmentAriaLabel="选择 Agent 附件"
                placeholder={chat.quotaUnavailable ? '默认通道 Token 额度不足，可切换上方 Agent 独立通道模型或联系管理员' : '自主 Agent 模式：输入跨模块目标或连续追问（按 Enter 发送，Shift + Enter 换行）'}
                modelSelector={(
                  <AgentModelPicker
                    status={modelStatus}
                    agentModels={agentModels}
                    defaultMcpModel={defaultMcpModel}
                    selectedModel={effectiveModel}
                    usesIndependentChannel={usesIndependentChannel}
                    disabled={chat.isPending}
                    onSelect={handleSelectModel}
                  />
                )}
                extraFooterMeta={<span><Robot size={15} />ReAct 多步自主规划</span>}
              />
            </div>
          ) : activeTab === 'runs' ? (
            <AgentRunsPanel onBackToChat={() => onChangeTab('chat')} />
          ) : activeTab === 'tools' ? (
            <AgentToolsPanel
              onUsePrompt={(prompt) => {
                onChangeTab('chat')
                chat.applyToolTemplate(prompt)
              }}
              onBackToChat={() => onChangeTab('chat')}
            />
          ) : (
            <AgentUsageDashboard
              status={modelStatus}
              loading={modelStatusQuery.isLoading}
              activeModel={effectiveModel}
              agentModels={agentModels}
              usesIndependentChannel={usesIndependentChannel}
              onSelectModel={(modelId) => {
                handleSelectModel(modelId)
                onChangeTab('chat')
              }}
              onBackToChat={() => onChangeTab('chat')}
            />
          )}
        </section>
      </div>
    </section>
  )
}

function AgentModelPicker({
  status,
  agentModels,
  defaultMcpModel,
  selectedModel,
  usesIndependentChannel,
  disabled,
  onSelect,
}: {
  status?: AiModelStatus
  agentModels: string[]
  defaultMcpModel: string
  selectedModel: string
  usesIndependentChannel: boolean
  disabled: boolean
  onSelect: (model: string) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const paneListRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const showDefaultFallback = !agentModels.includes(defaultMcpModel)
  const groupedAgentModels = useMemo(() => groupAgentModelsByTier(agentModels), [agentModels])
  const selectedMeta = getAgentModelMeta(selectedModel)

  type PickerCategoryKey = 'FAST' | 'STANDARD' | 'ADVANCED' | 'CUSTOM' | 'DEFAULT'
  const categories = useMemo(() => {
    const list: Array<{
      key: PickerCategoryKey
      label: string
      hint: string
      models: Array<{
        id: string
        afpCoeff: number | null
        recommended?: boolean
        retiring?: boolean
        isDefaultChannel?: boolean
        summary: string
      }>
    }> = groupedAgentModels.map((group) => ({
      key: group.tier,
      label: group.label,
      hint: group.hint,
      models: group.models,
    }))
    if (showDefaultFallback) {
      list.push({
        key: 'DEFAULT',
        label: '默认通道',
        hint: '消耗 MCP 额度',
        models: [{
          id: defaultMcpModel,
          afpCoeff: null,
          isDefaultChannel: true,
          summary: '使用组织默认主模型并计入 MCP 普通额度',
        }],
      })
    }
    return list
  }, [groupedAgentModels, showDefaultFallback, defaultMcpModel])

  const defaultCategoryKey: PickerCategoryKey = categories.find((cat) => (
    cat.models.some((item) => item.id === selectedModel)
  ))?.key ?? categories[0]?.key ?? 'DEFAULT'

  const [activeCategoryKey, setActiveCategoryKey] = useState<PickerCategoryKey | null>(null)
  const effectiveCategory = categories.find((cat) => cat.key === activeCategoryKey)
    ?? categories.find((cat) => cat.key === defaultCategoryKey)
    ?? categories[0]
  const effectiveCategoryKey = effectiveCategory?.key ?? null

  useEffect(() => {
    if (!open || !paneListRef.current) return
    paneListRef.current.scrollTop = 0
  }, [open, effectiveCategoryKey])

  return (
    <div ref={containerRef} className="agent-model-picker">
      <button
        type="button"
        className={`agent-model-trigger${usesIndependentChannel ? ' is-independent' : ''}`}
        aria-label="选择 Agent 模型"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setOpen((value) => {
            if (!value) setActiveCategoryKey(defaultCategoryKey)
            return !value
          })
        }}
      >
        <Sparkle size={14} />
        <b>{selectedModel}</b>
        {usesIndependentChannel && selectedMeta.afpCoeff != null ? (
          <em className="agent-model-coeff-pill">{formatAfpCoeff(selectedMeta.afpCoeff)}</em>
        ) : null}
        <CaretDown size={12} />
      </button>
      {open ? (
        <div
          className={`agent-model-menu agent-model-menu-split${categories.length <= 1 ? ' is-single-category' : ''}`}
          role="dialog"
          aria-label="可选 Agent 模型列表"
        >
          <div className="agent-model-menu-rail" role="tablist" aria-label="模型分类">
            {categories.map((category) => {
              const isActive = category.key === effectiveCategory?.key
              return (
                <button
                  key={category.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`agent-model-rail-item${isActive ? ' is-active' : ''}`}
                  onMouseEnter={() => setActiveCategoryKey(category.key)}
                  onClick={() => setActiveCategoryKey(category.key)}
                >
                  <strong>{category.label}</strong>
                  <small>{category.hint}</small>
                </button>
              )
            })}
            <div className="agent-model-rail-footer">
              <Link to="/app/settings#model" onClick={() => setOpen(false)}>
                {agentModels.length > 0 ? '管理可选模型 →' : '开启独立通道 →'}
              </Link>
            </div>
          </div>

          <div className="agent-model-menu-pane" role="listbox" aria-label={effectiveCategory?.label ?? '模型列表'}>
            {effectiveCategory ? (
              <div className="agent-model-pane-head">
                <strong>{effectiveCategory.label}</strong>
                <small>{effectiveCategory.hint}</small>
              </div>
            ) : null}
            <div ref={paneListRef} className="agent-model-pane-list">
              {(effectiveCategory?.models ?? []).map((item) => {
                const selected = item.id === selectedModel
                const isDefaultAgent = !item.isDefaultChannel && item.id === status?.agent?.model
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    title={item.summary}
                    className={`agent-model-option${selected ? ' is-selected' : ''}`}
                    onClick={() => {
                      onSelect(item.id)
                      setOpen(false)
                    }}
                  >
                    <span className="agent-model-option-name">{item.id}</span>
                    <span className="agent-model-option-tags">
                      {item.afpCoeff != null ? <em className="is-afp">{formatAfpCoeff(item.afpCoeff)}</em> : null}
                      {isDefaultAgent ? <em>默认</em> : item.recommended ? <em>推荐</em> : item.isDefaultChannel ? <em>默认模型</em> : null}
                      {item.retiring ? <em className="is-warn">即将下线</em> : null}
                      {selected ? <Check size={14} className="agent-model-option-check" /> : null}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

const AGENT_PROVIDER_DISPLAY: Record<string, string> = {
  QWEN: '通义千问（百炼）',
  VOLCENGINE_ARK: '火山引擎方舟 Agent Plan',
  OPENAI_COMPATIBLE: 'OpenAI 兼容通道',
}

function AgentHeaderUsagePill({
  status,
  loading,
  activeModel,
  usesIndependentChannel,
  onOpenDashboard,
}: {
  status?: AiModelStatus
  loading: boolean
  activeModel: string
  usesIndependentChannel: boolean
  onOpenDashboard: () => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const agentUsage = status?.usage?.agent
  const providerCode = usesIndependentChannel ? (status?.agent?.provider ?? 'VOLCENGINE_ARK') : (status?.provider ?? 'QWEN')
  const isArk = usesIndependentChannel && providerCode === 'VOLCENGINE_ARK'
  const fiveHourAfp = agentUsage?.last5HoursAfp ?? 0
  const fiveHourLimit = agentUsage?.fiveHourAfpLimit ?? AGENT_PLAN_SMALL_DEFAULTS.fiveHourAfp
  const weeklyAfp = agentUsage?.last7DaysAfp ?? 0
  const weeklyLimit = agentUsage?.weeklyAfpLimit ?? AGENT_PLAN_SMALL_DEFAULTS.weeklyAfp
  const monthlyAfp = agentUsage?.last30DaysAfp ?? 0
  const monthlyLimit = agentUsage?.monthlyAfpLimit ?? AGENT_PLAN_SMALL_DEFAULTS.monthlyAfp
  const activeMeta = getAgentModelMeta(activeModel)

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="agent-header-usage-wrap">
      <button
        type="button"
        className={`agent-header-model-badge${usesIndependentChannel ? ' is-independent' : ''}`}
        aria-label="查看自主 Agent 通道与用量"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Sparkle size={13} />
        <span>{activeModel}</span>
        <em>
          {loading
            ? '读取中'
            : isArk
              ? `${formatAfpValue(fiveHourAfp)} / ${formatCompactNumber(fiveHourLimit)} AFP`
              : usesIndependentChannel
                ? '独立通道'
                : '默认通道'}
        </em>
        <CaretDown size={12} />
      </button>

      {open ? (
        <section className="agent-usage-popover" aria-label="自主 Agent 用量统计">
          <header className="agent-usage-popover-head">
            <div>
              <strong>{AGENT_PROVIDER_DISPLAY[providerCode] ?? providerCode}</strong>
              <small>
                {activeModel}
                {activeMeta.afpCoeff != null ? ` · ${activeMeta.tierLabel} (${formatAfpCoeff(activeMeta.afpCoeff)})` : ''}
              </small>
            </div>
            <span className={`agent-channel-pill${usesIndependentChannel ? ' is-independent' : ''}`}>
              {usesIndependentChannel ? '独立通道已就绪' : '沿用默认模型'}
            </span>
          </header>

          {isArk ? (
            <div className="agent-afp-windows" aria-label="Agent 燃料值 AFP 估算">
              <AfpBarItem label="近 5 小时用量" used={fiveHourAfp} limit={fiveHourLimit} />
              <AfpBarItem label="近一周用量" used={weeklyAfp} limit={weeklyLimit} />
              <AfpBarItem label="近一月用量" used={monthlyAfp} limit={monthlyLimit} />
            </div>
          ) : null}

          <div className="agent-popover-metrics">
            <div>
              <small>Agent 累计 Token</small>
              <strong>{formatCompactNumber(agentUsage?.totalTokens ?? 0)}</strong>
            </div>
            <div>
              <small>自主调用次数</small>
              <strong>{formatCompactNumber(agentUsage?.successfulCalls ?? 0)}</strong>
            </div>
            <div>
              <small>累计估算 AFP</small>
              <strong>{formatAfpValue(agentUsage?.totalEstimatedAfp ?? 0)}</strong>
            </div>
          </div>

          <div className="agent-popover-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setOpen(false)
                onOpenDashboard()
              }}
            >
              <ChartBar size={14} />查看完整看板
            </button>
            <Link to="/app/settings#model" className="button button-primary" onClick={() => setOpen(false)}>
              <GearSix size={14} />配置通道
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  )
}

function AgentUsageDashboard({
  status,
  loading,
  activeModel,
  agentModels,
  usesIndependentChannel,
  onSelectModel,
  onBackToChat,
}: {
  status?: AiModelStatus
  loading: boolean
  activeModel: string
  agentModels: string[]
  usesIndependentChannel: boolean
  onSelectModel: (modelId: string) => void
  onBackToChat: () => void
}) {
  const queryClient = useQueryClient()
  const agentUsage = status?.usage?.agent
  const providerCode = usesIndependentChannel ? (status?.agent?.provider ?? 'VOLCENGINE_ARK') : (status?.provider ?? 'QWEN')
  const isArk = usesIndependentChannel && providerCode === 'VOLCENGINE_ARK'
  const fiveHourAfp = agentUsage?.last5HoursAfp ?? 0
  const fiveHourLimit = agentUsage?.fiveHourAfpLimit ?? AGENT_PLAN_SMALL_DEFAULTS.fiveHourAfp
  const weeklyAfp = agentUsage?.last7DaysAfp ?? 0
  const weeklyLimit = agentUsage?.weeklyAfpLimit ?? AGENT_PLAN_SMALL_DEFAULTS.weeklyAfp
  const monthlyAfp = agentUsage?.last30DaysAfp ?? 0
  const monthlyLimit = agentUsage?.monthlyAfpLimit ?? AGENT_PLAN_SMALL_DEFAULTS.monthlyAfp
  const groupedModels = useMemo(() => groupAgentModelsByTier(agentModels), [agentModels])
  const activeMeta = getAgentModelMeta(activeModel)

  const [calibrating, setCalibrating] = useState(false)
  const [cal5h, setCal5h] = useState('')
  const [cal7d, setCal7d] = useState('')
  const [cal30d, setCal30d] = useState('')
  const calibrationMutation = useMutation({
    mutationFn: calibrateAgentAfp,
    onSuccess: (updated) => {
      queryClient.setQueryData(['ai-model-status'], updated)
      setCalibrating(false)
    },
  })

  function openCalibration() {
    setCal5h(fiveHourAfp > 0 ? String(fiveHourAfp) : '')
    setCal7d(weeklyAfp > 0 ? String(weeklyAfp) : '')
    setCal30d(monthlyAfp > 0 ? String(monthlyAfp) : '')
    calibrationMutation.reset()
    setCalibrating(true)
  }

  function submitCalibration() {
    const parse = (raw: string) => {
      const trimmed = raw.trim()
      if (!trimmed) return null
      const num = Number(trimmed)
      return Number.isFinite(num) && num >= 0 ? num : null
    }
    calibrationMutation.mutate({
      fiveHourUsedAfp: parse(cal5h),
      weeklyUsedAfp: parse(cal7d),
      monthlyUsedAfp: parse(cal30d),
    })
  }

  return (
    <div className="agent-subview-container">
      <header className="agent-subview-header">
        <div>
          <h1>Agent 通道与燃料值（AFP）看板</h1>
          <p>独立追踪自主 Agent 通道消耗，与 MCP 助手免费额度与向量模型配额完全隔离。</p>
        </div>
        <div className="agent-subview-actions">
          <Link to="/app/settings#model" className="button button-secondary">
            <GearSix size={15} />管理模型通道
          </Link>
          <button type="button" className="button button-primary" onClick={onBackToChat}>
            回到自主对话
          </button>
        </div>
      </header>

      <div className="agent-usage-dashboard" aria-label="自主 Agent 用量看板">
        <div className="agent-usage-hero-grid">
          <section className="surface agent-usage-card">
            <div className="agent-usage-card-head">
              <div>
                <small>当前运行通道</small>
                <h2>{AGENT_PROVIDER_DISPLAY[providerCode] ?? providerCode}</h2>
              </div>
              <span className={`agent-channel-pill${usesIndependentChannel ? ' is-independent' : ''}`}>
                {usesIndependentChannel ? '独立通道已就绪' : '沿用默认模型'}
              </span>
            </div>
            <div className="agent-usage-current-pill">
              <Sparkle size={16} />
              <div>
                <strong>{activeModel}</strong>
                <span>
                  {activeMeta.afpCoeff != null
                    ? `${activeMeta.tierLabel} · 抵扣系数 ${formatAfpCoeff(activeMeta.afpCoeff)} AFP/万 token`
                    : '默认主模型通道'}
                </span>
              </div>
            </div>
            <div className="agent-usage-stat-row">
              <div>
                <small>Agent 累计 Token</small>
                <strong>{loading ? '—' : formatCompactNumber(agentUsage?.totalTokens ?? 0)}</strong>
                <span>入 {formatCompactNumber(agentUsage?.inputTokens ?? 0)} / 出 {formatCompactNumber(agentUsage?.outputTokens ?? 0)}</span>
              </div>
              <div>
                <small>自主调用次数</small>
                <strong>{loading ? '—' : formatCompactNumber(agentUsage?.successfulCalls ?? 0)}</strong>
                <span>{agentUsage?.lastCalledAt ? `最近 ${formatTime(agentUsage.lastCalledAt)}` : '暂无调用记录'}</span>
              </div>
              <div>
                <small>累计估算 AFP</small>
                <strong>{loading ? '—' : formatAfpValue(agentUsage?.totalEstimatedAfp ?? 0)}</strong>
                <span>按官方公式自动折算</span>
              </div>
            </div>
          </section>

          <section className="surface agent-usage-card" aria-label="Agent 燃料值 AFP 估算">
            <div className="agent-usage-card-head">
              <div>
                <small>{isArk ? 'Agent Plan Small 参考限额' : 'AFP 燃料值估算'}</small>
                <h2>Agent 燃料值（AFP）用量</h2>
              </div>
              <button
                type="button"
                className="compact-button"
                onClick={() => (calibrating ? setCalibrating(false) : openCalibration())}
              >
                {calibrating ? '取消校准' : '校准控制台 AFP'}
              </button>
            </div>
            {calibrating ? (
              <div className="agent-afp-calibration-box" aria-label="AFP 校准表单">
                <p>填入方舟控制台当前已用 AFP（如 95），用于同步历史/站外消耗；后续本系统新调用将自动累加，不会重复计算。</p>
                <div className="agent-afp-calibration-fields">
                  <label>
                    <span>近 5 小时已用</span>
                    <input
                      aria-label="近 5 小时已用 AFP"
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="例如 95"
                      value={cal5h}
                      onChange={(event) => setCal5h(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>近一周已用（可选）</span>
                    <input
                      aria-label="近一周已用 AFP"
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="留空同 5 小时"
                      value={cal7d}
                      onChange={(event) => setCal7d(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>近一月已用（可选）</span>
                    <input
                      aria-label="近一月已用 AFP"
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="留空同近一周"
                      value={cal30d}
                      onChange={(event) => setCal30d(event.target.value)}
                    />
                  </label>
                </div>
                <div className="agent-afp-calibration-actions">
                  {calibrationMutation.isError ? <span className="admin-form-error">{calibrationMutation.error.message}</span> : null}
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={calibrationMutation.isPending}
                    onClick={submitCalibration}
                  >
                    {calibrationMutation.isPending ? '保存中…' : '保存校准'}
                  </button>
                </div>
              </div>
            ) : null}
            <div className="agent-afp-board-bars">
              <AfpBarItem label="近 5 小时用量" used={fiveHourAfp} limit={fiveHourLimit} detailed />
              <AfpBarItem label="近一周用量" used={weeklyAfp} limit={weeklyLimit} detailed />
              <AfpBarItem label="近一月用量" used={monthlyAfp} limit={monthlyLimit} detailed />
            </div>
            <p className="agent-usage-io-note">
              {agentUsage?.calibratedAt
                ? `已按控制台基线校准（${formatTime(agentUsage.calibratedAt)}），后续调用自动累加。`
                : '按官方公式 (入×系数 + 出×系数)/1万 统计本系统调用；如含历史或站外消耗，可点右上角「校准控制台 AFP」同步。'}
            </p>
          </section>
        </div>

        <div className="agent-usage-lower-grid">
          <section className="surface agent-usage-card">
            <div className="agent-usage-card-head">
              <div>
                <small>本系统审计汇总</small>
                <h2>按 Agent 模型消耗明细</h2>
              </div>
            </div>
            {(agentUsage?.models?.length ?? 0) === 0 ? (
              <div className="approval-empty">
                <ChartBar size={22} />
                <strong>暂无 Agent 模型调用记录</strong>
                <span>发起一次自主 Agent 对话后，这里将自动按模型拆分展示 Token 与估算 AFP。</span>
              </div>
            ) : (
              <div className="settings-usage-table-wrap">
                <table className="settings-usage-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>调用</th>
                      <th>输入 / 输出</th>
                      <th>总 Token</th>
                      <th>估算 AFP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(agentUsage?.models ?? []).map((item) => (
                      <tr key={`${item.provider}:${item.model}`}>
                        <td><code>{item.model}</code></td>
                        <td>{item.successfulCalls.toLocaleString()}</td>
                        <td>{formatCompactNumber(item.inputTokens)} / {formatCompactNumber(item.outputTokens)}</td>
                        <td><strong>{item.totalTokens.toLocaleString()}</strong></td>
                        <td>{item.estimatedAfp != null ? `${formatAfpValue(item.estimatedAfp)} AFP` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="surface agent-usage-card">
            <div className="agent-usage-card-head">
              <div>
                <small>点击可一键切换当前对话模型</small>
                <h2>可用模型分级与抵扣系数</h2>
              </div>
            </div>
            {groupedModels.length === 0 ? (
              <div className="approval-empty">
                <Sparkle size={22} />
                <strong>尚未启用独立 Agent 通道</strong>
                <span>前往「设置 → AI 模型」开启火山引擎方舟 Agent Plan，即可解锁极速 / 标准 / 进阶三档模型一键切换。</span>
              </div>
            ) : (
              <div className="agent-tier-directory">
                {groupedModels.map((group) => (
                  <div key={group.tier} className="agent-tier-group">
                    <div className="agent-tier-group-head">
                      <strong>{group.label}</strong>
                      <span>{group.hint}</span>
                    </div>
                    <div className="agent-tier-chips">
                      {group.models.map((item) => {
                        const isSelected = item.id === activeModel
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className={`agent-tier-chip${isSelected ? ' is-selected' : ''}`}
                            title={item.summary}
                            onClick={() => onSelectModel(item.id)}
                          >
                            <span>{item.id}</span>
                            {item.afpCoeff != null ? <em>{formatAfpCoeff(item.afpCoeff)}</em> : null}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function AfpBarItem({ label, used, limit, detailed = false }: { label: string; used: number; limit: number; detailed?: boolean }) {
  const ratio = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
  return (
    <div className={`agent-afp-row${detailed ? ' is-detailed' : ''}`}>
      <div className="agent-afp-row-head">
        <span>{label}</span>
        <strong>
          {formatAfpValue(used)} / {formatCompactNumber(limit)} AFP
          {detailed ? <em>已用 {ratio.toFixed(1)}%</em> : null}
        </strong>
      </div>
      <div className="agent-afp-bar" aria-hidden>
        <span style={{ width: `${Math.min(100, ratio)}%` }} />
      </div>
    </div>
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

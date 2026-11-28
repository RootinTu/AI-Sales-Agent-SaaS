import { Clock, MagicWand, PlusSquare, Robot, Sparkle, SquaresFour, Trash } from '@phosphor-icons/react'
import { useState } from 'react'
import { useAuth } from '../auth/use-auth'
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

const toolGuides: AssistantToolGuide[] = [
  {
    tool: 'knowledge.query',
    label: '查询企业知识库',
    say: '查知识库：大客户申请折扣优惠有哪些要求和审批流程？',
    result: '结合语义向量与关键词检索企业知识库并返回引用',
  },
  {
    tool: 'customer.create',
    label: '新增客户',
    say: '新增客户：沐光医疗，行业：医疗科技，联系人：苏恬，电话：13800000007',
    result: '创建客户主档和主要联系人',
  },
  {
    tool: 'interaction.chat_import',
    label: '保存客户聊天',
    say: '给云岚科技导入聊天：客户说下周想看报价，需要私有化方案。',
    result: '将聊天记录归档至客户互动时间线（不触发自主 Agent）',
  },
  {
    tool: 'approval.list / approval.approve',
    label: '查询与处理审批',
    say: '查看待审批；批准 <审批ID>',
    result: '查询或批准业务待审批事项',
  },
  {
    tool: 'follow_up.list',
    label: '查看跟进任务',
    say: '查看跟进任务',
    result: '读取开放中的客户跟进任务',
  },
]

const welcomeMessage: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content: '我是 MCP 轻辅助助手，专注于日常问答、企业知识库查询以及标准业务工作流（新增客户、记录聊天、查看待审批与跟进任务、准备方案邮件）。如需多步自主分析或客户跟进 Agent，请从顶部栏切换至「自主 Agent」工作空间。',
  reasoningSummary: '等待用户输入问答或标准工作流指令。',
  createdAt: new Date().toISOString(),
}

const guestDemoMessages: ChatMessage[] = [
  { id: 'demo-user', role: 'user', content: '查知识库：报价折扣需要谁审批？', createdAt: new Date().toISOString() },
  {
    id: 'demo-assistant',
    role: 'assistant',
    content: '演示结果：发送正式报价前需销售经理审批；低于标准价格九折时，还需销售总监审批。',
    reasoningSummary: '根据模拟企业知识库返回审批流程说明。',
    traces: [{ name: 'knowledge.query', status: 'SUCCEEDED', summary: '演示：已找到并引用 1 段相关资料' }],
    createdAt: new Date().toISOString(),
  },
]

/**
 * 业务侧栏中的「MCP 助手」页面，专注于当前稳定高效的轻辅助（LIGHT）工作流，
 * 与顶部栏切入的独立「自主 Agent」工作空间完全隔离。
 */
export function McpAssistantPage() {
  const session = useAuth()
  const [tokenAllocationOpen, setTokenAllocationOpen] = useState(false)
  const chat = useAssistantChatSession({
    mode: 'LIGHT',
    welcomeMessage,
    guestDemoMessages,
    pendingProgressText: '正在连接助手…',
  })

  return (
    <section className="mcp-page">
      <div className="mcp-layout">
        <aside className="mcp-history-panel">
          <header>
            <h2>会话列表</h2>
            <button type="button" onClick={chat.startNewConversation} disabled={chat.isPending || chat.isGuest}>
              <PlusSquare size={16} />
              <span>新建</span>
            </button>
          </header>
          <p className="mcp-retention-note"><Clock size={12} />默认保留 7 天，到期自动清除（与自主 Agent 隔离）</p>
          {chat.isGuest ? (
            <p className="mcp-history-empty">当前展示模拟会话，登录后可使用自动化聊天和会话历史。</p>
          ) : chat.conversations.length === 0 ? (
            <div className="mcp-empty-history">
              <Robot size={52} />
              <p>{chat.conversationsQuery.isLoading ? '正在读取历史会话…' : '暂无可用会话'}</p>
            </div>
          ) : (
            <div className="mcp-history-list">
              {chat.conversations.map((conversation) => (
                <div key={conversation.id} className={`mcp-history-item-wrap${conversation.id === chat.activeConversationId ? ' is-active' : ''}`}>
                  <button
                    type="button"
                    className={conversation.id === chat.activeConversationId ? 'is-active' : ''}
                    disabled={chat.isPending}
                    onClick={() => chat.selectConversation(conversation.id)}
                  >
                    <strong>{conversation.title}</strong>
                    <span>{formatTime(conversation.lastMessageAt ?? conversation.createdAt)} · {conversation.channel}</span>
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
          <ModelInfoPanel
            status={chat.modelQuery.data}
            loading={chat.modelQuery.isLoading}
            canAllocate={session.role === 'OWNER' || session.role === 'ADMIN'}
            onAllocate={() => setTokenAllocationOpen(true)}
          />
        </aside>

        <section className="mcp-chat-panel">
          <header className="mcp-chat-header">
            <h1><SquaresFour size={18} />AI助手</h1>
            <div className="mcp-header-actions">
              <span className="mcp-mode-pill"><MagicWand size={13} />轻辅助模式</span>
              <span className="mcp-status"><Sparkle size={14} />{chat.readableStatus}</span>
            </div>
          </header>

          <AssistantConversationPane
            session={chat}
            guides={toolGuides}
            guidesAriaLabel="快捷操作"
            emptyTitle="MCP 业务助手"
            emptyIntro="聚焦日常问答、企业知识库检索与标准业务工作流（新增客户、保存聊天记录、审批与跟进查询）。如需多步自主规划或运行客户分析 Agent，请从顶部栏切换至「自主 Agent」。"
            loadingHistoryTitle="正在加载历史消息"
            attachmentAriaLabel="选择 MCP 聊天附件"
            placeholder={chat.isGuest ? '游客模式不能执行自动化操作' : chat.quotaUnavailable ? '尚未分配 Token 额度，请联系管理员' : '例如：查知识库或给云岚科技导入聊天。按 Enter 发送，Shift + Enter 换行'}
          />
        </section>
      </div>
      {tokenAllocationOpen ? <TokenAllocationDialog onClose={() => setTokenAllocationOpen(false)} /> : null}
    </section>
  )
}

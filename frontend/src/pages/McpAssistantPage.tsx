import { MagicWand, PlusSquare, Robot, Sparkle, SquaresFour } from '@phosphor-icons/react'
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
    tool: 'customer.create',
    label: '新增客户',
    say: '新增客户：沐光医疗，行业：医疗科技，联系人：苏恬，电话：13800000007',
    result: '创建客户主档和主要联系人',
  },
  {
    tool: 'interaction.chat_import + agent.sales_follow_up.run',
    label: '导入聊天并分析跟进',
    say: '给云岚科技导入聊天：客户说下周想看报价，需要私有化方案。',
    result: '保存聊天记录，并只针对该客户运行跟进建议 Agent',
  },
  {
    tool: 'approval.list / approval.approve',
    label: '查询与处理审批',
    say: '查看待审批；批准 <审批ID>',
    result: '查询或批准 Agent 生成的待审批建议',
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
  content: '我是 MCP 轻辅助助手。你可以直接说“新增客户”“给某客户导入聊天并跑 Agent”，我会自动调用客户、互动、Agent、审批和跟进工具。聊天记录会保存到数据库，刷新页面也能找回来。',
  reasoningSummary: '等待用户输入业务指令。',
  createdAt: new Date().toISOString(),
}

const guestDemoMessages: ChatMessage[] = [
  { id: 'demo-user', role: 'user', content: '查看云岚科技的下一步跟进建议', createdAt: new Date().toISOString() },
  {
    id: 'demo-assistant',
    role: 'assistant',
    content: '演示结果：建议与云岚科技确认方案范围，并预约下一次评审。',
    reasoningSummary: '根据模拟客户资料生成跟进建议。',
    traces: [{ name: 'agent.sales_follow_up.run', status: 'SUCCEEDED', summary: '演示：已生成跟进建议' }],
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
                <button
                  key={conversation.id}
                  type="button"
                  className={conversation.id === chat.activeConversationId ? 'is-active' : ''}
                  disabled={chat.isPending}
                  onClick={() => chat.selectConversation(conversation.id)}
                >
                  <strong>{conversation.title}</strong>
                  <span>{formatTime(conversation.lastMessageAt ?? conversation.createdAt)} · {conversation.channel}</span>
                </button>
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
            emptyTitle="销售自动化助手"
            emptyIntro="把客户资料、聊天记录、跟进建议和审批动作放在同一个工作流里，帮助销售团队更快整理线索、沉淀过程，并把需要人工确认的动作留在可追踪的记录中。"
            loadingHistoryTitle="正在加载历史消息"
            attachmentAriaLabel="选择 MCP 聊天附件"
            placeholder={chat.isGuest ? '游客模式不能执行自动化操作' : chat.quotaUnavailable ? '尚未分配 Token 额度，请联系管理员' : '例如：给云岚科技导入聊天。输入消息，按 Shift + Enter 换行，按 Enter 发送'}
          />
        </section>
      </div>
      {tokenAllocationOpen ? <TokenAllocationDialog onClose={() => setTokenAllocationOpen(false)} /> : null}
    </section>
  )
}

import {
  Check,
  CircleNotch,
  EnvelopeSimple,
  Paperclip,
  PaperPlaneTilt,
  Robot,
  ShieldCheck,
  Sparkle,
  UserCircle,
  WarningCircle,
  Wrench,
  X,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { type AiModelStatus } from '../../api/ai-settings-api'
import { type UploadedFile } from '../../api/files-api'
import { approveApproval, getApproval, rejectApproval, type Approval } from '../../api/approvals-api'
import { getMembers, getTeamTokenBudget, updateMemberTokenQuota, updateTeamTokenBudget, type AdminMember, type TeamTokenBudget } from '../../api/admin-api'
import { ApiError } from '../../api/axios-client'
import { useIsGuest } from '../../auth/use-auth'
import { MarkdownContent } from '../MarkdownContent'
import { AssistantActivity } from './AssistantActivity'
import {
  formatCompactNumber,
  formatFileSize,
  formatTime,
  shouldShowStreamError,
  type AssistantChatSession,
  type AssistantToolGuide,
  type ChatMessage,
} from './assistant-session'

/**
 * 通用的助手消息区与底部输入栏，内置滚动容器和输入框引用管理。
 * 由业务侧「MCP 助手」和顶栏切入的「自主 Agent 空间」共同复用。
 */
export function AssistantConversationPane({
  session,
  guides,
  guidesAriaLabel,
  emptyTitle,
  emptyIntro,
  loadingHistoryTitle,
  attachmentAriaLabel,
  placeholder,
  extraFooterMeta,
}: {
  session: AssistantChatSession
  guides: AssistantToolGuide[]
  guidesAriaLabel: string
  emptyTitle: string
  emptyIntro: string
  loadingHistoryTitle: string
  attachmentAriaLabel: string
  placeholder: string
  extraFooterMeta?: ReactNode
}) {
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const messageList = messageListRef.current
    if (!messageList || typeof messageList.scrollTo !== 'function') return
    messageList.scrollTo({
      top: messageList.scrollHeight,
      behavior: 'smooth',
    })
  }, [session.chatMessages, session.isPending])

  useEffect(() => {
    if (session.focusSignal === 0) return
    const timer = window.setTimeout(() => {
      const textarea = composerRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [session.focusSignal])

  return (
    <>
      <div ref={messageListRef} className="mcp-message-list" aria-live="polite">
        {session.messagesQuery.isFetching && session.activeConversationId ? (
          <article className="mcp-message is-assistant">
            <span className="mcp-avatar" aria-hidden><Robot size={20} /></span>
            <div className="mcp-bubble">
              <ThinkingSkeleton title={loadingHistoryTitle} />
            </div>
          </article>
        ) : null}
        {session.chatMessages.length === 0 && !session.messagesQuery.isFetching ? (
          <div className="mcp-empty-chat">
            <h2>{emptyTitle}</h2>
            <p className="mcp-empty-intro">{emptyIntro}</p>
          </div>
        ) : null}
        {session.chatMessages.map((message) => (
          <article key={message.id} className={`mcp-message is-${message.role}`}>
            <span className="mcp-avatar" aria-hidden>
              {message.role === 'user' ? <UserCircle size={20} /> : <Robot size={20} />}
            </span>
            <div className="mcp-bubble">
              {message.role === 'assistant' ? (
                <AssistantOutput message={message} />
              ) : (
                <>
                  <p>{message.content}</p>
                  <MessageAttachmentList attachments={message.attachments ?? []} />
                </>
              )}
            </div>
          </article>
        ))}
      </div>

      <form
        className="mcp-composer"
        onSubmit={(event) => {
          event.preventDefault()
          void session.submit()
        }}
      >
        <div className="mcp-tool-capsules" aria-label={guidesAriaLabel}>
          {guides.map((guide) => (
            <button
              key={guide.tool}
              type="button"
              disabled={session.disabled || session.isPending}
              aria-label={`套用${guide.label}模板`}
              title={guide.result}
              onClick={() => session.applyToolTemplate(guide.say)}
            >
              <Wrench size={13} />
              <span>{guide.label}</span>
            </button>
          ))}
        </div>
        {session.attachments.length ? (
          <div className="mcp-attachment-list" aria-label="已选择附件">
            {session.attachments.map((file) => (
              <span key={file.id} title={file.filename}>
                <Paperclip size={13} />
                <b>{file.filename}</b>
                <small>{formatFileSize(file.sizeBytes)}</small>
                <button
                  type="button"
                  aria-label={`移除附件 ${file.filename}`}
                  disabled={session.isPending || session.uploadingAttachments}
                  onClick={() => session.removeAttachment(file.id)}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {session.attachmentError ? <p className="mcp-attachment-error" role="alert">{session.attachmentError}</p> : null}
        <textarea
          ref={composerRef}
          value={session.input}
          disabled={session.disabled || session.uploadingAttachments}
          onChange={(event) => session.setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            void session.submit()
          }}
          placeholder={placeholder}
          rows={2}
        />
        <div className="mcp-composer-footer">
          <div className="mcp-composer-tools">
            <input
              ref={fileInputRef}
              className="mcp-file-input"
              type="file"
              multiple
              disabled={session.disabled}
              aria-label={attachmentAriaLabel}
              onChange={session.handleAttachmentChange}
            />
            <button
              type="button"
              aria-label="选择附件"
              title="选择报价、方案、合同等附件，发送消息时才会上传"
              disabled={session.disabled || session.isPending || session.uploadingAttachments || session.attachments.length >= 5}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={18} />
            </button>
            <span><Sparkle size={15} />{session.modelQuery.data?.model ?? 'qwen3.5-plus'}</span>
            {extraFooterMeta}
            {session.uploadingAttachments ? <span><CircleNotch size={15} className="mcp-spin" />正在上传附件</span> : null}
          </div>
          <button
            className="mcp-send-button"
            type="submit"
            aria-label="发送指令"
            disabled={session.disabled || session.isPending || session.uploadingAttachments || !session.input.trim()}
          >
            <PaperPlaneTilt size={21} weight="fill" />
          </button>
        </div>
      </form>
    </>
  )
}

export function ModelInfoPanel({ status, loading, canAllocate, onAllocate }: {
  status?: AiModelStatus
  loading: boolean
  canAllocate: boolean
  onAllocate: () => void
}) {
  const usage = status?.usage
  const totalTokens = usage?.totalTokens ?? 0
  const memberUsedTokens = usage?.memberUsedTokens ?? 0
  const memberAllocatedTokens = usage?.memberAllocatedTokens ?? null
  return (
    <section className="mcp-model-panel" aria-label="用量统计">
      <header>
        <strong>用量统计</strong>
        <span>{memberAllocatedTokens == null ? '未分配额度' : `剩 ${formatCompactNumber(usage?.memberRemainingTokens ?? 0)}`}</span>
      </header>
      {loading ? (
        <div className="mcp-model-loading"><span /><span /><span /></div>
      ) : (
        <>
          {memberAllocatedTokens == null || memberAllocatedTokens <= 0 ? (
            <div className="mcp-usage-total is-blocked"><span>当前不可用</span><strong>0</strong><small>可用 Token</small></div>
          ) : (
            <TokenProgress label="剩余额度" value={memberUsedTokens} total={memberAllocatedTokens} tone="blue" />
          )}
          <div className="mcp-usage-breakdown">
            <span><small>团队累计</small><strong>{formatCompactNumber(totalTokens)}</strong></span>
            <span><small>模型调用</small><strong>{formatCompactNumber(usage?.successfulCalls ?? 0)}</strong></span>
          </div>
          <div className="mcp-model-meta">
            <span>{status?.model ?? '-'}</span>
            <span>{modelStatusLabel(status?.status)}</span>
          </div>
          {canAllocate ? <button type="button" className="mcp-quota-button" onClick={onAllocate}>Token 分配</button> : null}
          {usage?.lastCalledAt ? <p className="mcp-model-time">最近调用：{formatTime(usage.lastCalledAt)}</p> : null}
        </>
      )}
    </section>
  )
}

export function TokenAllocationDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [totalInput, setTotalInput] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const budgetQuery = useQuery({ queryKey: ['team-token-budget'], queryFn: getTeamTokenBudget })
  const query = useQuery({
    queryKey: ['admin-members', 'token-allocation', page],
    queryFn: () => getMembers({ keyword: '', role: '', status: 'ACTIVE', page, size: 20 }),
  })
  const totalValue = totalInput ?? (budgetQuery.data?.totalTokens == null ? '' : String(budgetQuery.data.totalTokens))
  const totalInvalid = !/^\d+$/.test(totalValue) || Number(totalValue) > 1_000_000_000_000
    || !Number.isSafeInteger(Number(totalValue)) || Number(totalValue) < (budgetQuery.data?.allocatedTokens ?? 0)
  const budgetUnavailable = budgetQuery.isError && budgetQuery.error instanceof ApiError && budgetQuery.error.status === 404
  const budgetMutation = useMutation({
    mutationFn: () => updateTeamTokenBudget(Number(totalValue)),
    onSuccess: async (budget) => {
      queryClient.setQueryData(['team-token-budget'], budget)
      setTotalInput(null)
      await queryClient.invalidateQueries({ queryKey: ['ai-model-status'] })
    },
  })
  return (
    <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="admin-modal mcp-token-modal" role="dialog" aria-modal="true" aria-labelledby="token-allocation-title">
        <header><span className="drawer-title-icon"><Sparkle size={20} /></span><div><h2 id="token-allocation-title">Token 分配</h2><p>按团队内部总额分配；这不是千问账户余额。</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
        <div className="mcp-token-budget">
          <form onSubmit={(event) => { event.preventDefault(); if (!totalInvalid && budgetQuery.isSuccess) budgetMutation.mutate() }}>
            <label htmlFor="team-token-total">团队 Token 总额</label>
            <input id="team-token-total" inputMode="numeric" value={totalValue} onChange={(event) => setTotalInput(event.target.value)} placeholder="先设置总额" />
            <button className="button button-primary" type="submit" disabled={totalInvalid || budgetMutation.isPending || !budgetQuery.isSuccess}>保存总额</button>
          </form>
          {budgetQuery.data ? <div className="mcp-token-budget-stats" aria-label="团队 Token 预算">
            <span>总额 <strong>{budgetQuery.data.totalTokens == null ? '未设置' : formatCompactNumber(budgetQuery.data.totalTokens)}</strong></span>
            <span>已分配 <strong>{formatCompactNumber(budgetQuery.data.allocatedTokens)}</strong></span>
            <span>待分配 <strong>{budgetQuery.data.unallocatedTokens == null ? '—' : formatCompactNumber(budgetQuery.data.unallocatedTokens)}</strong></span>
          </div> : null}
          {budgetQuery.isError ? <p role="alert">{budgetUnavailable ? '当前后端版本尚未提供 Token 总额接口，请先部署包含此功能的后端和数据库迁移。' : budgetQuery.error.message}</p> : null}
          {budgetMutation.isError ? <p role="alert">{budgetMutation.error.message}</p> : null}
        </div>
        <div className="mcp-token-member-list">
          {query.data?.content.map((member) => <TokenAllocationRow key={member.id} member={member} budget={budgetQuery.data} />)}
          {query.isPending ? <p className="audit-state">正在读取成员用量…</p> : null}
          {query.isError ? <p className="audit-state is-error">{query.error.message}</p> : null}
        </div>
        <footer>
          <span className="mcp-token-pagination">{query.data ? `${query.data.totalElements} 位成员 · 第 ${page + 1} 页` : ''}</span>
          <button className="button button-secondary" type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>上一页</button>
          <button className="button button-secondary" type="button" disabled={!query.data || query.data.last} onClick={() => setPage((value) => value + 1)}>下一页</button>
          <button className="button button-secondary" type="button" onClick={onClose}>完成</button>
        </footer>
      </section>
    </div>
  )
}

function TokenAllocationRow({ member, budget }: { member: AdminMember; budget?: TeamTokenBudget }) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState(member.allocatedTokens == null ? '' : String(member.allocatedTokens))
  const mutation = useMutation({
    mutationFn: () => updateMemberTokenQuota(member.id, value.trim() === '' ? null : Number(value)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-members'] })
      await queryClient.invalidateQueries({ queryKey: ['team-token-budget'] })
      await queryClient.invalidateQueries({ queryKey: ['ai-model-status'] })
    },
  })
  const maxForMember = (budget?.unallocatedTokens ?? 0) + (member.allocatedTokens ?? 0)
  const invalid = value.trim() !== '' && (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value))
    || Number(value) > 1_000_000_000_000 || Number(value) > maxForMember)
  return (
    <div className="mcp-token-member-row">
      <span className="member-identity"><i>{member.displayName.slice(0, 1)}</i><span><strong>{member.displayName}</strong><small>已用 {formatCompactNumber(member.usedTokens)} Token</small></span></span>
      <label><span>分配额度 · 最多 {formatCompactNumber(maxForMember)}</span><input aria-label={`${member.displayName} Token 额度`} inputMode="numeric" placeholder="未分配" value={value} onChange={(event) => setValue(event.target.value)} /></label>
      <button className="button button-primary" type="button" disabled={!budget || budget.totalTokens == null || invalid || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? '保存中' : '保存'}</button>
      {mutation.isError ? <p role="alert">{mutation.error.message}</p> : null}
      {mutation.isSuccess ? <p className="is-success">已更新</p> : null}
    </div>
  )
}

function TokenProgress({ label, value, total, tone = 'blue' }: { label: string; value: number; total: number; tone?: 'blue' | 'green' | 'amber' }) {
  const percent = percentage(Math.max(0, total - value), total)
  return (
    <div className={`mcp-token-progress is-${tone}`}>
      <div><span>{label}</span><strong>{percent}%</strong></div>
      <progress value={percent} max={100} aria-label={`${label} ${percent}%`} />
      <span style={{ '--progress': `${percent}%` } as CSSProperties} aria-hidden />
      <small>已用 {formatCompactNumber(value)} / {formatCompactNumber(total)}</small>
    </div>
  )
}

function MessageAttachmentList({ attachments }: { attachments: UploadedFile[] }) {
  if (!attachments.length) return null
  return (
    <div className="mcp-message-attachments" aria-label="消息附件">
      {attachments.map((file) => (
        <span key={file.id} title={file.filename}>
          <Paperclip size={13} />
          <b>{file.filename}</b>
          <small>{formatFileSize(file.sizeBytes)}</small>
        </span>
      ))}
    </div>
  )
}

function AssistantOutput({ message }: { message: ChatMessage }) {
  const traces = message.traces ?? []
  const approvalIds = dataApprovalIds(message.data)
  const isAgentMode = message.data?.assistantMode === 'AGENT'
  const progressSteps = (message.progressSteps && message.progressSteps.length > 0)
    ? message.progressSteps
    : (message.progress ? [message.progress] : [])
  const thinkingTitle = message.thinkingLabel ?? (isAgentMode ? '自主 Agent 思考中' : '助手正在处理')
  const knowledgeSources = Array.isArray(message.data?.knowledgeSources)
    ? message.data.knowledgeSources.flatMap((source: unknown) => {
      if (!source || typeof source !== 'object') return []
      const item = source as Record<string, unknown>
      return typeof item.documentId === 'string' && typeof item.title === 'string'
        ? [{ documentId: item.documentId, title: item.title, pageNumber: typeof item.pageNumber === 'number' ? item.pageNumber : null }]
        : []
    }) : []
  const hasInlineCitations = knowledgeSources.length > 0 && /\[资料\s*\d+/.test(message.content)
  const uniqueFallbackSources = hasInlineCitations
    ? []
    : knowledgeSources.filter((source, index, list) => list.findIndex((item) => item.documentId === source.documentId) === index)
  return (
    <div className="mcp-assistant-output">
      {message.streaming ? (
        <div className={`mcp-thinking-chain${isAgentMode ? ' is-agent' : ''}`} aria-label={isAgentMode ? '自主 Agent 思考链' : '助手执行进度'}>
          <div className="mcp-pending-head">
            <CircleNotch size={16} className="mcp-spin" />
            <strong>{thinkingTitle}</strong>
            {isAgentMode ? <em className="mcp-output-mode-badge">自主 Agent</em> : null}
          </div>
          {progressSteps.length > 0 ? (
            <ol className="mcp-thinking-chain-list">
              {progressSteps.map((step, index) => {
                const isLatest = index === progressSteps.length - 1
                return (
                  <li key={`${index}-${step}`} className={isLatest ? 'is-active' : 'is-done'}>
                    <span className="mcp-chain-dot" aria-hidden />
                    <span>{step}</span>
                  </li>
                )
              })}
            </ol>
          ) : null}
        </div>
      ) : null}
      {message.content || !message.streaming ? (
        <section className="mcp-output-card">
          <header>
            <Sparkle size={14} />结果输出
            {isAgentMode ? <em className="mcp-output-mode-badge">自主 Agent</em> : null}
          </header>
          <div className="mcp-output-body">
            {message.content ? <MarkdownContent content={message.content} citations={knowledgeSources} /> : null}
            {message.streaming && message.content ? <span className="mcp-stream-cursor" aria-hidden>▍</span> : null}
          </div>
        </section>
      ) : null}
      {uniqueFallbackSources.length > 0 && (
        <div className="mcp-knowledge-sources" aria-label="知识库引用">
          {uniqueFallbackSources.map((source, index) => (
            <Link key={`${source.documentId}-${index}`} to={`/app/knowledge?document=${encodeURIComponent(source.documentId)}`}>
              {source.title}{source.pageNumber ? ` · 第 ${source.pageNumber} 页` : ''}
            </Link>
          ))}
        </div>
      )}
      {shouldShowStreamError(message) ? <p role="alert" className="mcp-stream-error"><WarningCircle size={15} />{message.error}</p> : null}

      <AssistantActivity summary={message.reasoningSummary} traces={traces} data={message.data} />

      {approvalIds.map((approvalId) => (
        <InlineApproval key={approvalId} approvalId={approvalId} />
      ))}
    </div>
  )
}

function ThinkingSkeleton({ title }: { title: string }) {
  return (
    <div className="mcp-thinking-skeleton" aria-label={title}>
      <strong>{title}<i /><i /><i /></strong>
      <span />
      <span />
      <span />
    </div>
  )
}

function InlineApproval({ approvalId }: { approvalId: string }) {
  const isGuest = useIsGuest()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['approval', approvalId],
    queryFn: () => getApproval(approvalId),
  })
  const approveMutation = useMutation({
    mutationFn: approveApproval,
    onSuccess: (approval) => finishDecision(approval),
  })
  const rejectMutation = useMutation({
    mutationFn: rejectApproval,
    onSuccess: (approval) => finishDecision(approval),
  })

  function finishDecision(approval: Approval) {
    queryClient.setQueryData(['approval', approvalId], approval)
    void queryClient.invalidateQueries({ queryKey: ['approvals'] })
    void queryClient.invalidateQueries({ queryKey: ['agent-runs'] })
    void queryClient.invalidateQueries({ queryKey: ['follow-ups'] })
    void queryClient.invalidateQueries({ queryKey: ['customers'] })
  }

  if (query.isPending) {
    return <section className="mcp-inline-approval is-loading"><CircleNotch size={16} className="mcp-spin" />正在读取审批状态</section>
  }
  if (query.isError || !query.data) {
    return <section className="mcp-inline-approval is-error"><WarningCircle size={16} />审批状态暂时无法读取，请稍后重试</section>
  }

  const approval = query.data
  const pending = approval.status === 'PENDING'
  const busy = approveMutation.isPending || rejectMutation.isPending
  const mutationError = approveMutation.error ?? rejectMutation.error
  const to = previewText(approval.preview.to)
  const subject = previewText(approval.preview.subject)
  const body = previewText(approval.preview.body)
  const attachments = previewAttachments(approval.preview.attachments)
  return (
    <section className={`mcp-inline-approval ${pending ? 'is-pending' : 'is-resolved'}`} aria-label="聊天内审批">
      <header>
        <span><ShieldCheck size={17} />{pending ? '高风险操作待确认' : approvalStatusLabel(approval.status)}</span>
        <em className={`risk-label ${approval.riskLevel === 'HIGH' ? 'risk-high' : approval.riskLevel === 'MEDIUM' ? 'risk-medium' : 'risk-low'}`}>{riskText(approval.riskLevel)}风险</em>
      </header>
      <strong>{actionLabel(approval.actionType)} · {approval.customerName}</strong>
      <p>{approval.reason}</p>
      {approval.actionType === 'SEND_EMAIL' ? (
        <dl>
          <div><dt><EnvelopeSimple size={14} />收件人</dt><dd>{to ?? '未解析'}</dd></div>
          <div><dt>主题</dt><dd>{subject ?? '(无主题)'}</dd></div>
          {body ? <div><dt>正文</dt><dd className="mcp-inline-email-body">{body}</dd></div> : null}
          <div><dt>附件</dt><dd>{attachments.length ? attachments.map((item) => item.name).join('、') : '无附件'}</dd></div>
        </dl>
      ) : null}
      {pending ? (
        <div className="mcp-inline-approval-actions">
          <button type="button" className="button button-secondary" disabled={isGuest || busy} onClick={() => rejectMutation.mutate(approval)}><X size={15} />拒绝</button>
          <button type="button" className="button button-primary" disabled={isGuest || busy} onClick={() => approveMutation.mutate(approval)}>
            {approveMutation.isPending ? <CircleNotch size={15} className="mcp-spin" /> : <Check size={15} />}
            {approval.actionType === 'SEND_EMAIL' ? '批准并发送' : '批准并执行'}
          </button>
        </div>
      ) : (
        <p className={`mcp-inline-approval-result is-${approvalResultTone(approval)}`}>{approvalResultText(approval)}</p>
      )}
      {mutationError ? <p className="mcp-inline-approval-error" role="alert">{mutationError.message}</p> : null}
    </section>
  )
}

function dataApprovalIds(data?: Record<string, unknown>) {
  if (!data) return []
  const ids: string[] = []
  if (typeof data.approvalId === 'string') ids.push(data.approvalId)
  if (Array.isArray(data.approvals)) {
    data.approvals.forEach((item) => {
      if (!item || typeof item !== 'object') return
      const id = (item as Record<string, unknown>).id
      if (typeof id === 'string') ids.push(id)
    })
  }
  return [...new Set(ids)]
}

function previewText(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

function previewAttachments(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const id = previewText(record.id)
    const name = previewText(record.name)
    return id && name ? [{ id, name }] : []
  })
}

function actionLabel(value: string) {
  if (value === 'SEND_EMAIL') return '发送邮件'
  if (value === 'CREATE_CRM_TASK') return '创建 CRM 任务'
  if (value === 'CREATE_INTERNAL_FOLLOW_UP') return '创建跟进任务'
  return value
}

function approvalStatusLabel(value: string) {
  if (value === 'APPROVED') return '审批已通过'
  if (value === 'REJECTED') return '审批已拒绝'
  if (value === 'EXPIRED') return '审批已过期'
  return '审批已处理'
}

function riskText(value: string) {
  if (value === 'HIGH') return '高'
  if (value === 'MEDIUM') return '中'
  return '低'
}

function approvalResultTone(approval: Approval) {
  if (approval.status === 'REJECTED' || approval.status === 'EXPIRED' || approval.actionStatus === 'FAILED') return 'error'
  if (approval.actionStatus === 'SUCCEEDED') return 'success'
  return 'pending'
}

function approvalResultText(approval: Approval) {
  if (approval.status === 'REJECTED') return '已拒绝，相关动作不会执行。'
  if (approval.status === 'EXPIRED') return '审批已过期，未执行相关动作。'
  if (approval.actionStatus === 'FAILED') return `审批已通过，但执行失败：${approval.failureMessage ?? '请检查配置后重新发起。'}`
  if (approval.actionStatus === 'SUCCEEDED') return approval.actionType === 'SEND_EMAIL' ? '审批已通过，邮件发送成功。' : '审批已通过，业务动作执行成功。'
  return '审批已通过，动作正在执行。'
}

function modelStatusLabel(status?: string) {
  if (status === 'READY') return '可用'
  if (status === 'MISSING_API_KEY') return '未配置 Key'
  if (status === 'ENCRYPTION_KEY_UNAVAILABLE') return '密钥不可解密'
  return status ?? '-'
}

function percentage(value: number, total: number) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)))
}

import { Key, MagnifyingGlass, Plus, ShieldCheck, SignOut, Sparkle, UserCircle, X } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useMemo, useState } from 'react'
import {
  createMember,
  getMembers,
  getTeamTokenBudget,
  resetMemberPassword,
  revokeMemberSessions,
  updateMember,
  updateMemberTokenQuota,
  type AdminMember,
  type CreateMemberInput,
  type MemberRole,
  type MemberStatus,
  type TeamTokenBudget,
  type UpdateMemberInput,
} from '../api/admin-api'
import { SelectField } from '../components/forms/SelectField'
import { useAuth } from '../auth/use-auth'
import { formatCompactNumber } from '../components/assistant/assistant-session'

const roleLabels: Record<MemberRole, string> = {
  OWNER: '团队所有者',
  ADMIN: '管理员',
  MANAGER: '销售主管',
  SALES: '销售成员',
  VIEWER: '只读成员',
}

const statusLabels: Record<MemberStatus, string> = {
  INVITED: '待加入',
  ACTIVE: '正常',
  SUSPENDED: '已停用',
  LEFT: '已离开',
}

const filterRoles = [
  { value: '', label: '全部角色' },
  ...Object.entries(roleLabels).map(([value, label]) => ({ value, label })),
]

const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'ACTIVE', label: '正常' },
  { value: 'SUSPENDED', label: '已停用' },
  { value: 'LEFT', label: '已离开' },
]

export function AdminMembersPage() {
  const session = useAuth()
  const [keyword, setKeyword] = useState('')
  const [role, setRole] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(0)
  const [editor, setEditor] = useState<AdminMember | 'create' | null>(null)
  const query = useQuery({
    queryKey: ['admin-members', keyword, role, status, page],
    queryFn: () => getMembers({ keyword: keyword.trim(), role, status, page, size: 20 }),
    placeholderData: (previous) => previous,
  })
  const budgetQuery = useQuery({
    queryKey: ['team-token-budget'],
    queryFn: getTeamTokenBudget,
  })

  function updateFilter(action: () => void) {
    action()
    setPage(0)
  }

  const budget = budgetQuery.data

  return (
    <section className="module-page admin-page">
      <header className="page-heading module-heading">
        <div><p className="eyebrow">管理员控制台</p><h1>成员管理</h1><p>添加团队成员、分配角色与 AI Token 额度，并执行重置密码或强制下线等安全运维操作。</p></div>
        <div className="page-actions"><button className="button button-primary" type="button" onClick={() => setEditor('create')}><Plus size={16} />添加成员</button></div>
      </header>

      <section className="surface admin-summary-strip">
        <div><span>成员总数</span><strong>{query.data?.totalElements ?? '—'}</strong></div>
        <div><span>当前筛选</span><strong>{query.data?.content.length ?? '—'}</strong></div>
        <div>
          <span>团队 Token 预算</span>
          <strong>
            {budget?.totalTokens == null
              ? '未设置'
              : `${formatCompactNumber(budget.allocatedTokens)} / ${formatCompactNumber(budget.totalTokens)}`}
          </strong>
        </div>
        <div><span>你的权限</span><strong>{roleLabels[session.role as MemberRole] ?? session.role}</strong></div>
      </section>

      <section className="surface admin-panel">
        <div className="admin-filters">
          <label className="audit-search"><MagnifyingGlass size={16} /><input aria-label="搜索成员" type="search" placeholder="搜索姓名或邮箱" value={keyword} onChange={(event) => updateFilter(() => setKeyword(event.target.value))} /></label>
          <SelectField value={role} onChange={(value) => updateFilter(() => setRole(value))} ariaLabel="筛选角色" options={filterRoles} />
          <SelectField value={status} onChange={(value) => updateFilter(() => setStatus(value))} ariaLabel="筛选状态" options={statusOptions} />
        </div>

        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>成员</th><th>角色</th><th>状态</th><th>AI Token 额度</th><th>最近登录</th><th>加入时间</th><th /></tr></thead>
            <tbody>
              {query.data?.content.map((member) => {
                const canManageAccount = canManageMemberAccount(session.role as MemberRole, session.memberId, member)
                const canOpenEditor = canManageAccount || member.status === 'ACTIVE'
                return (
                  <tr key={member.id}>
                    <td><span className="member-identity"><i>{member.displayName.slice(0, 1)}</i><span><strong>{member.displayName}</strong><small>{member.email}</small></span></span></td>
                    <td><span className={`role-chip role-${member.role.toLowerCase()}`}>{member.role === 'OWNER' || member.role === 'ADMIN' ? <ShieldCheck size={13} /> : null}{roleLabels[member.role]}</span></td>
                    <td><span className={`member-status status-${member.status.toLowerCase()}`}><i />{statusLabels[member.status]}</span></td>
                    <td>
                      <div className="admin-token-cell">
                        <strong>{member.allocatedTokens == null ? '未分配' : formatCompactNumber(member.allocatedTokens)}</strong>
                        <small>已用 {formatCompactNumber(member.usedTokens)}{member.remainingTokens != null ? ` · 剩 ${formatCompactNumber(member.remainingTokens)}` : ''}</small>
                      </div>
                    </td>
                    <td>{formatDate(member.lastLoginAt)}</td>
                    <td>{formatDate(member.joinedAt ?? member.createdAt)}</td>
                    <td><button className="table-action" type="button" disabled={!canOpenEditor} onClick={() => setEditor(member)}>管理</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {query.isPending ? <div className="audit-state">正在读取成员…</div> : null}
          {query.isError ? <div className="audit-state is-error">{query.error.message}</div> : null}
          {query.data?.content.length === 0 ? <div className="audit-state">没有符合条件的成员。</div> : null}
        </div>

        <div className="table-pagination">
          <div><strong>{query.data?.totalElements ?? 0}</strong><span>位成员</span></div>
          <div><button type="button" disabled={!query.data || query.data.first} onClick={() => setPage((value) => Math.max(0, value - 1))}>上一页</button><span>第 {(query.data?.page ?? page) + 1} 页 / 共 {Math.max(query.data?.totalPages ?? 1, 1)} 页</span><button type="button" disabled={!query.data || query.data.last} onClick={() => setPage((value) => value + 1)}>下一页</button></div>
        </div>
      </section>

      {editor ? (
        <MemberEditor
          member={editor === 'create' ? null : editor}
          actorRole={session.role as MemberRole}
          actorMemberId={session.memberId}
          budget={budget}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </section>
  )
}

function canManageMemberAccount(actorRole: MemberRole, actorMemberId: string, target: AdminMember) {
  if (target.role === 'OWNER') return false
  if (target.id === actorMemberId) return false
  if (actorRole === 'ADMIN' && target.role === 'ADMIN') return false
  return true
}

function MemberEditor({
  member,
  actorRole,
  actorMemberId,
  budget,
  onClose,
}: {
  member: AdminMember | null
  actorRole: MemberRole
  actorMemberId: string
  budget?: TeamTokenBudget
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(member?.displayName ?? '')
  const [email, setEmail] = useState(member?.email ?? '')
  const [role, setRole] = useState<MemberRole>(member?.role ?? 'SALES')
  const [status, setStatus] = useState<MemberStatus>(member?.status ?? 'ACTIVE')
  const [initialPassword, setInitialPassword] = useState('')
  const [quotaInput, setQuotaInput] = useState(member?.allocatedTokens == null ? '' : String(member.allocatedTokens))
  const [newPassword, setNewPassword] = useState('')
  const [securityMessage, setSecurityMessage] = useState('')

  const canManageAccount = member ? canManageMemberAccount(actorRole, actorMemberId, member) : true
  const maxForMember = (budget?.unallocatedTokens ?? 0) + (member?.allocatedTokens ?? 0)
  const quotaInvalid = quotaInput.trim() !== '' && (
    !/^\d+$/.test(quotaInput.trim())
    || !Number.isSafeInteger(Number(quotaInput))
    || Number(quotaInput) > 1_000_000_000_000
    || Number(quotaInput) > maxForMember
  )

  const roleOptions = useMemo(() => [
    ...(actorRole === 'OWNER' ? [{ value: 'ADMIN', label: '管理员' }] : []),
    { value: 'MANAGER', label: '销售主管' },
    { value: 'SALES', label: '销售成员' },
    { value: 'VIEWER', label: '只读成员' },
  ], [actorRole])

  const mutation = useMutation({
    mutationFn: () => member
      ? updateMember(member.id, { displayName: displayName.trim(), role, status } satisfies UpdateMemberInput)
      : createMember({ displayName: displayName.trim(), email: email.trim(), role, initialPassword } satisfies CreateMemberInput),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-members'] })
      await queryClient.invalidateQueries({ queryKey: ['admin-team'] })
      onClose()
    },
  })

  const quotaMutation = useMutation({
    mutationFn: () => updateMemberTokenQuota(member!.id, quotaInput.trim() === '' ? null : Number(quotaInput)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-members'] })
      await queryClient.invalidateQueries({ queryKey: ['team-token-budget'] })
      await queryClient.invalidateQueries({ queryKey: ['ai-model-status'] })
    },
  })

  const resetPasswordMutation = useMutation({
    mutationFn: () => resetMemberPassword(member!.id, newPassword),
    onSuccess: () => {
      setNewPassword('')
      setSecurityMessage('已重置登录密码，该成员所有旧会话已失效。')
    },
  })

  const revokeMutation = useMutation({
    mutationFn: () => revokeMemberSessions(member!.id),
    onSuccess: (res) => {
      setSecurityMessage(`已强制下线，共吊销 ${res.revokedSessions} 个有效会话。`)
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canManageAccount) return
    mutation.mutate()
  }

  return (
    <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="member-editor-title">
        <header><span className="drawer-title-icon"><UserCircle size={20} /></span><div><h2 id="member-editor-title">{member ? `管理成员 · ${member.displayName}` : '添加成员'}</h2><p>{member ? '修改成员职责、配置 AI Token 额度或执行账号安全操作。' : '创建可直接登录的团队账号。'}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>

        <form onSubmit={submit}>
          <label><span>姓名</span><input required maxLength={120} disabled={!canManageAccount} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label><span>邮箱</span><input required type="email" maxLength={320} disabled={Boolean(member)} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          {canManageAccount ? (
            <>
              <div className="admin-form-field"><span>角色</span><SelectField value={role} onChange={(value) => setRole(value as MemberRole)} ariaLabel="成员角色" options={roleOptions} /></div>
              {member ? <div className="admin-form-field"><span>账号状态</span><SelectField value={status} onChange={(value) => setStatus(value as MemberStatus)} ariaLabel="账号状态" options={statusOptions.filter((option) => option.value)} /></div> : (
                <label><span>初始密码</span><input required type="password" minLength={10} maxLength={72} autoComplete="new-password" value={initialPassword} onChange={(event) => setInitialPassword(event.target.value)} placeholder="至少 10 位，包含大小写字母和数字" /><small>密码仅用于首次登录，服务端只保存 BCrypt 摘要。</small></label>
              )}
            </>
          ) : (
            <p className="admin-form-hint">当前账号角色（所有者/本人/同级管理员）不支持修改基础角色与状态，但可调整 AI Token 额度。</p>
          )}
          {mutation.isError ? <p className="admin-form-error">{mutation.error.message}</p> : null}
          {canManageAccount ? (
            <footer><button className="button button-secondary" type="button" onClick={onClose}>取消</button><button className="button button-primary" type="submit" disabled={mutation.isPending}>{mutation.isPending ? '保存中…' : member ? '保存修改' : '创建成员'}</button></footer>
          ) : null}
        </form>

        {member ? (
          <div className="admin-editor-sections">
            <section className="admin-security-box" aria-label="成员 AI Token 额度">
              <div className="admin-security-head">
                <strong><Sparkle size={15} />AI Token 额度</strong>
                <small>{budget?.totalTokens == null ? '请先在团队管理设置总额' : `可分配上限 ${formatCompactNumber(maxForMember)}`}</small>
              </div>
              <div className="admin-inline-form">
                <input
                  aria-label="成员 Token 额度"
                  inputMode="numeric"
                  placeholder="留空表示未分配"
                  value={quotaInput}
                  onChange={(event) => setQuotaInput(event.target.value)}
                />
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!budget || budget.totalTokens == null || quotaInvalid || quotaMutation.isPending}
                  onClick={() => quotaMutation.mutate()}
                >
                  {quotaMutation.isPending ? '保存中…' : '保存额度'}
                </button>
              </div>
              {quotaMutation.isError ? <p className="admin-form-error">{quotaMutation.error.message}</p> : null}
              {quotaMutation.isSuccess ? <p className="admin-form-success">成员 Token 额度已更新。</p> : null}
            </section>

            {canManageAccount ? (
              <section className="admin-security-box" aria-label="账号安全操作">
                <div className="admin-security-head">
                  <strong><Key size={15} />账号安全与会话</strong>
                  <small>重置密码或强制下线会立即吊销有效登录态</small>
                </div>
                <div className="admin-inline-form">
                  <input
                    aria-label="重置新密码"
                    type="password"
                    minLength={10}
                    maxLength={72}
                    autoComplete="new-password"
                    placeholder="新密码（10位以上含大小写字母与数字）"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={resetPasswordMutation.isPending || newPassword.length < 10}
                    onClick={() => {
                      setSecurityMessage('')
                      resetPasswordMutation.mutate()
                    }}
                  >
                    {resetPasswordMutation.isPending ? '重置中…' : '重置密码'}
                  </button>
                </div>
                <div className="admin-security-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={revokeMutation.isPending}
                    onClick={() => {
                      setSecurityMessage('')
                      revokeMutation.mutate()
                    }}
                  >
                    <SignOut size={15} />
                    {revokeMutation.isPending ? '处理中…' : '强制下线'}
                  </button>
                </div>
                {resetPasswordMutation.isError ? <p className="admin-form-error">{resetPasswordMutation.error.message}</p> : null}
                {revokeMutation.isError ? <p className="admin-form-error">{revokeMutation.error.message}</p> : null}
                {securityMessage ? <p className="admin-form-success" role="status">{securityMessage}</p> : null}
              </section>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  )
}

function formatDate(value: string | null) {
  if (!value) return '从未登录'
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

import { ArrowRight, Buildings, CheckCircle, ClockCounterClockwise, GearSix, ShieldCheck, Sparkle, UsersThree } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'
import { getTeam, getTeamTokenBudget, updateTeam, updateTeamTokenBudget, type AdminTeam, type TeamTokenBudget } from '../api/admin-api'
import { getAiModelStatus } from '../api/ai-settings-api'
import { formatCompactNumber } from '../components/assistant/assistant-session'
import { SelectField } from '../components/forms/SelectField'

const timezoneOptions = [
  { value: 'Asia/Shanghai', label: '中国标准时间（上海）' },
  { value: 'Asia/Singapore', label: '新加坡时间' },
  { value: 'Asia/Tokyo', label: '日本标准时间（东京）' },
  { value: 'Europe/London', label: '英国时间（伦敦）' },
  { value: 'America/New_York', label: '美国东部时间（纽约）' },
  { value: 'UTC', label: '协调世界时（UTC）' },
]

const localeOptions = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English (US)' },
]

export function AdminTeamPage() {
  const query = useQuery({ queryKey: ['admin-team'], queryFn: getTeam })
  const budgetQuery = useQuery({ queryKey: ['team-token-budget'], queryFn: getTeamTokenBudget })
  const modelQuery = useQuery({ queryKey: ['ai-model-status'], queryFn: getAiModelStatus })

  return (
    <section className="module-page admin-page">
      <header className="page-heading module-heading">
        <div><p className="eyebrow">管理员控制台</p><h1>团队管理</h1><p>维护工作区资料、团队 AI Token 总预算、套餐边界与系统运维状态。</p></div>
      </header>

      <section className="admin-metric-grid">
        <Metric icon={UsersThree} label="团队成员" value={query.data?.totalMembers} note="不包含已离开成员" />
        <Metric icon={CheckCircle} label="活跃账号" value={query.data?.activeMembers} note="当前可以登录系统" />
        <Metric icon={ShieldCheck} label="管理员" value={query.data?.adminMembers} note="所有者与管理员" />
        <Metric
          icon={Sparkle}
          label="AI Token 总额"
          value={budgetQuery.data?.totalTokens == null ? '未设置' : formatCompactNumber(budgetQuery.data.totalTokens)}
          note={budgetQuery.data?.unallocatedTokens == null ? '待配置团队总预算' : `剩余待分配 ${formatCompactNumber(budgetQuery.data.unallocatedTokens)}`}
        />
      </section>

      <div className="admin-team-layout">
        <div className="admin-team-primary">
          <section className="surface admin-team-card">
            <div className="panel-header"><div><h2>团队资料</h2><p>这些信息用于工作区展示和业务时间计算。</p></div><span className="drawer-title-icon"><Buildings size={19} /></span></div>
            {query.isPending ? <div className="audit-state">正在读取团队配置…</div> : null}
            {query.isError ? <div className="audit-state is-error">{query.error.message}</div> : null}
            {query.data ? <TeamSettingsForm key={query.data.updatedAt} team={query.data} /> : null}
          </section>

          <section className="surface admin-budget-card">
            <div className="panel-header">
              <div><h2>团队 AI Token 预算总控</h2><p>先设置团队总预算，再在成员管理页按角色与业务量分配个人额度。</p></div>
              <span className="drawer-title-icon"><Sparkle size={19} /></span>
            </div>
            {budgetQuery.isPending ? <div className="audit-state">正在读取 Token 预算…</div> : null}
            {budgetQuery.isError ? <div className="audit-state is-error">{budgetQuery.error.message}</div> : null}
            {budgetQuery.data ? <TeamBudgetForm budget={budgetQuery.data} /> : null}
          </section>
        </div>

        <aside className="admin-team-rail">
          <section className="surface admin-policy-card">
            <h2>权限边界与套餐</h2>
            <div><ShieldCheck size={18} /><span><strong>团队所有者</strong><small>可以任命管理员、管理所有成员与团队配置。</small></span></div>
            <div><ShieldCheck size={18} /><span><strong>管理员</strong><small>可以管理普通成员，但不能修改所有者或其他管理员。</small></span></div>
            <div><UsersThree size={18} /><span><strong>业务角色</strong><small>主管、销售和只读成员不会看到管理员入口。</small></span></div>
            <div><ShieldCheck size={18} /><span><strong>自主 Agent 模式权限</strong><small>{query.data?.planCode === 'SVIP' ? '当前为企业 SVIP 团队，Web 端与桌面客户端均可切换至自主 Agent 独立空间。' : '轻辅助模式全员可用；多步推理与上下文记忆的自主 Agent 独立空间仅向桌面客户端与企业 SVIP 团队开放。'}</small></span></div>
          </section>

          <section className="surface admin-policy-card">
            <h2>治理状态与快捷入口</h2>
            <div>
              <Sparkle size={18} />
              <span>
                <strong>AI 模型通道 · {modelQuery.data?.ready ? '已就绪' : '待检查'}</strong>
                <small>{modelQuery.data ? `${modelQuery.data.model}（${modelQuery.data.status}）` : '正在检查模型配置…'}</small>
              </span>
            </div>
            <nav className="admin-quick-links" aria-label="管理员快捷入口">
              <Link to="/app/admin/members"><UsersThree size={15} /><span>成员管理与额度分配</span><ArrowRight size={14} /></Link>
              <Link to="/app/audit-logs"><ClockCounterClockwise size={15} /><span>操作审计日志与导出</span><ArrowRight size={14} /></Link>
              <Link to="/app/settings"><GearSix size={15} /><span>模型与企业收发信配置</span><ArrowRight size={14} /></Link>
            </nav>
          </section>
        </aside>
      </div>
    </section>
  )
}

function TeamSettingsForm({ team }: { team: AdminTeam }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(team.name)
  const [timezone, setTimezone] = useState(team.timezone)
  const [locale, setLocale] = useState(team.locale)
  const mutation = useMutation({
    mutationFn: () => updateTeam({ name: name.trim(), timezone, locale }),
    onSuccess: (updatedTeam) => queryClient.setQueryData(['admin-team'], updatedTeam),
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    mutation.mutate()
  }

  return (
    <form className="admin-team-form" onSubmit={submit}>
      <label><span>团队名称</span><input required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label><span>工作区标识</span><input value={team.slug} disabled /><small>标识创建后不可修改，用于稳定识别租户。</small></label>
      <div className="admin-form-field"><span>业务时区</span><SelectField value={timezone} onChange={setTimezone} ariaLabel="业务时区" options={timezoneOptions} /><small>影响日报边界、跟进时间和数据统计，不依赖服务器所在国家。</small></div>
      <div className="admin-form-field"><span>默认语言</span><SelectField value={locale} onChange={setLocale} ariaLabel="默认语言" options={localeOptions} /></div>
      {mutation.isError ? <p className="admin-form-error">{mutation.error.message}</p> : null}
      <div className="settings-form-actions"><span className="model-test-result">{mutation.isSuccess ? '团队配置已保存。重新登录后侧栏名称会同步更新。' : `当前套餐：${team.planCode}`}</span><button className="button button-primary" type="submit" disabled={mutation.isPending || !name.trim()}>{mutation.isPending ? '保存中…' : '保存团队设置'}</button></div>
    </form>
  )
}

function TeamBudgetForm({ budget }: { budget: TeamTokenBudget }) {
  const queryClient = useQueryClient()
  const [totalInput, setTotalInput] = useState<string | null>(null)
  const value = totalInput ?? (budget.totalTokens == null ? '' : String(budget.totalTokens))
  const invalid = !/^\d+$/.test(value) || Number(value) > 1_000_000_000_000
    || !Number.isSafeInteger(Number(value)) || Number(value) < budget.allocatedTokens

  const mutation = useMutation({
    mutationFn: () => updateTeamTokenBudget(Number(value)),
    onSuccess: async (updated) => {
      queryClient.setQueryData(['team-token-budget'], updated)
      setTotalInput(null)
      await queryClient.invalidateQueries({ queryKey: ['ai-model-status'] })
    },
  })

  const percent = budget.totalTokens && budget.totalTokens > 0
    ? Math.min(100, Math.round((budget.allocatedTokens / budget.totalTokens) * 100))
    : 0

  return (
    <div className="admin-budget-body">
      <div className="mcp-token-budget-stats" aria-label="团队 Token 预算统计">
        <span>总额 <strong>{budget.totalTokens == null ? '未设置' : formatCompactNumber(budget.totalTokens)}</strong></span>
        <span>已分配 <strong>{formatCompactNumber(budget.allocatedTokens)}</strong></span>
        <span>待分配 <strong>{budget.unallocatedTokens == null ? '—' : formatCompactNumber(budget.unallocatedTokens)}</strong></span>
      </div>
      <progress className="admin-budget-progress" max={100} value={percent} aria-label={`已分配比例 ${percent}%`} />
      <form
        className="admin-inline-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!invalid) mutation.mutate()
        }}
      >
        <input
          aria-label="团队 Token 总额"
          inputMode="numeric"
          placeholder="输入团队 Token 总额，例如 500000"
          value={value}
          onChange={(event) => setTotalInput(event.target.value)}
        />
        <button className="button button-primary" type="submit" disabled={invalid || mutation.isPending}>
          {mutation.isPending ? '保存中…' : '保存总额'}
        </button>
      </form>
      {mutation.isError ? <p className="admin-form-error">{mutation.error.message}</p> : null}
      {mutation.isSuccess ? <p className="admin-form-success">团队 Token 总额已更新。</p> : null}
    </div>
  )
}

function Metric({ icon: Icon, label, value, note }: { icon: typeof UsersThree; label: string; value?: number | string; note: string }) {
  return <section className="surface admin-metric"><span><Icon size={19} /></span><div><small>{label}</small><strong>{value ?? '—'}</strong><p>{note}</p></div></section>
}

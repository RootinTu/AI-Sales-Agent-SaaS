import { CheckCircle, Database, EnvelopeSimple, WarningCircle } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { getAiModelStatus, saveAiModelConfiguration, testAgentModelConnection, testAiModelConnection, type AiModelProvider, type AiModelStatus } from '../api/ai-settings-api'
import { getEmailSettingsStatus, saveEmailSettings, testEmailSettingsConnection, type EmailSettingsStatus } from '../api/email-settings-api'
import { getSystemHealth } from '../api/system-api'
import { SelectField } from '../components/forms/SelectField'
import { useIsGuest } from '../auth/use-auth'
import { MailAccountSettings } from '../components/mail/MailAccountSettings'

interface AiModelSettingsFormProps {
  status?: AiModelStatus
  isGuest: boolean
}

const MODEL_PROVIDER_OPTIONS: Array<{ value: AiModelProvider; label: string }> = [
  { value: 'QWEN', label: '通义千问（百炼）' },
  { value: 'VOLCENGINE_ARK', label: '火山引擎（方舟 Agent Plan）' },
  { value: 'OPENAI_COMPATIBLE', label: '其他 OpenAI 兼容接口' },
]

const PROVIDER_DEFAULT_BASE_URLS: Record<AiModelProvider, string> = {
  QWEN: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  VOLCENGINE_ARK: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  OPENAI_COMPATIBLE: 'https://api.openai.com/v1',
}

const PROVIDER_LABELS: Record<string, string> = {
  QWEN: '通义千问（百炼）',
  VOLCENGINE_ARK: '火山引擎（方舟 Agent Plan）',
  OPENAI_COMPATIBLE: 'OpenAI 兼容',
}

const VOLCENGINE_AGENT_PRESET_MODELS = [
  'doubao-seed-2.1-pro',
  'doubao-seed-evolving',
  'deepseek-v4-pro',
  'glm-5.3',
  'kimi-k3',
]

function formatModelList(models?: string[]) {
  return models && models.length > 0 ? models.join(', ') : ''
}

function parseModelList(raw: string) {
  return Array.from(
    new Set(
      raw
        .split(/[,;\n\r]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  )
}

function AiModelSettingsForm({ status, isGuest }: AiModelSettingsFormProps) {
  const queryClient = useQueryClient()
  const [provider, setProvider] = useState<AiModelProvider>(status?.provider ?? 'QWEN')
  const [model, setModel] = useState(status?.model ?? 'qwen-plus')
  const [embeddingModel, setEmbeddingModel] = useState(status?.embeddingModel ?? 'qwen3.7-text-embedding-flash')
  const [baseUrl, setBaseUrl] = useState(status?.baseUrl ?? PROVIDER_DEFAULT_BASE_URLS.QWEN)
  const [apiKey, setApiKey] = useState('')

  const initialAgentEnabled = Boolean(status?.agent?.enabled)
  const [agentEnabled, setAgentEnabled] = useState(initialAgentEnabled)
  const [agentProvider, setAgentProvider] = useState<AiModelProvider>(status?.agent?.provider ?? 'VOLCENGINE_ARK')
  const [agentModel, setAgentModel] = useState(status?.agent?.model ?? '')
  const [agentBaseUrl, setAgentBaseUrl] = useState(status?.agent?.baseUrl ?? PROVIDER_DEFAULT_BASE_URLS.VOLCENGINE_ARK)
  const [agentApiKey, setAgentApiKey] = useState('')
  const [agentAvailableModelsInput, setAgentAvailableModelsInput] = useState(
    formatModelList(status?.agent?.availableModels),
  )

  const modelTest = useMutation({ mutationFn: testAiModelConnection })
  const agentTest = useMutation({ mutationFn: testAgentModelConnection })
  const modelSave = useMutation({
    mutationFn: saveAiModelConfiguration,
    onSuccess: (savedStatus) => {
      queryClient.setQueryData(['ai-model-status'], savedStatus)
      if (savedStatus.embeddingModel) setEmbeddingModel(savedStatus.embeddingModel)
      setAgentEnabled(Boolean(savedStatus.agent?.enabled))
      if (savedStatus.agent?.provider) setAgentProvider(savedStatus.agent.provider)
      if (savedStatus.agent?.model !== undefined) setAgentModel(savedStatus.agent.model)
      if (savedStatus.agent?.baseUrl) setAgentBaseUrl(savedStatus.agent.baseUrl)
      if (savedStatus.agent?.availableModels) {
        setAgentAvailableModelsInput(formatModelList(savedStatus.agent.availableModels))
      }
      setApiKey('')
      setAgentApiKey('')
      modelTest.reset()
      agentTest.reset()
    },
  })

  function handleProviderChange(nextValue: string) {
    const next = nextValue as AiModelProvider
    const prevDefault = PROVIDER_DEFAULT_BASE_URLS[provider]
    setProvider(next)
    if (!baseUrl.trim() || baseUrl.trim() === prevDefault) {
      setBaseUrl(PROVIDER_DEFAULT_BASE_URLS[next])
    }
  }

  function handleAgentProviderChange(nextValue: string) {
    const next = nextValue as AiModelProvider
    const prevDefault = PROVIDER_DEFAULT_BASE_URLS[agentProvider]
    setAgentProvider(next)
    if (!agentBaseUrl.trim() || agentBaseUrl.trim() === prevDefault) {
      setAgentBaseUrl(PROVIDER_DEFAULT_BASE_URLS[next])
    }
  }

  function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const payload: Parameters<typeof saveAiModelConfiguration>[0] = {
      provider,
      model: model.trim(),
      embeddingModel: embeddingModel.trim() || undefined,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim() || undefined,
    }
    if (agentEnabled) {
      payload.agentEnabled = true
      payload.agentProvider = agentProvider
      payload.agentModel = agentModel.trim()
      payload.agentBaseUrl = agentBaseUrl.trim()
      const parsedModels = parseModelList(agentAvailableModelsInput)
      if (parsedModels.length > 0) payload.agentAvailableModels = parsedModels
      if (agentApiKey.trim()) payload.agentApiKey = agentApiKey.trim()
    } else if (initialAgentEnabled) {
      payload.agentEnabled = false
    }
    modelSave.mutate(payload)
  }

  const agentCanSave = !agentEnabled || (
    Boolean(agentModel.trim())
    && Boolean(agentBaseUrl.trim())
    && (Boolean(status?.agent?.apiKeyConfigured) || Boolean(agentApiKey.trim()))
  )
  const usageModels = status?.usage?.models ?? []

  return (
    <form className="settings-form" onSubmit={saveModel}>
      <div className="settings-field"><span>模型提供商</span><SelectField value={provider} onChange={handleProviderChange} ariaLabel="模型提供商" disabled={isGuest || modelSave.isPending} options={MODEL_PROVIDER_OPTIONS} /><small>用于 MCP 轻辅助模式、企业知识库问答与聊天分析。</small></div>
      <label><span>模型名称</span><input aria-label="模型名称" type="text" required maxLength={120} value={model} disabled={isGuest || modelSave.isPending} onChange={(event) => setModel(event.target.value)} placeholder="例如：qwen4-max 或 qwen3.7-plus" /><small>保存后立即用于新的模型调用，无需重启服务。</small></label>
      <label><span>向量模型（Embedding）</span><input aria-label="向量模型" type="text" maxLength={120} value={embeddingModel} disabled={isGuest || modelSave.isPending} onChange={(event) => setEmbeddingModel(event.target.value)} placeholder="默认：qwen3.7-text-embedding-flash" /><small>用于企业知识库语义检索，复用上方 API Key 与地址；留空使用系统默认（1024 维）。</small></label>
      <label><span>API Key</span><input aria-label="API Key" type="password" maxLength={500} autoComplete="new-password" value={apiKey} disabled={isGuest || modelSave.isPending} onChange={(event) => setApiKey(event.target.value)} placeholder={status?.apiKeyConfigured ? '已加密保存，留空表示不修改' : '请输入百炼 API Key'} /><small>{status?.apiKeyConfigured ? '密钥已加密保存，页面不会读取或回显原文。' : '首次保存必须输入 Key，数据库只保存 AES-GCM 密文。'}</small></label>
      <label className="field-span-2"><span>API 地址</span><input aria-label="API 地址" type="url" required maxLength={500} value={baseUrl} disabled={isGuest || modelSave.isPending} onChange={(event) => setBaseUrl(event.target.value)} /><small>仅接受 HTTPS 地址，默认使用百炼中国大陆兼容端点。</small></label>

      <div className="settings-subpanel field-span-2">
        <div className="settings-subpanel-header">
          <div>
            <h3>自主 Agent 专用模型</h3>
            <p>开启后，自主 Agent 空间的多步规划与总结将走独立套餐通道（如火山引擎方舟 Agent Plan），MCP 助手与知识库仍使用上方默认免费/主模型。</p>
          </div>
          <label className="settings-inline-switch">
            <input aria-label="启用自主 Agent 专用模型" type="checkbox" checked={agentEnabled} disabled={isGuest || modelSave.isPending} onChange={(event) => setAgentEnabled(event.target.checked)} />
            <span>{agentEnabled ? '已启用独立通道' : '沿用默认模型'}</span>
          </label>
        </div>

        {agentEnabled && (
          <div className="settings-subpanel-grid">
            <div className="settings-field"><span>Agent 提供商</span><SelectField value={agentProvider} onChange={handleAgentProviderChange} ariaLabel="Agent 提供商" disabled={isGuest || modelSave.isPending} options={MODEL_PROVIDER_OPTIONS} /><small>火山引擎方舟 Agent Plan 请使用专属 /api/plan/v3 端点与专属 API Key。</small></div>
            <label><span>Agent 模型名称</span><input aria-label="Agent 模型名称" type="text" required maxLength={120} value={agentModel} disabled={isGuest || modelSave.isPending} onChange={(event) => setAgentModel(event.target.value)} placeholder="例如：doubao-seed-2.1-pro 或 deepseek-v4-pro" /><small>请填写套餐控制台中该 Plan 支持的模型 ID。</small></label>
            <label><span>Agent API Key</span><input aria-label="Agent API Key" type="password" maxLength={500} autoComplete="new-password" value={agentApiKey} disabled={isGuest || modelSave.isPending} onChange={(event) => setAgentApiKey(event.target.value)} placeholder={status?.agent?.apiKeyConfigured ? '已加密保存，留空表示不修改' : '请输入 Agent Plan 专属 API Key'} /><small>{status?.agent?.apiKeyConfigured ? '密钥已加密保存，留空不覆盖。' : '数据库仅保存 AES-GCM 密文，与默认通道密钥隔离。'}</small></label>
            <label><span>Agent API 地址</span><input aria-label="Agent API 地址" type="url" required maxLength={500} value={agentBaseUrl} disabled={isGuest || modelSave.isPending} onChange={(event) => setAgentBaseUrl(event.target.value)} placeholder="https://ark.cn-beijing.volces.com/api/plan/v3" /><small>仅接受 HTTPS 地址；火山方舟 Agent Plan 勿填按量端点 /api/v3。</small></label>
            <label className="field-span-2">
              <span className="settings-label-row">
                <span>可选切换模型列表（用于 Agent 对话框左下角一键选模型）</span>
                {agentProvider === 'VOLCENGINE_ARK' ? (
                  <button
                    type="button"
                    className="compact-button"
                    disabled={isGuest || modelSave.isPending}
                    onClick={() => {
                      setAgentAvailableModelsInput(VOLCENGINE_AGENT_PRESET_MODELS.join(', '))
                      if (!agentModel.trim()) setAgentModel(VOLCENGINE_AGENT_PRESET_MODELS[0])
                    }}
                  >
                    填入方舟 Agent Plan 常用模型
                  </button>
                ) : null}
              </span>
              <input
                aria-label="Agent 可选模型列表"
                type="text"
                maxLength={1000}
                value={agentAvailableModelsInput}
                disabled={isGuest || modelSave.isPending}
                onChange={(event) => setAgentAvailableModelsInput(event.target.value)}
                placeholder="多个模型用英文逗号分隔，例如：doubao-seed-2.1-pro, deepseek-v4-pro, glm-5.3, kimi-k3"
              />
              <small>留空时方舟通道默认提供 5 个常用 Agent Plan 模型；自定义后仅允许在所列模型与默认模型间切换。</small>
            </label>
            <div className="settings-subpanel-actions field-span-2">
              <span className={`model-test-result${agentTest.isError ? ' is-error' : ''}`} role="status">
                {agentTest.isSuccess
                  ? `Agent 连接成功 · ${agentTest.data.model} · ${agentTest.data.latencyMs} ms`
                  : agentTest.isError
                    ? agentTest.error.message
                    : status?.agent?.ready
                      ? `当前独立通道已就绪：${PROVIDER_LABELS[status.agent.provider] ?? status.agent.provider} / ${status.agent.model}`
                      : '保存配置后可点击右侧测试自主 Agent 专用通道。'}
              </span>
              <button className="button button-secondary" type="button" disabled={isGuest || !status?.agent?.ready || agentTest.isPending || modelSave.isPending} onClick={() => agentTest.mutate()}>
                {agentTest.isPending ? '正在测试 Agent…' : '测试 Agent 连接'}
              </button>
            </div>
          </div>
        )}
      </div>

      {usageModels.length > 0 && (
        <div className="settings-subpanel field-span-2">
          <div className="settings-subpanel-header">
            <div>
              <h3>按模型用量统计</h3>
              <p>基于本系统记录的成功模型调用汇总（用于核对各平台免费额度或套餐消耗）。</p>
            </div>
          </div>
          <div className="settings-usage-table-wrap">
            <table className="settings-usage-table">
              <thead>
                <tr>
                  <th>提供商</th>
                  <th>模型</th>
                  <th>成功调用</th>
                  <th>输入 Token</th>
                  <th>输出 Token</th>
                  <th>总用量</th>
                </tr>
              </thead>
              <tbody>
                {usageModels.map((item) => (
                  <tr key={`${item.provider}:${item.model}`}>
                    <td>{PROVIDER_LABELS[item.provider] ?? item.provider}</td>
                    <td><code>{item.model}</code></td>
                    <td>{item.successfulCalls.toLocaleString()}</td>
                    <td>{item.inputTokens.toLocaleString()}</td>
                    <td>{item.outputTokens.toLocaleString()}</td>
                    <td><strong>{item.totalTokens.toLocaleString()}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="settings-form-actions">
        <span className={`model-test-result${modelTest.isError || modelSave.isError ? ' is-error' : ''}`} role="status">
          {modelTest.isSuccess ? `连接成功 · ${modelTest.data.latencyMs} ms · ${modelTest.data.responsePreview}` : modelTest.isError ? modelTest.error.message : modelSave.isSuccess ? '配置已加密保存。' : modelSave.isError ? modelSave.error.message : '请先保存配置，再测试连接。测试会产生一次极少量模型调用。'}
        </span>
        <button className="button button-secondary" type="button" disabled={isGuest || !status?.apiKeyConfigured || modelTest.isPending || modelSave.isPending} title={isGuest ? '游客模式不能调用模型' : undefined} onClick={() => modelTest.mutate()}>{modelTest.isPending ? '正在连接…' : '测试连接'}</button>
        <button className="button button-primary" type="submit" disabled={isGuest || modelSave.isPending || !model.trim() || !baseUrl.trim() || (!status?.apiKeyConfigured && !apiKey.trim()) || !agentCanSave}>{modelSave.isPending ? '保存中…' : '保存配置'}</button>
      </div>
    </form>
  )
}

interface EmailSettingsFormProps {
  status?: EmailSettingsStatus
  isGuest: boolean
}

function EmailSettingsForm({ status, isGuest }: EmailSettingsFormProps) {
  const queryClient = useQueryClient()
  const [host, setHost] = useState(status?.host ?? 'smtp.example.com')
  const [port, setPort] = useState(String(status?.port ?? 587))
  const [username, setUsername] = useState(status?.username ?? '')
  const [password, setPassword] = useState('')
  const [fromAddress, setFromAddress] = useState(status?.fromAddress ?? status?.username ?? '')
  const [smtpAuth, setSmtpAuth] = useState(status?.smtpAuth ?? true)
  const [starttlsEnabled, setStarttlsEnabled] = useState(status?.starttlsEnabled ?? true)
  const [starttlsRequired, setStarttlsRequired] = useState(status?.starttlsRequired ?? false)
  const emailTest = useMutation({ mutationFn: testEmailSettingsConnection })
  const emailSave = useMutation({
    mutationFn: saveEmailSettings,
    onSuccess: (savedStatus) => {
      queryClient.setQueryData(['email-settings-status'], savedStatus)
      setPassword('')
      emailTest.reset()
    },
  })

  function saveEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    emailSave.mutate({
      host: host.trim(),
      port: Number(port),
      username: username.trim() || undefined,
      password: password.trim() || undefined,
      fromAddress: fromAddress.trim(),
      smtpAuth,
      starttlsEnabled,
      starttlsRequired,
    })
  }

  const statusText = emailTest.isSuccess
    ? `${emailTest.data.message} · ${emailTest.data.latencyMs} ms`
    : emailTest.isError
      ? emailTest.error.message
      : emailSave.isSuccess
        ? '发件邮箱配置已加密保存。'
        : emailSave.isError
          ? emailSave.error.message
          : status?.status === 'ENV_FALLBACK'
            ? '当前使用服务器环境变量兜底，保存后会优先使用页面配置。'
            : '请保存配置后测试连接；密码或授权码只保存密文。'

  return (
    <form className="settings-form" onSubmit={saveEmail}>
      <label><span>SMTP 服务器</span><input aria-label="SMTP 服务器" type="text" required maxLength={255} value={host} disabled={isGuest || emailSave.isPending} onChange={(event) => setHost(event.target.value)} placeholder="smtp.example.com" /></label>
      <label><span>端口</span><input aria-label="SMTP 端口" type="number" required min={1} max={65535} value={port} disabled={isGuest || emailSave.isPending} onChange={(event) => setPort(event.target.value)} placeholder="587" /></label>
      <label><span>账号</span><input aria-label="SMTP 账号" type="email" maxLength={320} value={username} disabled={isGuest || emailSave.isPending} onChange={(event) => setUsername(event.target.value)} placeholder="notifications@example.com" /></label>
      <label><span>密码/授权码</span><input aria-label="SMTP 密码或授权码" type="password" maxLength={500} autoComplete="new-password" value={password} disabled={isGuest || emailSave.isPending} onChange={(event) => setPassword(event.target.value)} placeholder={status?.passwordConfigured ? '已加密保存，留空表示不修改' : '请输入 SMTP 授权码'} /><small>{status?.passwordConfigured ? '页面不会读取或回显原文。' : '常见邮箱需要使用 SMTP 授权码，不是登录密码。'}</small></label>
      <label className="field-span-2"><span>发件人</span><input aria-label="发件人邮箱" type="email" required maxLength={320} value={fromAddress} disabled={isGuest || emailSave.isPending} onChange={(event) => setFromAddress(event.target.value)} placeholder="notifications@example.com" /></label>
      <div className="settings-toggle-row"><label><input type="checkbox" checked={smtpAuth} disabled={isGuest || emailSave.isPending} onChange={(event) => setSmtpAuth(event.target.checked)} /><span>SMTP 认证</span></label><label><input type="checkbox" checked={starttlsEnabled} disabled={isGuest || emailSave.isPending} onChange={(event) => setStarttlsEnabled(event.target.checked)} /><span>启用 STARTTLS</span></label><label><input type="checkbox" checked={starttlsRequired} disabled={isGuest || emailSave.isPending} onChange={(event) => setStarttlsRequired(event.target.checked)} /><span>要求 STARTTLS</span></label></div>
      <div className="settings-form-actions">
        <span className={`model-test-result${emailTest.isError || emailSave.isError ? ' is-error' : ''}`} role="status">{statusText}</span>
        <button className="button button-secondary" type="button" disabled={isGuest || !status?.ready || emailTest.isPending || emailSave.isPending} title={isGuest ? '游客模式不能测试邮箱' : undefined} onClick={() => emailTest.mutate()}>{emailTest.isPending ? '正在连接…' : '测试连接'}</button>
        <button className="button button-primary" type="submit" disabled={isGuest || emailSave.isPending || !host.trim() || !port.trim() || !fromAddress.trim() || (smtpAuth && !status?.passwordConfigured && !password.trim())}>{emailSave.isPending ? '保存中…' : '保存配置'}</button>
      </div>
    </form>
  )
}

export function SettingsPage() {
  const isGuest = useIsGuest()
  const healthQuery = useQuery({ queryKey: ['system-health'], queryFn: getSystemHealth })
  const modelQuery = useQuery({ queryKey: ['ai-model-status'], queryFn: getAiModelStatus })
  const emailQuery = useQuery({ queryKey: ['email-settings-status'], queryFn: getEmailSettingsStatus })
  const modelStatus = modelQuery.data
  const emailStatus = emailQuery.data

  const modelStatusLabel = modelQuery.isPending
    ? '检查中'
    : modelStatus?.ready
      ? '已就绪'
      : modelStatus?.apiKeyConfigured
        ? '主密钥不可用'
        : '待配置'
  const emailStatusLabel = emailQuery.isPending
    ? '检查中'
    : emailStatus?.ready
      ? emailStatus.status === 'ENV_FALLBACK' ? '使用服务器配置' : '已就绪'
      : emailStatus?.passwordConfigured
        ? '主密钥不可用'
        : '待配置'

  return (
    <section className="module-page settings-page">
      <header className="page-heading module-heading">
        <div><p className="eyebrow">工作区配置</p><h1>设置</h1><p>配置组织、销售规则、模型和外部系统连接。</p></div>
      </header>

      <div className="settings-content">
          <section className="surface settings-section" id="integrations">
            <div className="panel-header"><div><h2>系统连接</h2><p>管理业务数据和运行服务</p></div></div>
            <div className="integration-list">
              <div>
                <span className="integration-icon"><Database size={18} /></span>
                <span><strong>后端 API</strong><small>http://localhost:8080</small></span>
                {healthQuery.isPending ? <span className="status-badge status-loading">检查中</span> : healthQuery.isSuccess ? <span className="status-badge status-success"><CheckCircle size={11} />已连接</span> : <span className="status-badge status-error"><WarningCircle size={11} />未连接</span>}
                <button className="compact-button" type="button" onClick={() => void healthQuery.refetch()}>重新检查</button>
              </div>
              <div>
                <span className="integration-icon"><Database size={18} /></span>
                <span><strong>CRM 集成</strong><small>同步客户、联系人与商机数据</small></span>
                <span className="status-badge status-muted">未配置</span>
                <button className="compact-button" type="button" disabled>配置</button>
              </div>
              <div>
                <span className="integration-icon"><EnvelopeSimple size={18} /></span>
                <span><strong>发件邮箱</strong><small>审批通过后用于真实发送客户邮件</small></span>
                <span className={`status-badge ${emailStatus?.ready ? 'status-success' : emailQuery.isError ? 'status-error' : 'status-muted'}`}>{emailStatus?.ready ? <CheckCircle size={11} /> : null}{emailStatusLabel}</span>
                <a className="compact-button" href="#email-settings">配置</a>
              </div>
            </div>
          </section>

          <section className="surface settings-section" id="model">
            <div className="panel-header">
              <div><h2>AI 模型</h2><p>支持默认模型（MCP 助手与知识库）与自主 Agent 专用通道（如火山引擎方舟 Agent Plan）分流</p></div>
              <span className={`status-badge ${modelStatus?.ready ? 'status-success' : modelQuery.isError ? 'status-error' : 'status-muted'}`}>
                {modelStatus?.ready ? <CheckCircle size={11} /> : null}{modelStatusLabel}
              </span>
            </div>
            {modelQuery.isPending
              ? <div className="settings-form" role="status">正在读取模型配置…</div>
              : <AiModelSettingsForm status={modelStatus} isGuest={isGuest} />}
          </section>

          <section className="surface settings-section" id="email-settings">
            <div className="panel-header">
              <div><h2>发件邮箱</h2><p>配置审批通过后发送客户邮件的 SMTP 通道</p></div>
              <span className={`status-badge ${emailStatus?.ready ? 'status-success' : emailQuery.isError ? 'status-error' : 'status-muted'}`}>
                {emailStatus?.ready ? <CheckCircle size={11} /> : null}{emailStatusLabel}
              </span>
            </div>
            {emailQuery.isPending
              ? <div className="settings-form" role="status">正在读取邮箱配置…</div>
              : <EmailSettingsForm status={emailStatus} isGuest={isGuest} />}
          </section>

          <MailAccountSettings />

          <section className="surface settings-section" id="approval-policy">
            <div className="panel-header"><div><h2>审批策略</h2><p>确定哪些 Agent 动作必须经过人工确认</p></div></div>
            <div className="setting-switch-list">
              <label><span><strong>发送客户消息</strong><small>邮件、短信和企业微信消息</small></span><input type="checkbox" defaultChecked disabled={isGuest} /></label>
              <label><span><strong>更新敏感 CRM 字段</strong><small>商机金额、阶段和关闭原因</small></span><input type="checkbox" defaultChecked disabled={isGuest} /></label>
              <label><span><strong>创建内部跟进任务</strong><small>仅影响工作区内部数据</small></span><input type="checkbox" disabled={isGuest} /></label>
            </div>
          </section>

          <section className="surface settings-section" id="members">
            <div className="panel-header"><div><h2>成员权限</h2><p>当前工作区成员</p></div></div>
            <div className="member-row"><span className="user-avatar">管</span><span><strong>系统管理员</strong><small>当前用户</small></span><span className="stage-label">管理员</span></div>
          </section>
      </div>
    </section>
  )
}

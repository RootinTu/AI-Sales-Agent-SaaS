package com.yourcompany.salesagent.ai.application;

import java.net.URI;
import java.time.Clock;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import com.yourcompany.salesagent.ai.api.AiAgentModelStatusResponse;
import com.yourcompany.salesagent.ai.api.AiModelStatusResponse;
import com.yourcompany.salesagent.ai.api.AiModelTestResponse;
import com.yourcompany.salesagent.ai.api.AiModelUpdateRequest;
import com.yourcompany.salesagent.ai.api.AiModelUsageResponse;
import com.yourcompany.salesagent.ai.domain.AiModelConfiguration;
import com.yourcompany.salesagent.ai.infrastructure.AiModelConfigurationMapper;
import com.yourcompany.salesagent.ai.infrastructure.AiModelDefaultsProperties;
import com.yourcompany.salesagent.ai.infrastructure.AiOrchestrationClient;
import com.yourcompany.salesagent.ai.infrastructure.ModelCallMapper;
import com.yourcompany.salesagent.ai.infrastructure.ModelUsageSummaryRow;
import com.yourcompany.salesagent.shared.security.SecretCipher;
import com.yourcompany.salesagent.shared.security.SecretEncryptionException;

@Service
public class AiModelService {

	public static final String DEFAULT_AGENT_PROVIDER = "VOLCENGINE_ARK";
	public static final String DEFAULT_AGENT_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
	public static final List<String> DEFAULT_VOLCENGINE_AGENT_MODELS = List.of(
			"doubao-seed-2.1-pro",
			"doubao-seed-evolving",
			"deepseek-v4-pro",
			"glm-5.3",
			"kimi-k3");

	public record ResolvedAgentModel(
			AiModelRuntimeConfiguration configuration,
			boolean independentChannel) {
	}

	private final AiOrchestrationClient modelClient;
	private final AiModelConfigurationMapper configurationMapper;
	private final ModelCallMapper modelCallMapper;
	private final SecretCipher secretCipher;
	private final AiModelDefaultsProperties properties;
	private final Clock clock;

	public AiModelService(
			AiOrchestrationClient modelClient,
			AiModelConfigurationMapper configurationMapper,
			ModelCallMapper modelCallMapper,
			SecretCipher secretCipher,
			AiModelDefaultsProperties properties,
			Clock clock) {
		this.modelClient = modelClient;
		this.configurationMapper = configurationMapper;
		this.modelCallMapper = modelCallMapper;
		this.secretCipher = secretCipher;
		this.properties = properties;
		this.clock = clock;
	}

	@Transactional(readOnly = true)
	public AiModelStatusResponse status(UUID organizationId) {
		return status(organizationId, null);
	}

	@Transactional(readOnly = true)
	public AiModelStatusResponse status(UUID organizationId, UUID memberId) {
		var configuration = configurationMapper.selectById(organizationId);
		if (configuration == null) {
			return new AiModelStatusResponse(
					"QWEN",
					properties.model(),
					properties.embeddingModel(),
					properties.baseUrl(),
					false,
					false,
					"MISSING_API_KEY",
					usageSummary(organizationId, memberId),
					defaultAgentStatus());
		}
		var ready = canDecrypt(organizationId, configuration.getEncryptedApiKey());
		return new AiModelStatusResponse(
				configuration.getProvider(),
				configuration.getModelName(),
				effectiveEmbeddingModel(configuration.getEmbeddingModel()),
				configuration.getBaseUrl(),
				true,
				ready,
				ready ? "READY" : "ENCRYPTION_KEY_UNAVAILABLE",
				usageSummary(organizationId, memberId),
				agentStatus(organizationId, configuration));
	}

	@Transactional
	public AiModelStatusResponse update(UUID organizationId, AiModelUpdateRequest request) {
		validateBaseUrl(request.baseUrl(), "API 地址必须是有效的 HTTPS 地址");
		var configuration = configurationMapper.selectById(organizationId);
		var encryptedApiKey = configuration == null ? null : configuration.getEncryptedApiKey();
		if (StringUtils.hasText(request.apiKey())) {
			encryptedApiKey = secretCipher.encrypt(organizationId, request.apiKey().strip());
		}
		if (!StringUtils.hasText(encryptedApiKey)) {
			throw new AiModelConfigurationException("首次保存时必须输入 API Key");
		}

		var now = clock.instant();
		var provider = StringUtils.hasText(request.provider()) ? request.provider().strip() : "QWEN";
		var embeddingModel = StringUtils.hasText(request.embeddingModel()) ? request.embeddingModel().strip() : null;
		boolean inserting = configuration == null;
		if (inserting) {
			configuration = AiModelConfiguration.create(
					organizationId,
					provider,
					request.model().strip(),
					embeddingModel,
					request.baseUrl().strip(),
					encryptedApiKey,
					now);
		}
		else {
			configuration.update(
					provider,
					request.model().strip(),
					embeddingModel,
					request.baseUrl().strip(),
					encryptedApiKey,
					now);
		}

		if (Boolean.TRUE.equals(request.agentEnabled())) {
			if (!StringUtils.hasText(request.agentModel())) {
				throw new AiModelConfigurationException("启用自主 Agent 专用模型时必须填写模型名称");
			}
			if (!StringUtils.hasText(request.agentBaseUrl())) {
				throw new AiModelConfigurationException("启用自主 Agent 专用模型时必须填写 API 地址");
			}
			validateBaseUrl(request.agentBaseUrl(), "自主 Agent API 地址必须是有效的 HTTPS 地址");
			var encryptedAgentKey = configuration.getEncryptedAgentApiKey();
			if (StringUtils.hasText(request.agentApiKey())) {
				encryptedAgentKey = secretCipher.encrypt(organizationId, request.agentApiKey().strip());
			}
			if (!StringUtils.hasText(encryptedAgentKey)) {
				throw new AiModelConfigurationException("首次启用自主 Agent 专用模型时必须输入 API Key");
			}
			var agentProvider = StringUtils.hasText(request.agentProvider())
					? request.agentProvider().strip()
					: DEFAULT_AGENT_PROVIDER;
			var normalizedAgentModel = request.agentModel().strip();
			var serializedAvailableModels = request.agentAvailableModels() != null
					? serializeAvailableModels(normalizedAgentModel, request.agentAvailableModels())
					: configuration.getAgentAvailableModels();
			configuration.updateAgentConfiguration(
					agentProvider,
					normalizedAgentModel,
					request.agentBaseUrl().strip(),
					encryptedAgentKey,
					serializedAvailableModels,
					now);
		}
		else if (Boolean.FALSE.equals(request.agentEnabled())) {
			configuration.clearAgentConfiguration(now);
		}

		if (inserting) {
			configurationMapper.insert(configuration);
		}
		else {
			configurationMapper.updateById(configuration);
		}
		return status(organizationId);
	}

	@Transactional(readOnly = true)
	public AiModelTestResponse testConnection(UUID organizationId) {
		var configuration = requireRuntimeConfiguration(organizationId);
		return executeConnectionTest(configuration);
	}

	@Transactional(readOnly = true)
	public AiModelTestResponse testAgentConnection(UUID organizationId) {
		var stored = configurationMapper.selectById(organizationId);
		if (stored == null || !stored.hasCustomAgentConfiguration()) {
			throw new AiModelNotConfiguredException("尚未配置自主 Agent 专用模型，请先开启并保存配置。");
		}
		return executeConnectionTest(decryptAgentConfiguration(organizationId, stored));
	}

	private AiModelTestResponse executeConnectionTest(AiModelRuntimeConfiguration configuration) {
		var startedAt = clock.millis();
		try {
			var content = modelClient.testConnection(configuration);
			return new AiModelTestResponse(
					configuration.provider(),
					configuration.model(),
					"CONNECTED",
					content == null ? "" : content.strip(),
					Math.max(0, clock.millis() - startedAt));
		}
		catch (RuntimeException exception) {
			throw new AiModelConnectionException(
					"连接模型服务失败，请检查模型名称、API Key、API 地址或当前套餐窗口限流状态。", exception);
		}
	}

	@Transactional(readOnly = true)
	public AiModelRuntimeConfiguration requireRuntimeConfiguration(UUID organizationId) {
		var configuration = configurationMapper.selectById(organizationId);
		if (configuration == null) {
			throw new AiModelNotConfiguredException("请先在设置中配置 AI 模型 API Key。");
		}
		try {
			var apiKey = secretCipher.decrypt(organizationId, configuration.getEncryptedApiKey());
			return new AiModelRuntimeConfiguration(
					configuration.getProvider(),
					configuration.getModelName(),
					effectiveEmbeddingModel(configuration.getEmbeddingModel()),
					configuration.getBaseUrl(),
					apiKey);
		}
		catch (SecretEncryptionException exception) {
			throw new AiModelConfigurationException("服务器加密主密钥不可用，无法解密已保存的模型配置。", exception);
		}
	}

	/**
	 * 获取自主 Agent 模式的运行时模型配置。
	 * 若组织已配置独立的自主 Agent 专用模型（例如火山引擎方舟 Agent Plan），优先返回该专用配置；
	 * 否则自动平滑回退到组织默认主模型。
	 */
	@Transactional(readOnly = true)
	public AiModelRuntimeConfiguration requireAgentRuntimeConfiguration(UUID organizationId) {
		var configuration = configurationMapper.selectById(organizationId);
		if (configuration == null) {
			throw new AiModelNotConfiguredException("请先在设置中配置 AI 模型 API Key。");
		}
		if (configuration.hasCustomAgentConfiguration()) {
			return decryptAgentConfiguration(organizationId, configuration, configuration.getAgentModelName());
		}
		return requireRuntimeConfiguration(organizationId);
	}

	@Transactional(readOnly = true)
	public AiModelRuntimeConfiguration requireAgentRuntimeConfiguration(UUID organizationId, UUID memberId) {
		return resolveAgentRuntimeConfiguration(organizationId, memberId, null).configuration();
	}

	/**
	 * 解析自主 Agent 运行时模型配置（支持对话内一键切换模型）。
	 * - 当请求命中独立 Agent 通道（如火山方舟 Agent Plan）模型列表时，直接走独立通道，不消耗也不受限于 MCP 免费对话额度；
	 * - 当用户显式切回组织默认模型或未启用独立通道时，走默认通道并校验 MCP 普通对话模型配额。
	 */
	@Transactional(readOnly = true)
	public ResolvedAgentModel resolveAgentRuntimeConfiguration(UUID organizationId, UUID memberId, String requestedModel) {
		var configuration = configurationMapper.selectById(organizationId);
		if (configuration == null) {
			throw new AiModelNotConfiguredException("请先在设置中配置 AI 模型 API Key。");
		}
		var targetModel = StringUtils.hasText(requestedModel) ? requestedModel.strip() : null;
		if (configuration.hasCustomAgentConfiguration()) {
			var availableModels = resolveAvailableAgentModels(configuration);
			if (targetModel == null) {
				return new ResolvedAgentModel(
						decryptAgentConfiguration(organizationId, configuration, configuration.getAgentModelName()),
						true);
			}
			if (availableModels.contains(targetModel)) {
				return new ResolvedAgentModel(
						decryptAgentConfiguration(organizationId, configuration, targetModel),
						true);
			}
			if (targetModel.equals(configuration.getModelName())) {
				requireAvailableTokenQuota(organizationId, memberId);
				return new ResolvedAgentModel(requireRuntimeConfiguration(organizationId), false);
			}
			throw new AiModelConfigurationException("不支持切换到未配置的 Agent 模型：" + targetModel);
		}
		if (targetModel != null && !targetModel.equals(configuration.getModelName())) {
			throw new AiModelConfigurationException("当前未启用自主 Agent 独立通道，不支持切换到模型：" + targetModel);
		}
		requireAvailableTokenQuota(organizationId, memberId);
		return new ResolvedAgentModel(requireRuntimeConfiguration(organizationId), false);
	}

	@Transactional(readOnly = true)
	public Optional<AiModelRuntimeConfiguration> findRuntimeConfiguration(UUID organizationId) {
		var configuration = configurationMapper.selectById(organizationId);
		if (configuration == null) {
			return Optional.empty();
		}
		try {
			var apiKey = secretCipher.decrypt(organizationId, configuration.getEncryptedApiKey());
			return Optional.of(new AiModelRuntimeConfiguration(
					configuration.getProvider(),
					configuration.getModelName(),
					effectiveEmbeddingModel(configuration.getEmbeddingModel()),
					configuration.getBaseUrl(),
					apiKey));
		}
		catch (SecretEncryptionException exception) {
			return Optional.empty();
		}
	}

	public int defaultEmbeddingDimensions() {
		return properties.embeddingDimensions();
	}

	private String effectiveEmbeddingModel(String configuredEmbeddingModel) {
		return StringUtils.hasText(configuredEmbeddingModel)
				? configuredEmbeddingModel.strip()
				: properties.embeddingModel();
	}

	@Transactional(readOnly = true)
	public AiModelRuntimeConfiguration requireRuntimeConfiguration(UUID organizationId, UUID memberId) {
		requireAvailableTokenQuota(organizationId, memberId);
		return requireRuntimeConfiguration(organizationId);
	}

	@Transactional(readOnly = true)
	public void requireAvailableTokenQuota(UUID organizationId, UUID memberId) {
		var usage = modelCallMapper.selectMemberTokenUsage(organizationId, memberId);
		if (usage == null || usage.allocatedTokens() == null || usage.allocatedTokens() <= 0) {
			throw new TokenQuotaExceededException("管理员尚未为你分配 Token 额度，暂时不能使用 MCP 助手");
		}
		if (usage.usedTokens() >= usage.allocatedTokens()) {
			throw new TokenQuotaExceededException("你的 Token 额度已用完，请联系团队管理员调整分配额度");
		}
	}

	/**
	 * 校验成员向量模型（Embedding）配额。
	 * 若团队或成员已启用独立向量模型配额，则严格按向量模型配额校验；
	 * 若团队尚未启用独立向量模型预算，则保持平滑兼容（不阻断存量环境）。
	 */
	@Transactional(readOnly = true)
	public void requireAvailableEmbeddingQuota(UUID organizationId, UUID memberId) {
		var usage = modelCallMapper.selectMemberTokenUsage(organizationId, memberId);
		if (usage == null) {
			return;
		}
		if (usage.embeddingAllocatedTokens() != null) {
			if (usage.embeddingAllocatedTokens() <= 0 || usage.embeddingUsedTokens() >= usage.embeddingAllocatedTokens()) {
				throw new TokenQuotaExceededException("你的向量模型 Token 额度已用完，请联系团队管理员调整向量模型配额");
			}
			return;
		}
		if (usage.teamEmbeddingBudgetTokens() != null) {
			throw new TokenQuotaExceededException("管理员尚未为你分配向量模型 Token 额度，暂时不能执行知识库向量化或语义检索");
		}
	}

	private AiModelRuntimeConfiguration decryptAgentConfiguration(UUID organizationId, AiModelConfiguration configuration) {
		return decryptAgentConfiguration(organizationId, configuration, configuration.getAgentModelName());
	}

	private AiModelRuntimeConfiguration decryptAgentConfiguration(
			UUID organizationId,
			AiModelConfiguration configuration,
			String modelOverride) {
		try {
			var agentApiKey = secretCipher.decrypt(organizationId, configuration.getEncryptedAgentApiKey());
			var provider = StringUtils.hasText(configuration.getAgentProvider())
					? configuration.getAgentProvider().strip()
					: DEFAULT_AGENT_PROVIDER;
			var resolvedModel = StringUtils.hasText(modelOverride)
					? modelOverride.strip()
					: configuration.getAgentModelName();
			return new AiModelRuntimeConfiguration(
					provider,
					resolvedModel,
					effectiveEmbeddingModel(configuration.getEmbeddingModel()),
					configuration.getAgentBaseUrl(),
					agentApiKey);
		}
		catch (SecretEncryptionException exception) {
			throw new AiModelConfigurationException("服务器加密主密钥不可用，无法解密自主 Agent 专用模型配置。", exception);
		}
	}

	private AiAgentModelStatusResponse defaultAgentStatus() {
		return new AiAgentModelStatusResponse(
				false,
				DEFAULT_AGENT_PROVIDER,
				"",
				DEFAULT_AGENT_BASE_URL,
				false,
				false,
				"INHERIT_DEFAULT",
				List.of());
	}

	private AiAgentModelStatusResponse agentStatus(UUID organizationId, AiModelConfiguration configuration) {
		if (!configuration.hasCustomAgentConfiguration()) {
			return defaultAgentStatus();
		}
		var ready = canDecrypt(organizationId, configuration.getEncryptedAgentApiKey());
		return new AiAgentModelStatusResponse(
				true,
				StringUtils.hasText(configuration.getAgentProvider()) ? configuration.getAgentProvider() : DEFAULT_AGENT_PROVIDER,
				configuration.getAgentModelName(),
				configuration.getAgentBaseUrl(),
				true,
				ready,
				ready ? "READY" : "ENCRYPTION_KEY_UNAVAILABLE",
				resolveAvailableAgentModels(configuration));
	}

	private List<String> resolveAvailableAgentModels(AiModelConfiguration configuration) {
		if (!configuration.hasCustomAgentConfiguration()) {
			return List.of();
		}
		var models = new LinkedHashSet<String>();
		if (StringUtils.hasText(configuration.getAgentModelName())) {
			models.add(configuration.getAgentModelName().strip());
		}
		if (StringUtils.hasText(configuration.getAgentAvailableModels())) {
			for (var token : configuration.getAgentAvailableModels().split("[,;\\r\\n]+")) {
				if (StringUtils.hasText(token)) {
					models.add(token.strip());
				}
			}
		}
		else if (DEFAULT_AGENT_PROVIDER.equals(configuration.getAgentProvider())) {
			models.addAll(DEFAULT_VOLCENGINE_AGENT_MODELS);
		}
		return List.copyOf(models);
	}

	private String serializeAvailableModels(String primaryModel, List<String> availableModels) {
		var models = new LinkedHashSet<String>();
		if (StringUtils.hasText(primaryModel)) {
			models.add(primaryModel.strip());
		}
		if (availableModels != null) {
			for (var item : availableModels) {
				if (StringUtils.hasText(item)) {
					models.add(item.strip());
				}
			}
		}
		return String.join(",", models);
	}

	private boolean canDecrypt(UUID organizationId, String encryptedKey) {
		if (!StringUtils.hasText(encryptedKey)) {
			return false;
		}
		try {
			return StringUtils.hasText(secretCipher.decrypt(organizationId, encryptedKey));
		}
		catch (SecretEncryptionException exception) {
			return false;
		}
	}

	private void validateBaseUrl(String value, String errorMessage) {
		try {
			var uri = URI.create(value.strip());
			if (!"https".equalsIgnoreCase(uri.getScheme()) || !StringUtils.hasText(uri.getHost())
					|| uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) {
				throw new IllegalArgumentException();
			}
		}
		catch (IllegalArgumentException exception) {
			throw new AiModelConfigurationException(errorMessage);
		}
	}

	private AiModelUsageResponse usageSummary(UUID organizationId, UUID memberId) {
		ModelUsageSummaryRow summary = modelCallMapper.selectAllUsageSummary(organizationId);
		ModelUsageSummaryRow embeddingSummary = modelCallMapper.selectEmbeddingUsageSummary(organizationId);
		ModelUsageSummaryRow agentSummary = modelCallMapper.selectAgentUsageSummary(organizationId);
		var memberUsage = memberId == null ? null : modelCallMapper.selectMemberTokenUsage(organizationId, memberId);
		var modelItems = toModelUsageItems(modelCallMapper.selectUsageByModel(organizationId));
		var agentModelItems = toModelUsageItems(modelCallMapper.selectAgentUsageByModel(organizationId));
		var inputTokens = summary == null ? 0 : summary.getInputTokens();
		var outputTokens = summary == null ? 0 : summary.getOutputTokens();
		var cachedInputTokens = summary == null ? 0 : summary.getCachedInputTokens();
		var embeddingTotalTokens = embeddingSummary == null
				? 0L
				: embeddingSummary.getInputTokens() + embeddingSummary.getOutputTokens();
		var embeddingSuccessfulCalls = embeddingSummary == null ? 0L : embeddingSummary.getSuccessfulCalls();
		var agentInputTokens = agentSummary == null ? 0L : agentSummary.getInputTokens();
		var agentOutputTokens = agentSummary == null ? 0L : agentSummary.getOutputTokens();
		var agentCachedInputTokens = agentSummary == null ? 0L : agentSummary.getCachedInputTokens();
		var agentUsage = new AiModelUsageResponse.AgentUsageSummary(
				agentInputTokens,
				agentOutputTokens,
				agentCachedInputTokens,
				agentInputTokens + agentOutputTokens,
				agentSummary == null ? 0L : agentSummary.getSuccessfulCalls(),
				agentSummary == null ? null : agentSummary.getLastCalledAt(),
				agentModelItems);
		return new AiModelUsageResponse(
				inputTokens,
				outputTokens,
				cachedInputTokens,
				inputTokens + outputTokens,
				summary == null ? 0 : summary.getSuccessfulCalls(),
				summary == null ? null : summary.getLastCalledAt(),
				null,
				"CHAT_API_DOES_NOT_RETURN_ACCOUNT_REMAINING",
				memberUsage == null ? null : memberUsage.allocatedTokens(),
				memberUsage == null ? 0 : memberUsage.usedTokens(),
				memberUsage == null || memberUsage.allocatedTokens() == null
						? null
						: Math.max(0, memberUsage.allocatedTokens() - memberUsage.usedTokens()),
				modelItems,
				memberUsage == null ? null : memberUsage.embeddingAllocatedTokens(),
				memberUsage == null ? 0L : memberUsage.embeddingUsedTokens(),
				memberUsage == null || memberUsage.embeddingAllocatedTokens() == null
						? null
						: Math.max(0, memberUsage.embeddingAllocatedTokens() - memberUsage.embeddingUsedTokens()),
				embeddingTotalTokens,
				embeddingSuccessfulCalls,
				agentUsage);
	}

	private static List<AiModelUsageResponse.ModelUsageItem> toModelUsageItems(
			List<com.yourcompany.salesagent.ai.infrastructure.ModelUsageBreakdownRow> rows) {
		if (rows == null || rows.isEmpty()) {
			return List.of();
		}
		return rows.stream()
				.map(row -> new AiModelUsageResponse.ModelUsageItem(
						row.getProvider(),
						row.getModel(),
						row.getInputTokens(),
						row.getOutputTokens(),
						row.getCachedInputTokens(),
						row.getInputTokens() + row.getOutputTokens(),
						row.getSuccessfulCalls(),
						row.getLastCalledAt()))
				.toList();
	}
}

package com.yourcompany.salesagent.ai.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.yourcompany.salesagent.ai.api.AiModelUpdateRequest;
import com.yourcompany.salesagent.ai.domain.AiModelConfiguration;
import com.yourcompany.salesagent.ai.infrastructure.AiModelConfigurationMapper;
import com.yourcompany.salesagent.ai.infrastructure.AiModelDefaultsProperties;
import com.yourcompany.salesagent.ai.infrastructure.AiOrchestrationClient;
import com.yourcompany.salesagent.ai.infrastructure.MemberTokenUsageRow;
import com.yourcompany.salesagent.ai.infrastructure.ModelCallMapper;
import com.yourcompany.salesagent.ai.infrastructure.ModelUsageBreakdownRow;
import com.yourcompany.salesagent.shared.security.SecretCipher;

class AiModelServiceTests {

	private final Clock clock = Clock.fixed(Instant.parse("2026-08-25T08:00:00Z"), ZoneOffset.UTC);
	private final UUID organizationId = UUID.fromString("00000000-0000-0000-0000-000000000001");

	@Test
	void reportsMissingApiKeyWithoutCallingProvider() {
		var client = mock(AiOrchestrationClient.class);
		var mapper = mock(AiModelConfigurationMapper.class);
		var modelCallMapper = mock(ModelCallMapper.class);
		var cipher = mock(SecretCipher.class);
		var service = new AiModelService(
				client,
				mapper,
				modelCallMapper,
				cipher,
				new AiModelDefaultsProperties("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
				clock);

		var status = service.status(organizationId);

		assertThat(status.provider()).isEqualTo("QWEN");
		assertThat(status.embeddingModel()).isEqualTo("qwen3.7-text-embedding-flash");
		assertThat(status.apiKeyConfigured()).isFalse();
		assertThat(status.ready()).isFalse();
		assertThat(status.agent()).isNotNull();
		assertThat(status.agent().enabled()).isFalse();
		assertThat(status.agent().status()).isEqualTo("INHERIT_DEFAULT");
		assertThatThrownBy(() -> service.testConnection(organizationId)).isInstanceOf(AiModelNotConfiguredException.class);
		assertThatThrownBy(() -> service.testAgentConnection(organizationId)).isInstanceOf(AiModelNotConfiguredException.class);
	}

	@Test
	void returnsSuccessfulConnectionResult() {
		var client = mock(AiOrchestrationClient.class);
		var mapper = mock(AiModelConfigurationMapper.class);
		var modelCallMapper = mock(ModelCallMapper.class);
		var cipher = mock(SecretCipher.class);
		var configuration = AiModelConfiguration.create(
				organizationId,
				"qwen-plus",
				"https://dashscope.aliyuncs.com/compatible-mode/v1",
				"encrypted-key",
				clock.instant());
		when(mapper.selectById(organizationId)).thenReturn(configuration);
		when(cipher.decrypt(organizationId, "encrypted-key")).thenReturn("sk-test");
		when(client.testConnection(any())).thenReturn("连接成功");
		var service = new AiModelService(
				client,
				mapper,
				modelCallMapper,
				cipher,
				new AiModelDefaultsProperties("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
				clock);

		var response = service.testConnection(organizationId);

		assertThat(response.status()).isEqualTo("CONNECTED");
		assertThat(response.responsePreview()).isEqualTo("连接成功");
		assertThat(response.latencyMs()).isZero();
	}

	@Test
	void encryptsApiKeyBeforeSavingConfiguration() {
		var client = mock(AiOrchestrationClient.class);
		var mapper = mock(AiModelConfigurationMapper.class);
		var modelCallMapper = mock(ModelCallMapper.class);
		var cipher = mock(SecretCipher.class);
		when(cipher.encrypt(organizationId, "sk-manual")).thenReturn("v1.encrypted");
		var service = new AiModelService(
				client,
				mapper,
				modelCallMapper,
				cipher,
				new AiModelDefaultsProperties("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
				clock);

		service.update(organizationId, new AiModelUpdateRequest(
				"QWEN",
				"qwen3.7-plus",
				"qwen3.7-text-embedding-flash",
				"https://dashscope.aliyuncs.com/compatible-mode/v1",
				"sk-manual"));

		verify(cipher).encrypt(organizationId, "sk-manual");
		verify(mapper).insert(org.mockito.ArgumentMatchers.argThat((AiModelConfiguration saved) ->
				"qwen3.7-text-embedding-flash".equals(saved.getEmbeddingModel())));
	}

	@Test
	void routesAutonomousAgentToVolcengineAgentPlanWhileKeepingDefaultForMcp() {
		var client = mock(AiOrchestrationClient.class);
		var mapper = mock(AiModelConfigurationMapper.class);
		var modelCallMapper = mock(ModelCallMapper.class);
		var cipher = mock(SecretCipher.class);
		var existing = AiModelConfiguration.create(
				organizationId,
				"QWEN",
				"qwen4-max",
				"qwen3.7-text-embedding-flash",
				"https://dashscope.aliyuncs.com/compatible-mode/v1",
				"enc-qwen",
				clock.instant());
		when(mapper.selectById(organizationId)).thenReturn(existing);
		when(cipher.encrypt(organizationId, "ark-agent-secret")).thenReturn("enc-ark");
		when(cipher.decrypt(organizationId, "enc-qwen")).thenReturn("sk-qwen");
		when(cipher.decrypt(organizationId, "enc-ark")).thenReturn("ark-agent-secret");
		when(client.testConnection(any())).thenReturn("Agent 连接正常");

		var service = new AiModelService(
				client,
				mapper,
				modelCallMapper,
				cipher,
				new AiModelDefaultsProperties("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
				clock);

		var updated = service.update(organizationId, new AiModelUpdateRequest(
				"QWEN",
				"qwen4-max",
				"qwen3.7-text-embedding-flash",
				"https://dashscope.aliyuncs.com/compatible-mode/v1",
				null,
				true,
				"VOLCENGINE_ARK",
				"doubao-seed-2.1-pro",
				"https://ark.cn-beijing.volces.com/api/plan/v3",
				"ark-agent-secret"));

		assertThat(updated.provider()).isEqualTo("QWEN");
		assertThat(updated.agent()).isNotNull();
		assertThat(updated.agent().enabled()).isTrue();
		assertThat(updated.agent().provider()).isEqualTo("VOLCENGINE_ARK");
		assertThat(updated.agent().model()).isEqualTo("doubao-seed-2.1-pro");
		assertThat(updated.agent().ready()).isTrue();

		var mcpConfig = service.requireRuntimeConfiguration(organizationId);
		var agentConfig = service.requireAgentRuntimeConfiguration(organizationId);
		assertThat(mcpConfig.provider()).isEqualTo("QWEN");
		assertThat(mcpConfig.model()).isEqualTo("qwen4-max");
		assertThat(agentConfig.provider()).isEqualTo("VOLCENGINE_ARK");
		assertThat(agentConfig.model()).isEqualTo("doubao-seed-2.1-pro");
		assertThat(agentConfig.baseUrl()).isEqualTo("https://ark.cn-beijing.volces.com/api/plan/v3");
		assertThat(agentConfig.apiKey()).isEqualTo("ark-agent-secret");

		var agentTest = service.testAgentConnection(organizationId);
		assertThat(agentTest.provider()).isEqualTo("VOLCENGINE_ARK");
		assertThat(agentTest.model()).isEqualTo("doubao-seed-2.1-pro");
		assertThat(agentTest.status()).isEqualTo("CONNECTED");
	}

	@Test
	void fallsBackToDefaultModelWhenAgentChannelDisabledAndReturnsPerModelUsage() {
		var client = mock(AiOrchestrationClient.class);
		var mapper = mock(AiModelConfigurationMapper.class);
		var modelCallMapper = mock(ModelCallMapper.class);
		var cipher = mock(SecretCipher.class);
		var existing = AiModelConfiguration.create(
				organizationId,
				"QWEN",
				"qwen4-max",
				"qwen3.7-text-embedding-flash",
				"https://dashscope.aliyuncs.com/compatible-mode/v1",
				"enc-qwen",
				clock.instant());
		existing.updateAgentConfiguration("VOLCENGINE_ARK", "doubao-seed-2.1-pro", "https://ark.cn-beijing.volces.com/api/plan/v3", "enc-ark", clock.instant());
		when(mapper.selectById(organizationId)).thenReturn(existing);
		when(cipher.decrypt(organizationId, "enc-qwen")).thenReturn("sk-qwen");

		var row = new ModelUsageBreakdownRow();
		row.setProvider("VOLCENGINE_ARK");
		row.setModel("doubao-seed-2.1-pro");
		row.setInputTokens(1200);
		row.setOutputTokens(300);
		row.setSuccessfulCalls(2);
		row.setLastCalledAt(clock.instant());
		when(modelCallMapper.selectUsageByModel(organizationId)).thenReturn(List.of(row));

		var service = new AiModelService(
				client,
				mapper,
				modelCallMapper,
				cipher,
				new AiModelDefaultsProperties("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
				clock);

		var updated = service.update(organizationId, new AiModelUpdateRequest(
				"QWEN",
				"qwen4-max",
				"qwen3.7-text-embedding-flash",
				"https://dashscope.aliyuncs.com/compatible-mode/v1",
				null,
				false,
				null,
				null,
				null,
				null));

		assertThat(updated.agent().enabled()).isFalse();
		assertThat(updated.usage().models()).hasSize(1);
		assertThat(updated.usage().models().get(0).totalTokens()).isEqualTo(1500);

		var fallback = service.requireAgentRuntimeConfiguration(organizationId);
		assertThat(fallback.provider()).isEqualTo("QWEN");
		assertThat(fallback.model()).isEqualTo("qwen4-max");
	}

	@Test
	void rejectsMcpUsageWhenMemberHasNoAssignedTokens() {
		var memberId = UUID.randomUUID();
		var modelCallMapper = mock(ModelCallMapper.class);
		when(modelCallMapper.selectMemberTokenUsage(organizationId, memberId))
				.thenReturn(new MemberTokenUsageRow(null, 0));
		var service = new AiModelService(
				mock(AiOrchestrationClient.class),
				mock(AiModelConfigurationMapper.class),
				modelCallMapper,
				mock(SecretCipher.class),
				new AiModelDefaultsProperties("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
				clock);

		assertThatThrownBy(() -> service.requireAvailableTokenQuota(organizationId, memberId))
				.isInstanceOf(TokenQuotaExceededException.class)
				.hasMessageContaining("尚未");
	}

	@Test
	void supportsAgentModelSwitchingWithoutConsumingMcpQuotaAndEnforcesSeparateEmbeddingQuota() {
		var memberId = UUID.randomUUID();
		var client = mock(AiOrchestrationClient.class);
		var mapper = mock(AiModelConfigurationMapper.class);
		var modelCallMapper = mock(ModelCallMapper.class);
		var cipher = mock(SecretCipher.class);
		var existing = AiModelConfiguration.create(
				organizationId,
				"QWEN",
				"qwen4-max",
				"qwen3.7-text-embedding-flash",
				"https://dashscope.aliyuncs.com/compatible-mode/v1",
				"enc-qwen",
				clock.instant());
		existing.updateAgentConfiguration(
				"VOLCENGINE_ARK",
				"doubao-seed-2.1-pro",
				"https://ark.cn-beijing.volces.com/api/plan/v3",
				"enc-ark",
				"doubao-seed-2.1-pro,deepseek-v4-pro,kimi-k3",
				clock.instant());
		when(mapper.selectById(organizationId)).thenReturn(existing);
		when(cipher.decrypt(organizationId, "enc-ark")).thenReturn("ark-secret");
		when(cipher.decrypt(organizationId, "enc-qwen")).thenReturn("qwen-secret");
		// MCP 免费普通额度已耗尽，但向量模型配额独立校验
		when(modelCallMapper.selectMemberTokenUsage(organizationId, memberId))
				.thenReturn(new MemberTokenUsageRow(10_000L, 10_000L, 50_000L, 50_000L, 200_000L));

		var service = new AiModelService(
				client,
				mapper,
				modelCallMapper,
				cipher,
				new AiModelDefaultsProperties("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
				clock);

		var status = service.status(organizationId, memberId);
		assertThat(status.agent().availableModels()).containsExactly("doubao-seed-2.1-pro", "deepseek-v4-pro", "kimi-k3");
		assertThat(status.usage().memberEmbeddingAllocatedTokens()).isEqualTo(50_000L);
		assertThat(status.usage().memberEmbeddingRemainingTokens()).isEqualTo(0L);

		// 切到独立 Agent 通道内的 deepseek-v4-pro，不受 MCP 免费额度耗尽限制
		var resolvedAgent = service.resolveAgentRuntimeConfiguration(organizationId, memberId, "deepseek-v4-pro");
		assertThat(resolvedAgent.independentChannel()).isTrue();
		assertThat(resolvedAgent.configuration().model()).isEqualTo("deepseek-v4-pro");
		assertThat(resolvedAgent.configuration().provider()).isEqualTo("VOLCENGINE_ARK");

		// 切回默认 MCP 模型 qwen4-max 时会校验 MCP 普通对话额度
		assertThatThrownBy(() -> service.resolveAgentRuntimeConfiguration(organizationId, memberId, "qwen4-max"))
				.isInstanceOf(TokenQuotaExceededException.class);

		// 向量模型独立额度耗尽时会触发向量配额异常
		assertThatThrownBy(() -> service.requireAvailableEmbeddingQuota(organizationId, memberId))
				.isInstanceOf(TokenQuotaExceededException.class)
				.hasMessageContaining("向量模型");
	}

	@Test
	void computesOfficialAfpDeductionFormulaAndExposesTieredVolcenginePresets() {
		// 官方示例验证：doubao-seed-evolving，输入 50,000 + 输出 500，系数 2.5 -> 12.625 AFP
		assertThat(AiModelService.estimateAfp("VOLCENGINE_ARK", "doubao-seed-evolving", 50_000L, 500L))
				.isEqualTo(12.625);
		// 极速档 doubao-seed-2.0-mini，系数 0.25 -> (40,000 * 0.25) / 10,000 = 1.0 AFP
		assertThat(AiModelService.estimateAfp("VOLCENGINE_ARK", "doubao-seed-2.0-mini", 40_000L, 0L))
				.isEqualTo(1.0);
		// 旗舰档 kimi-k3.1-pro，系数 7.0 -> (10,000 * 7.0) / 10,000 = 7.0 AFP
		assertThat(AiModelService.estimateAfp("VOLCENGINE_ARK", "kimi-k3.1-pro", 10_000L, 0L))
				.isEqualTo(7.0);
		// 默认列表不含即将下线的 kimi-k3，包含全部 13 个在售文本模型
		assertThat(AiModelService.DEFAULT_VOLCENGINE_AGENT_MODELS)
				.hasSize(13)
				.doesNotContain("kimi-k3")
				.contains("doubao-seed-2.0-mini", "doubao-seed-2.1-lite", "doubao-seed-2.1-pro", "kimi-k3.1-pro", "glm-5.4");
	}

	@Test
	void calibratesExternalAfpBaselineAndAddsSubsequentUsageWithoutDoubleCounting() {
		var mapper = mock(AiModelConfigurationMapper.class);
		var modelCallMapper = mock(ModelCallMapper.class);
		var cipher = mock(SecretCipher.class);
		var existing = AiModelConfiguration.create(
				organizationId,
				"QWEN",
				"qwen4-max",
				"qwen3.7-text-embedding-flash",
				"https://dashscope.aliyuncs.com/compatible-mode/v1",
				"enc-qwen",
				clock.instant());
		when(mapper.selectById(organizationId)).thenReturn(existing);
		when(cipher.decrypt(organizationId, "enc-qwen")).thenReturn("sk-qwen");

		var newCallRow = new ModelUsageBreakdownRow();
		newCallRow.setProvider("VOLCENGINE_ARK");
		newCallRow.setModel("doubao-seed-2.1-pro");
		newCallRow.setInputTokens(10_000);
		newCallRow.setOutputTokens(0);
		newCallRow.setSuccessfulCalls(1);
		when(modelCallMapper.selectAgentUsageByModelSince(organizationId, clock.instant()))
				.thenReturn(List.of(newCallRow));

		var service = new AiModelService(
				mock(AiOrchestrationClient.class),
				mapper,
				modelCallMapper,
				cipher,
				new AiModelDefaultsProperties("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
				clock);

		var calibrated = service.calibrateAgentAfp(
				organizationId,
				null,
				new com.yourcompany.salesagent.ai.api.AiAgentAfpCalibrationRequest(
						new java.math.BigDecimal("95"), null, null));

		assertThat(calibrated.usage().agent().calibratedAt()).isEqualTo(clock.instant());
		// 95 基线 + 10,000 * 2.5 / 10,000 (2.5 AFP) = 97.5 AFP
		assertThat(calibrated.usage().agent().last5HoursAfp()).isEqualTo(97.5);
		assertThat(calibrated.usage().agent().last7DaysAfp()).isEqualTo(97.5);
		assertThat(calibrated.usage().agent().last30DaysAfp()).isEqualTo(97.5);
		assertThat(calibrated.usage().agent().totalEstimatedAfp()).isEqualTo(97.5);
	}
}

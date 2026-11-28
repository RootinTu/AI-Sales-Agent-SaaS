package com.yourcompany.salesagent.ai.domain;

import java.time.Instant;
import java.util.UUID;

import org.springframework.util.StringUtils;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.annotation.Version;

@TableName("ai_model_configuration")
public class AiModelConfiguration {

	@TableId(value = "organization_id", type = IdType.INPUT)
	private UUID organizationId;

	private String provider;

	@TableField("model_name")
	private String modelName;

	@TableField(value = "embedding_model", updateStrategy = FieldStrategy.ALWAYS)
	private String embeddingModel;

	@TableField("base_url")
	private String baseUrl;

	@TableField("encrypted_api_key")
	private String encryptedApiKey;

	@TableField(value = "agent_provider", updateStrategy = FieldStrategy.ALWAYS)
	private String agentProvider;

	@TableField(value = "agent_model_name", updateStrategy = FieldStrategy.ALWAYS)
	private String agentModelName;

	@TableField(value = "agent_base_url", updateStrategy = FieldStrategy.ALWAYS)
	private String agentBaseUrl;

	@TableField(value = "encrypted_agent_api_key", updateStrategy = FieldStrategy.ALWAYS)
	private String encryptedAgentApiKey;

	@TableField(value = "agent_available_models", updateStrategy = FieldStrategy.ALWAYS)
	private String agentAvailableModels;

	@TableField("encryption_version")
	private int encryptionVersion;

	@TableField("created_at")
	private Instant createdAt;

	@TableField("updated_at")
	private Instant updatedAt;

	@Version
	private long version;

	protected AiModelConfiguration() {
	}

	public static AiModelConfiguration create(
			UUID organizationId,
			String modelName,
			String baseUrl,
			String encryptedApiKey,
			Instant now) {
		return create(organizationId, "QWEN", modelName, null, baseUrl, encryptedApiKey, now);
	}

	public static AiModelConfiguration create(
			UUID organizationId,
			String modelName,
			String embeddingModel,
			String baseUrl,
			String encryptedApiKey,
			Instant now) {
		return create(organizationId, "QWEN", modelName, embeddingModel, baseUrl, encryptedApiKey, now);
	}

	public static AiModelConfiguration create(
			UUID organizationId,
			String provider,
			String modelName,
			String embeddingModel,
			String baseUrl,
			String encryptedApiKey,
			Instant now) {
		var configuration = new AiModelConfiguration();
		configuration.organizationId = organizationId;
		configuration.provider = StringUtils.hasText(provider) ? provider.strip() : "QWEN";
		configuration.modelName = modelName;
		configuration.embeddingModel = embeddingModel;
		configuration.baseUrl = baseUrl;
		configuration.encryptedApiKey = encryptedApiKey;
		configuration.encryptionVersion = 1;
		configuration.createdAt = now;
		configuration.updatedAt = now;
		return configuration;
	}

	public void update(String modelName, String baseUrl, String encryptedApiKey, Instant now) {
		update(this.provider, modelName, this.embeddingModel, baseUrl, encryptedApiKey, now);
	}

	public void update(String modelName, String embeddingModel, String baseUrl, String encryptedApiKey, Instant now) {
		update(this.provider, modelName, embeddingModel, baseUrl, encryptedApiKey, now);
	}

	public void update(
			String provider,
			String modelName,
			String embeddingModel,
			String baseUrl,
			String encryptedApiKey,
			Instant now) {
		this.provider = StringUtils.hasText(provider) ? provider.strip() : "QWEN";
		this.modelName = modelName;
		this.embeddingModel = embeddingModel;
		this.baseUrl = baseUrl;
		this.encryptedApiKey = encryptedApiKey;
		this.updatedAt = now;
	}

	public void updateAgentConfiguration(
			String agentProvider,
			String agentModelName,
			String agentBaseUrl,
			String encryptedAgentApiKey,
			Instant now) {
		updateAgentConfiguration(agentProvider, agentModelName, agentBaseUrl, encryptedAgentApiKey, this.agentAvailableModels, now);
	}

	public void updateAgentConfiguration(
			String agentProvider,
			String agentModelName,
			String agentBaseUrl,
			String encryptedAgentApiKey,
			String agentAvailableModels,
			Instant now) {
		this.agentProvider = agentProvider;
		this.agentModelName = agentModelName;
		this.agentBaseUrl = agentBaseUrl;
		this.encryptedAgentApiKey = encryptedAgentApiKey;
		this.agentAvailableModels = agentAvailableModels;
		this.updatedAt = now;
	}

	public void clearAgentConfiguration(Instant now) {
		this.agentProvider = null;
		this.agentModelName = null;
		this.agentBaseUrl = null;
		this.encryptedAgentApiKey = null;
		this.agentAvailableModels = null;
		this.updatedAt = now;
	}

	public boolean hasCustomAgentConfiguration() {
		return StringUtils.hasText(agentModelName)
				&& StringUtils.hasText(agentBaseUrl)
				&& StringUtils.hasText(encryptedAgentApiKey);
	}

	public UUID getOrganizationId() { return organizationId; }
	public String getProvider() { return provider; }
	public String getModelName() { return modelName; }
	public String getEmbeddingModel() { return embeddingModel; }
	public String getBaseUrl() { return baseUrl; }
	public String getEncryptedApiKey() { return encryptedApiKey; }
	public String getAgentProvider() { return agentProvider; }
	public String getAgentModelName() { return agentModelName; }
	public String getAgentBaseUrl() { return agentBaseUrl; }
	public String getEncryptedAgentApiKey() { return encryptedAgentApiKey; }
	public String getAgentAvailableModels() { return agentAvailableModels; }
	public int getEncryptionVersion() { return encryptionVersion; }
	public Instant getCreatedAt() { return createdAt; }
	public Instant getUpdatedAt() { return updatedAt; }
	public long getVersion() { return version; }
}

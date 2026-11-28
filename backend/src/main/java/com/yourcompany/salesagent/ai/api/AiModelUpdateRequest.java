package com.yourcompany.salesagent.ai.api;

import java.util.List;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public record AiModelUpdateRequest(
		@NotBlank @Pattern(regexp = "QWEN|VOLCENGINE_ARK|OPENAI_COMPATIBLE") String provider,
		@NotBlank @Size(max = 120) String model,
		@Size(max = 120) String embeddingModel,
		@NotBlank @Size(max = 500) String baseUrl,
		@Size(max = 500) String apiKey,
		Boolean agentEnabled,
		@Pattern(regexp = "QWEN|VOLCENGINE_ARK|OPENAI_COMPATIBLE") String agentProvider,
		@Size(max = 120) String agentModel,
		@Size(max = 500) String agentBaseUrl,
		@Size(max = 500) String agentApiKey,
		@Size(max = 30) List<@NotBlank @Size(max = 120) String> agentAvailableModels) {

	public AiModelUpdateRequest(String provider, String model, String baseUrl, String apiKey) {
		this(provider, model, null, baseUrl, apiKey, null, null, null, null, null, null);
	}

	public AiModelUpdateRequest(String provider, String model, String embeddingModel, String baseUrl, String apiKey) {
		this(provider, model, embeddingModel, baseUrl, apiKey, null, null, null, null, null, null);
	}

	public AiModelUpdateRequest(
			String provider,
			String model,
			String embeddingModel,
			String baseUrl,
			String apiKey,
			Boolean agentEnabled,
			String agentProvider,
			String agentModel,
			String agentBaseUrl,
			String agentApiKey) {
		this(provider, model, embeddingModel, baseUrl, apiKey, agentEnabled, agentProvider, agentModel, agentBaseUrl, agentApiKey, null);
	}
}

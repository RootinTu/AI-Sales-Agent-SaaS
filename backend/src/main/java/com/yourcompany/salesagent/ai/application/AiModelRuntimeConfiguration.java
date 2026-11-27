package com.yourcompany.salesagent.ai.application;

import com.yourcompany.salesagent.ai.infrastructure.AiModelDefaultsProperties;

public record AiModelRuntimeConfiguration(
		String provider,
		String model,
		String embeddingModel,
		String baseUrl,
		String apiKey) {

	public AiModelRuntimeConfiguration(String provider, String model, String baseUrl, String apiKey) {
		this(provider, model, AiModelDefaultsProperties.DEFAULT_EMBEDDING_MODEL, baseUrl, apiKey);
	}
}


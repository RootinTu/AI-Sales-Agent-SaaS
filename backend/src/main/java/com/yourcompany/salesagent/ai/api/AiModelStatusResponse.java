package com.yourcompany.salesagent.ai.api;

public record AiModelStatusResponse(
		String provider,
		String model,
		String embeddingModel,
		String baseUrl,
		boolean apiKeyConfigured,
		boolean ready,
		String status,
		AiModelUsageResponse usage,
		AiAgentModelStatusResponse agent) {

	public AiModelStatusResponse(
			String provider,
			String model,
			String embeddingModel,
			String baseUrl,
			boolean apiKeyConfigured,
			boolean ready,
			String status,
			AiModelUsageResponse usage) {
		this(provider, model, embeddingModel, baseUrl, apiKeyConfigured, ready, status, usage, null);
	}
}

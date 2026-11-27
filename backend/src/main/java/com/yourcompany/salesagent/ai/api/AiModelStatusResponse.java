package com.yourcompany.salesagent.ai.api;

public record AiModelStatusResponse(
		String provider,
		String model,
		String embeddingModel,
		String baseUrl,
		boolean apiKeyConfigured,
		boolean ready,
		String status,
		AiModelUsageResponse usage) {
}

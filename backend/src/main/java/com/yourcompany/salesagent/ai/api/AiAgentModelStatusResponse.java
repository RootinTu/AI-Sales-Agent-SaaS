package com.yourcompany.salesagent.ai.api;

public record AiAgentModelStatusResponse(
		boolean enabled,
		String provider,
		String model,
		String baseUrl,
		boolean apiKeyConfigured,
		boolean ready,
		String status) {
}

package com.yourcompany.salesagent.ai.api;

import java.util.List;

public record AiAgentModelStatusResponse(
		boolean enabled,
		String provider,
		String model,
		String baseUrl,
		boolean apiKeyConfigured,
		boolean ready,
		String status,
		List<String> availableModels) {

	public AiAgentModelStatusResponse(
			boolean enabled,
			String provider,
			String model,
			String baseUrl,
			boolean apiKeyConfigured,
			boolean ready,
			String status) {
		this(enabled, provider, model, baseUrl, apiKeyConfigured, ready, status, List.of());
	}
}

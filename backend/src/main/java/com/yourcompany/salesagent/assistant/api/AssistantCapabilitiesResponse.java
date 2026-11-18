package com.yourcompany.salesagent.assistant.api;

import java.util.List;

public record AssistantCapabilitiesResponse(
		String planCode,
		boolean svip,
		boolean desktopClient,
		boolean agentModeAvailable,
		String defaultMode,
		List<String> availableModes,
		String unavailableReason,
		List<String> agentCapabilities) {
}

package com.yourcompany.salesagent.assistant.api;

import java.util.List;
import java.util.UUID;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public record AssistantChatRequest(
		UUID conversationId,
		@NotBlank @Size(max = 120_000) String message,
		@Size(max = 10, message = "一次最多携带 10 个附件") List<UUID> attachmentIds,
		@Pattern(regexp = "WEB|DESKTOP", message = "会话来源只能是 WEB 或 DESKTOP") String channel,
		@Pattern(regexp = "LIGHT|AGENT", message = "助手模式只能是 LIGHT 或 AGENT") String mode) {

	public AssistantChatRequest(UUID conversationId, String message, List<UUID> attachmentIds, String channel) {
		this(conversationId, message, attachmentIds, channel, "LIGHT");
	}

	public String resolvedMode() {
		return "AGENT".equalsIgnoreCase(mode) ? "AGENT" : "LIGHT";
	}
}

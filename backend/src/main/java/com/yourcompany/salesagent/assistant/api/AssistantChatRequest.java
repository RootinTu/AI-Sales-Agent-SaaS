package com.yourcompany.salesagent.assistant.api;

import java.util.List;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public record AssistantChatRequest(
		UUID conversationId,
		@NotBlank @Size(max = 120_000) String message,
		@Size(max = 10, message = "一次最多携带 10 个附件") List<UUID> attachmentIds,
		@Pattern(regexp = "WEB|DESKTOP", message = "会话来源只能是 WEB 或 DESKTOP") String channel,
		@Pattern(regexp = "LIGHT|AGENT", message = "助手模式只能是 LIGHT 或 AGENT") String mode,
		@Size(max = 120, message = "模型名称过长") String model,
		@Pattern(regexp = "CLOUD|LOCAL", message = "会话存储方式只能是 CLOUD 或 LOCAL") String storageMode,
		@Size(max = 20, message = "本地上下文消息不能超过 20 条") List<@Valid LocalHistoryMessage> history) {

	public record LocalHistoryMessage(
			@NotBlank @Pattern(regexp = "user|assistant", message = "历史消息角色只能是 user 或 assistant") String role,
			@Size(max = 4000, message = "单条历史上下文过长") String content) {
	}

	public AssistantChatRequest(UUID conversationId, String message, List<UUID> attachmentIds, String channel) {
		this(conversationId, message, attachmentIds, channel, "LIGHT", null, "CLOUD", null);
	}

	public AssistantChatRequest(UUID conversationId, String message, List<UUID> attachmentIds, String channel, String mode) {
		this(conversationId, message, attachmentIds, channel, mode, null, "CLOUD", null);
	}

	public AssistantChatRequest(UUID conversationId, String message, List<UUID> attachmentIds, String channel, String mode, String model) {
		this(conversationId, message, attachmentIds, channel, mode, model, "CLOUD", null);
	}

	public String resolvedMode() {
		return "AGENT".equalsIgnoreCase(mode) ? "AGENT" : "LIGHT";
	}

	public String resolvedStorageMode() {
		return "AGENT".equals(resolvedMode()) && "LOCAL".equalsIgnoreCase(storageMode) ? "LOCAL" : "CLOUD";
	}
}

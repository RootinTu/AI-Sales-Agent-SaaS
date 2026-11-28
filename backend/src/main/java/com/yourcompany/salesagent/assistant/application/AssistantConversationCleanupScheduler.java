package com.yourcompany.salesagent.assistant.application;

import java.time.Clock;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import com.yourcompany.salesagent.assistant.infrastructure.AssistantConversationMapper;

/**
 * 定时物理清除已到期的 MCP 轻辅助（LIGHT）会话（默认保留 7 天，级联清理消息）。
 * 自主 Agent（AGENT）云端会话 expires_at 为 NULL，不受此任务清理。
 */
@Component
public class AssistantConversationCleanupScheduler {

	private static final Logger LOGGER = LoggerFactory.getLogger(AssistantConversationCleanupScheduler.class);

	private final AssistantConversationMapper conversationMapper;
	private final Clock clock;

	public AssistantConversationCleanupScheduler(AssistantConversationMapper conversationMapper, Clock clock) {
		this.conversationMapper = conversationMapper;
		this.clock = clock;
	}

	@Scheduled(
			fixedDelayString = "${app.assistant.cleanup-interval-ms:3600000}",
			initialDelayString = "${app.assistant.cleanup-initial-delay-ms:60000}")
	public void purgeExpiredMcpConversations() {
		try {
			int deleted = conversationMapper.deleteExpiredConversations(clock.instant());
			if (deleted > 0) {
				LOGGER.info("Purged {} expired MCP assistant conversations", deleted);
			}
		}
		catch (RuntimeException exception) {
			LOGGER.warn("Failed to purge expired MCP assistant conversations", exception);
		}
	}
}

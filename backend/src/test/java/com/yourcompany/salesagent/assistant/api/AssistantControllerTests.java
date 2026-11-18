package com.yourcompany.salesagent.assistant.api;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import com.yourcompany.salesagent.assistant.application.AssistantChatService;
import com.yourcompany.salesagent.assistant.application.AssistantStreamTransport;
import com.yourcompany.salesagent.assistant.application.AssistantWorkflowException;
import com.yourcompany.salesagent.auth.security.AuthPrincipal;
import com.yourcompany.salesagent.shared.api.ApiExceptionHandler;

class AssistantControllerTests {

	private AssistantChatService chatService;
	private AssistantStreamTransport streamTransport;
	private MockMvc mvc;
	private AuthPrincipal principal;

	@BeforeEach
	void setup() {
		chatService = mock(AssistantChatService.class);
		streamTransport = mock(AssistantStreamTransport.class);
		mvc = MockMvcBuilders.standaloneSetup(new AssistantChatController(chatService, streamTransport))
				.setControllerAdvice(new ApiExceptionHandler())
				.build();
		var id = UUID.randomUUID();
		principal = new AuthPrincipal(id, id, id, id, "sales@example.com", "陈默", "团队", "SALES", Instant.now().plusSeconds(3600));
	}

	@Test
	void capabilitiesRecognizesDesktopClientHeader() throws Exception {
		when(chatService.capabilities(principal, true)).thenReturn(new AssistantCapabilitiesResponse(
				"STARTER", false, true, true, "LIGHT", List.of("LIGHT", "AGENT"), null, List.of("多步推理")));
		when(chatService.capabilities(principal, false)).thenReturn(new AssistantCapabilitiesResponse(
				"STARTER", false, false, false, "LIGHT", List.of("LIGHT"), "自主 Agent 模式仅开放给桌面客户端和企业 SVIP 用户", List.of()));

		mvc.perform(get("/api/v1/mcp/capabilities").principal(new TestingAuthenticationToken(principal, null)))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.agentModeAvailable").value(false))
				.andExpect(jsonPath("$.desktopClient").value(false));

		mvc.perform(get("/api/v1/mcp/capabilities")
				.header("X-Sales-Agent-Client", "DESKTOP")
				.principal(new TestingAuthenticationToken(principal, null)))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.agentModeAvailable").value(true))
				.andExpect(jsonPath("$.desktopClient").value(true));
	}

	@Test
	void chatRejectsSpoofedDesktopBodyWithoutDesktopClientHeader() throws Exception {
		when(chatService.chat(eq(principal), any(), eq(false)))
				.thenThrow(new AssistantWorkflowException("自主 Agent 模式仅开放给桌面客户端和企业 SVIP 用户"));

		mvc.perform(post("/api/v1/mcp/chat")
				.contentType("application/json")
				.content("{\"message\":\"查客户\",\"channel\":\"DESKTOP\",\"mode\":\"AGENT\"}")
				.principal(new TestingAuthenticationToken(principal, null)))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.detail").value("自主 Agent 模式仅开放给桌面客户端和企业 SVIP 用户"));

		verify(chatService).chat(eq(principal), any(), eq(false));
	}

	@Test
	void chatPassesTrustedDesktopFlagWhenHeaderAndChannelMatch() throws Exception {
		when(chatService.chat(eq(principal), any(), eq(true))).thenReturn(new AssistantChatResponse(
				UUID.randomUUID(), UUID.randomUUID(), "assistant", "已完成", "推理摘要", List.of(), Map.of("assistantMode", "AGENT"), Instant.now()));

		mvc.perform(post("/api/v1/mcp/chat")
				.header("X-Sales-Agent-Client", "DESKTOP")
				.contentType("application/json")
				.content("{\"message\":\"查客户\",\"channel\":\"DESKTOP\",\"mode\":\"AGENT\"}")
				.principal(new TestingAuthenticationToken(principal, null)))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.assistantMode").value("AGENT"));

		verify(chatService).chat(eq(principal), any(), eq(true));
	}
}

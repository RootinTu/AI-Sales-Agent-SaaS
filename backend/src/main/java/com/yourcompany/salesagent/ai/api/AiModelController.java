package com.yourcompany.salesagent.ai.api;

import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.yourcompany.salesagent.ai.application.AiModelService;
import com.yourcompany.salesagent.auth.security.AuthPrincipal;

import jakarta.validation.Valid;

@RestController
@RequestMapping("/api/v1/ai/model")
public class AiModelController {

	private final AiModelService modelService;
	private final UUID demoOrganizationId;

	public AiModelController(
			AiModelService modelService,
			@Value("${app.demo.organization-id}") UUID demoOrganizationId) {
		this.modelService = modelService;
		this.demoOrganizationId = demoOrganizationId;
	}

	@GetMapping
	public AiModelStatusResponse status(Authentication authentication) {
		return authentication != null && authentication.getPrincipal() instanceof AuthPrincipal principal
				? modelService.status(principal.organizationId(), principal.memberId())
				: modelService.status(demoOrganizationId);
	}

	@PutMapping
	public AiModelStatusResponse update(
			Authentication authentication,
			@Valid @RequestBody AiModelUpdateRequest request) {
		return modelService.update(organizationId(authentication), request);
	}

	@PostMapping("/test")
	public AiModelTestResponse testConnection(
			Authentication authentication,
			@RequestParam(defaultValue = "default") String target) {
		var orgId = organizationId(authentication);
		return "agent".equalsIgnoreCase(target)
				? modelService.testAgentConnection(orgId)
				: modelService.testConnection(orgId);
	}

	@PostMapping("/agent/test")
	public AiModelTestResponse testAgentConnection(Authentication authentication) {
		return modelService.testAgentConnection(organizationId(authentication));
	}

	private UUID organizationId(Authentication authentication) {
		return authentication != null && authentication.getPrincipal() instanceof AuthPrincipal principal
				? principal.organizationId()
				: demoOrganizationId;
	}
}

package com.yourcompany.salesagent.assistant.application;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.LocalDate;
import java.util.HexFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.BiConsumer;
import java.util.concurrent.atomic.AtomicReference;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.CollectionUtils;
import org.springframework.util.StringUtils;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.yourcompany.salesagent.agent.api.AgentRunCreateRequest;
import com.yourcompany.salesagent.ai.application.AiModelService;
import com.yourcompany.salesagent.ai.application.AiModelNotConfiguredException;
import com.yourcompany.salesagent.ai.application.ModelCallRecordRequest;
import com.yourcompany.salesagent.ai.application.ModelCallRecorder;
import com.yourcompany.salesagent.ai.application.ModelUsage;
import com.yourcompany.salesagent.ai.infrastructure.AiOrchestrationClient;
import com.yourcompany.salesagent.ai.infrastructure.AiOrchestrationClient.AgentStepPlan;
import com.yourcompany.salesagent.ai.infrastructure.AiOrchestrationClient.AssistantPlan;
import com.yourcompany.salesagent.ai.infrastructure.PythonAiClient.PythonAiException;
import com.yourcompany.salesagent.agent.api.AgentRunResponse;
import com.yourcompany.salesagent.agent.application.SalesFollowUpAgentService;
import com.yourcompany.salesagent.approval.api.ApprovalDecisionRequest;
import com.yourcompany.salesagent.approval.application.ApprovalService;
import com.yourcompany.salesagent.assistant.api.AssistantCapabilitiesResponse;
import com.yourcompany.salesagent.assistant.api.AssistantChatRequest;
import com.yourcompany.salesagent.assistant.api.AssistantChatResponse;
import com.yourcompany.salesagent.assistant.api.AssistantChatResponse.AssistantToolTrace;
import com.yourcompany.salesagent.assistant.api.AssistantConversationResponse;
import com.yourcompany.salesagent.assistant.api.AssistantMessageResponse;
import com.yourcompany.salesagent.assistant.infrastructure.AssistantConversationMapper;
import com.yourcompany.salesagent.assistant.infrastructure.AssistantConversationRow;
import com.yourcompany.salesagent.assistant.infrastructure.AssistantMessageRow;
import com.yourcompany.salesagent.auth.security.AuthPrincipal;
import com.yourcompany.salesagent.commercial.application.QuoteService;
import com.yourcompany.salesagent.customer.api.CustomerResponse;
import com.yourcompany.salesagent.customer.api.CustomerUpsertRequest;
import com.yourcompany.salesagent.customer.application.CustomerService;
import com.yourcompany.salesagent.customer.domain.CustomerSource;
import com.yourcompany.salesagent.customer.domain.CustomerStage;
import com.yourcompany.salesagent.customer.domain.CustomerStatus;
import com.yourcompany.salesagent.file.application.FileStorageException;
import com.yourcompany.salesagent.file.application.FileStorageService;
import com.yourcompany.salesagent.followup.api.FollowUpUpsertRequest;
import com.yourcompany.salesagent.followup.application.FollowUpService;
import com.yourcompany.salesagent.interaction.api.ChatImportRequest;
import com.yourcompany.salesagent.interaction.application.InteractionService;
import com.yourcompany.salesagent.interaction.domain.ChatPlatform;
import com.yourcompany.salesagent.knowledge.application.KnowledgeService;
import com.yourcompany.salesagent.knowledge.api.KnowledgeAnswerResponse;
import com.yourcompany.salesagent.knowledge.api.KnowledgeQueryRequest;
import com.yourcompany.salesagent.mail.application.MailConversationService;
import com.yourcompany.salesagent.opportunity.api.OpportunityUpsertRequest;
import com.yourcompany.salesagent.opportunity.application.OpportunityService;
import com.yourcompany.salesagent.opportunity.domain.ForecastCategory;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

@Service
public class AssistantChatService {

	private static final Logger LOGGER = LoggerFactory.getLogger(AssistantChatService.class);
	private static final int MAX_AGENT_STEPS = 5;
	private static final int HISTORY_LIMIT = 12;
	private static final TypeReference<List<AssistantToolTrace>> TOOL_TRACE_LIST_TYPE = new TypeReference<>() {
	};
	private static final List<Map<String, Object>> ASSISTANT_TOOLS = List.of(
			assistantTool("customer.create", "新增客户和主要联系人。参数键：name、industry、employeeRange、website、contactName、contactEmail、contactPhone", "LOW", List.of("name")),
			assistantTool("interaction.chat_import", "给客户导入聊天记录并运行跟进 Agent。参数键：customerName、chatContent、createCustomer", "LOW", List.of("customerName", "chatContent")),
			assistantTool("email.send.prepare", "校验附件并创建待审批的客户邮件。参数键：customerName、documentType", "HIGH", List.of("customerName", "documentType")),
			assistantTool("approval.list", "查看当前组织的待审批建议", "LOW", List.of()),
			assistantTool("approval.approve", "批准指定审批并执行已批准动作。参数键：approvalId", "HIGH", List.of("approvalId")),
			assistantTool("agent.sales_follow_up.run", "运行客户跟进分析 Agent。参数键：customerName，可省略", "LOW", List.of()),
			assistantTool("follow_up.list", "查看跟进任务", "LOW", List.of()),
			assistantTool("knowledge.query", "查询企业知识库，回答产品、定价、销售方法和流程制度问题，并引用资料。参数键：question", "LOW", List.of("question")));

	private static final List<Map<String, Object>> AGENT_TOOLS = List.of(
			assistantTool("customer.search", "按关键词搜索客户列表，获取匹配客户名称、行业、阶段和联系人。参数键：keyword", "LOW", List.of("keyword")),
			assistantTool("customer.detail", "查询客户全景档案（基本信息、联系人、阶段评分、商机数、开放跟进任务数）。参数键：customerName", "LOW", List.of("customerName")),
			assistantTool("interaction.list", "读取客户最近 10 条聊天、电话、会议或邮件互动记录。参数键：customerName", "LOW", List.of("customerName")),
			assistantTool("opportunity.list", "查询商机列表（阶段、金额、概率、预计成交日期、下一步）。参数键：customerName（可省略以查全部）", "LOW", List.of()),
			assistantTool("opportunity.create", "为已有客户创建新商机。参数键：customerName、name、amount、expectedCloseDate（YYYY-MM-DD 可选）、nextStep（可选）", "MEDIUM", List.of("customerName", "name", "amount")),
			assistantTool("quote.list", "查询客户历史报价单、金额、状态和有效期。参数键：customerName（可省略以查全部）", "LOW", List.of()),
			assistantTool("mail.list", "查询往来邮件记录与未处理来信。参数键：customerName（可省略）", "LOW", List.of()),
			assistantTool("follow_up.list", "查看开放中的客户跟进任务", "LOW", List.of()),
			assistantTool("follow_up.create", "为客户直接创建跟进任务。参数键：customerName、title、reason（可选）、actionType（CALL|EMAIL|MEETING|OTHER，可选）、dueDays（整数天，可选）", "LOW", List.of("customerName", "title")),
			assistantTool("knowledge.query", "查询企业知识库（产品手册、定价折扣、销售方法论、审批制度）。参数键：question", "LOW", List.of("question")),
			assistantTool("customer.create", "新增客户和主要联系人。参数键：name、industry、employeeRange、website、contactName、contactEmail、contactPhone", "LOW", List.of("name")),
			assistantTool("interaction.chat_import", "给客户导入聊天记录并运行跟进 Agent。参数键：customerName、chatContent、createCustomer", "LOW", List.of("customerName", "chatContent")),
			assistantTool("agent.sales_follow_up.run", "对客户运行批量跟进分析 Agent。参数键：customerName（可省略）", "LOW", List.of()),
			assistantTool("email.draft.intelligent", "结合已查阅的客户痛点、商机报价和知识库政策，起草个性化高转化待审批邮件（支持附带本次上传附件，等待人工批准后发送）。参数键：customerName、subject、body、reason（可选）", "HIGH", List.of("customerName", "subject", "body")),
			assistantTool("email.send.prepare", "仅在用户要求直接发送附件方案/合同模板邮件时使用。参数键：customerName、documentType", "HIGH", List.of("customerName", "documentType")),
			assistantTool("approval.list", "查看当前组织的待审批建议", "LOW", List.of()),
			assistantTool("approval.approve", "批准指定审批并执行已批准动作。参数键：approvalId", "HIGH", List.of("approvalId")));

	private final AssistantConversationMapper conversationMapper;
	private final CustomerService customerService;
	private final InteractionService interactionService;
	private final SalesFollowUpAgentService agentService;
	private final ApprovalService approvalService;
	private final FollowUpService followUpService;
	private final ObjectMapper objectMapper;
	private final Clock clock;
	private final AiModelService aiModelService;
	private final AiOrchestrationClient modelClient;
	private final ModelCallRecorder modelCallRecorder;
	private final FileStorageService fileStorageService;
	private final TransactionTemplate transactions;
	private final KnowledgeService knowledgeService;
	private final OpportunityService opportunityService;
	private final QuoteService quoteService;
	private final MailConversationService mailConversationService;

	public AssistantChatService(
			AssistantConversationMapper conversationMapper,
			CustomerService customerService,
			InteractionService interactionService,
			SalesFollowUpAgentService agentService,
			ApprovalService approvalService,
			FollowUpService followUpService,
			ObjectMapper objectMapper,
			Clock clock,
			AiModelService aiModelService,
			AiOrchestrationClient modelClient,
			ModelCallRecorder modelCallRecorder,
			FileStorageService fileStorageService,
			PlatformTransactionManager transactionManager,
			KnowledgeService knowledgeService) {
		this(
				conversationMapper,
				customerService,
				interactionService,
				agentService,
				approvalService,
				followUpService,
				objectMapper,
				clock,
				aiModelService,
				modelClient,
				modelCallRecorder,
				fileStorageService,
				transactionManager,
				knowledgeService,
				null,
				null,
				null);
	}

	@Autowired
	public AssistantChatService(
			AssistantConversationMapper conversationMapper,
			CustomerService customerService,
			InteractionService interactionService,
			SalesFollowUpAgentService agentService,
			ApprovalService approvalService,
			FollowUpService followUpService,
			ObjectMapper objectMapper,
			Clock clock,
			AiModelService aiModelService,
			AiOrchestrationClient modelClient,
			ModelCallRecorder modelCallRecorder,
			FileStorageService fileStorageService,
			PlatformTransactionManager transactionManager,
			KnowledgeService knowledgeService,
			OpportunityService opportunityService,
			QuoteService quoteService,
			MailConversationService mailConversationService) {
		this.conversationMapper = conversationMapper;
		this.customerService = customerService;
		this.interactionService = interactionService;
		this.agentService = agentService;
		this.approvalService = approvalService;
		this.followUpService = followUpService;
		this.objectMapper = objectMapper;
		this.clock = clock;
		this.aiModelService = aiModelService;
		this.modelClient = modelClient;
		this.modelCallRecorder = modelCallRecorder;
		this.fileStorageService = fileStorageService;
		this.transactions = new TransactionTemplate(transactionManager);
		this.knowledgeService = knowledgeService;
		this.opportunityService = opportunityService;
		this.quoteService = quoteService;
		this.mailConversationService = mailConversationService;
	}

	@Transactional(readOnly = true)
	public AssistantCapabilitiesResponse capabilities(AuthPrincipal principal, boolean desktopClient) {
		var rawPlan = conversationMapper.selectOrganizationPlanCode(principal.organizationId());
		var planCode = StringUtils.hasText(rawPlan) ? rawPlan.strip().toUpperCase(java.util.Locale.ROOT) : "STARTER";
		var svip = "SVIP".equals(planCode);
		var available = desktopClient || svip;
		return new AssistantCapabilitiesResponse(
				planCode,
				svip,
				desktopClient,
				available,
				"LIGHT",
				available ? List.of("LIGHT", "AGENT") : List.of("LIGHT"),
				available ? null : "自主 Agent 模式仅开放给桌面客户端和企业 SVIP 用户",
				List.of(
						"多轮对话短期上下文记忆",
						"ReAct 多步自主推理与错误自省",
						"客户/互动/商机/报价/邮件全景检索",
						"Agentic 知识库检索与合规引用",
						"基于上下文智能撰写个性化待审批邮件"));
	}

	/** 在请求线程校验会话并提交用户消息，不让长时间模型请求占住数据库事务。 */
	public UUID beginStream(AuthPrincipal principal, AssistantChatRequest request) {
		return beginStream(principal, request, "DESKTOP".equalsIgnoreCase(request.channel()));
	}

	public UUID beginStream(AuthPrincipal principal, AssistantChatRequest request, boolean desktopClient) {
		requireModeAuthorized(principal, request.resolvedMode(), desktopClient);
		aiModelService.requireAvailableTokenQuota(principal.organizationId(), principal.memberId());
		return transactions.execute(status -> {
			var conversation = resolveConversation(principal, request.conversationId(), request.channel(), request.message().strip());
			var attachments = resolveAttachmentContext(principal, request.attachmentIds());
			conversationMapper.insertMessage(UUID.randomUUID(), principal.organizationId(), conversation.id(),
					"USER", request.message().strip(), null, "[]", attachments.data(), clock.instant());
			return conversation.id();
		});
	}

	public void streamChat(AuthPrincipal principal, UUID conversationId, String message, List<UUID> attachmentIds, BiConsumer<String, Object> events) {
		streamChat(principal, conversationId, message, attachmentIds, "LIGHT", false, events);
	}

	/** 工具完成即发事件；模型增量即发事件；done 仅在最终消息提交后发送。 */
	public void streamChat(AuthPrincipal principal, UUID conversationId, String message, List<UUID> attachmentIds,
			String rawMode, boolean desktopClient, BiConsumer<String, Object> events) {
		var mode = normalizeMode(rawMode);
		requireModeAuthorized(principal, mode, desktopClient);
		var content = new StringBuilder();
		var traces = new ArrayList<AssistantToolTrace>() {
			@Override
			public boolean add(AssistantToolTrace trace) {
				events.accept("tool", trace);
				removeIf(previous -> previous.name().equals(trace.name()) && previous.status().equals("RUNNING"));
				return super.add(trace);
			}
		};
		String summary = "";
		Map<String, Object> data = new LinkedHashMap<>();
		data.put("assistantMode", mode);
		String failure = null;
		try {
			var attachments = resolveAttachmentContext(principal, attachmentIds);
			if (!attachments.isEmpty()) {
				data.putAll(attachments.data());
			}
			var history = "AGENT".equals(mode) ? loadConversationHistory(principal, conversationId, message) : List.<Map<String, Object>>of();
			events.accept("progress", Map.of("text", "AGENT".equals(mode)
					? "自主 Agent 已启动：正在结合上下文记忆规划多步检索与执行…"
					: "正在识别业务指令并执行工具；分析客户时需要等待模型返回。"));
			var result = "AGENT".equals(mode)
					? routeAgent(principal, conversationId, message.strip(), traces, attachments, history, events)
					: route(principal, conversationId, message.strip(), traces, attachments);
			summary = result.reasoningSummary();
			data.putAll(result.data());
			data.put("assistantMode", mode);
			events.accept("summary", Map.of("text", summary));
			events.accept("result", result);
			boolean singleKnowledgeOnly = result.data().containsKey("knowledgeSources")
					&& !result.data().containsKey("agentMultiStep");
			if ("HELP".equals(result.data().get("intent")) || singleKnowledgeOnly) {
				events.accept("progress", Map.of("text", result.data().containsKey("knowledgeSources") ? "知识库检索已完成。" : "已返回助手支持的业务能力。"));
				content.append(result.content());
				events.accept("delta", Map.of("text", result.content()));
			}
			else try {
				var configuration = aiModelService.requireRuntimeConfiguration(principal.organizationId(), principal.memberId());
				var verifiedResult = objectMapper.writeValueAsString(result);
				var startedAt = clock.instant();
				var streamUsage = new AtomicReference<ModelUsage>();
				var providerRequestId = new AtomicReference<String>();
				var responseModel = new AtomicReference<String>();
				events.accept("progress", Map.of("text", "业务执行已结束，模型正在生成回答。"));
				var replyFlux = "AGENT".equals(mode)
						? modelClient.streamAssistantReplyWithUsage(configuration, message, verifiedResult, mode, history)
						: modelClient.streamAssistantReplyWithUsage(configuration, message, verifiedResult);
				replyFlux
						.timeout(Duration.ofSeconds(60))
						.doOnNext(chunk -> {
							if (chunk.usage() != null) streamUsage.set(chunk.usage());
							if (StringUtils.hasText(chunk.providerRequestId())) providerRequestId.set(chunk.providerRequestId());
							if (StringUtils.hasText(chunk.model())) responseModel.set(chunk.model());
							if (StringUtils.hasText(chunk.text())) {
								content.append(chunk.text());
								events.accept("delta", Map.of("text", chunk.text()));
							}
						}).blockLast(Duration.ofMinutes(2));
				if (content.isEmpty()) throw new IllegalStateException("Empty model response");
				var completedAt = clock.instant();
				var usage = streamUsage.get();
				if (usage != null) {
					data.put("modelUsage", usageSnapshot(usage));
				}
				recordAssistantModelCall(
						principal,
						configuration.model(),
						responseModel.get(),
						providerRequestId.get(),
						usage,
						startedAt,
						completedAt,
						message,
						verifiedResult,
						content.toString());
			}
			catch (AiModelNotConfiguredException exception) {
				// 没有模型时仍支持业务工具，明确返回原始结果，不模拟打字效果。
				events.accept("progress", Map.of("text", "未配置模型，直接展示业务结果。"));
				content.append(result.content());
				events.accept("delta", Map.of("text", result.content()));
			}
			catch (RuntimeException exception) {
				failure = "模型回答生成中断，业务操作不会重试。请以工具结果为准。";
				var fallback = "\n\n" + failure + "\n" + result.content();
				content.append(fallback);
				events.accept("delta", Map.of("text", fallback));
			}
		}
		catch (RuntimeException exception) {
			var unfinished = traces.stream().filter(trace -> trace.status().equals("RUNNING")).toList();
			unfinished.forEach(trace -> traces.add(new AssistantToolTrace(trace.name(), "FAILED", "执行未完成，请核对业务记录")));
			failure = exception instanceof AssistantWorkflowException ? exception.getMessage()
					: "业务执行未完成，请检查客户、审批或运行记录后再决定是否重试。";
			content.append(failure);
			events.accept("delta", Map.of("text", failure));
		}
		data.put("streamStatus", failure == null ? "COMPLETED" : "INTERRUPTED");
		var response = new AssistantChatResponse(conversationId, UUID.randomUUID(), "assistant", content.toString(),
				summary, List.copyOf(traces), data, clock.instant());
		transactions.executeWithoutResult(status -> {
			conversationMapper.insertMessage(response.messageId(), principal.organizationId(), conversationId,
					"ASSISTANT", response.content(), response.reasoningSummary(), toJson(response.toolTraces()), data, response.createdAt());
			conversationMapper.touchConversation(principal.organizationId(), conversationId, response.createdAt());
		});
		if (failure != null) events.accept("error", Map.of("message", failure));
		events.accept("done", response);
	}

	@Transactional
	public AssistantChatResponse chat(AuthPrincipal principal, AssistantChatRequest request) {
		return chat(principal, request, "DESKTOP".equalsIgnoreCase(request.channel()));
	}

	@Transactional
	public AssistantChatResponse chat(AuthPrincipal principal, AssistantChatRequest request, boolean desktopClient) {
		var mode = normalizeMode(request.resolvedMode());
		requireModeAuthorized(principal, mode, desktopClient);
		aiModelService.requireAvailableTokenQuota(principal.organizationId(), principal.memberId());
		var rawMessage = request.message();
		var message = rawMessage == null ? "" : rawMessage.strip();
		if (!StringUtils.hasText(message)) {
			throw new AssistantWorkflowException("请输入要自动化处理的业务指令");
		}
		var conversation = resolveConversation(principal, request.conversationId(), request.channel(), message);
		var attachments = resolveAttachmentContext(principal, request.attachmentIds());
		var userMessageTime = clock.instant();
		conversationMapper.insertMessage(
				UUID.randomUUID(),
				principal.organizationId(),
				conversation.id(),
				"USER",
				message,
				null,
				"[]",
				attachments.data(),
				userMessageTime);

		var history = "AGENT".equals(mode) ? loadConversationHistory(principal, conversation.id(), message) : List.<Map<String, Object>>of();
		var response = "AGENT".equals(mode)
				? routeAgent(principal, conversation.id(), message, new ArrayList<>(), attachments, history, (event, payload) -> {})
				: route(principal, conversation.id(), message, attachments);
		var data = new LinkedHashMap<>(response.data());
		data.put("assistantMode", mode);
		var assistantMessageId = UUID.randomUUID();
		conversationMapper.insertMessage(
				assistantMessageId,
				principal.organizationId(),
				conversation.id(),
				"ASSISTANT",
				response.content(),
				response.reasoningSummary(),
				toJson(response.toolTraces()),
				data,
				response.createdAt());
		conversationMapper.touchConversation(principal.organizationId(), conversation.id(), response.createdAt());
		return new AssistantChatResponse(
				conversation.id(),
				assistantMessageId,
				response.role(),
				response.content(),
				response.reasoningSummary(),
				response.toolTraces(),
				data,
				response.createdAt());
	}

	@Transactional(readOnly = true)
	public IPage<AssistantConversationResponse> findConversations(AuthPrincipal principal, int page, int size) {
		var conversations = conversationMapper.selectConversations(
				Page.of(page + 1L, size),
				principal.organizationId(),
				principal.memberId());
		var records = conversations.getRecords().stream().map(this::toConversationResponse).toList();
		return new Page<AssistantConversationResponse>(conversations.getCurrent(), conversations.getSize(), conversations.getTotal())
				.setRecords(records);
	}

	@Transactional(readOnly = true)
	public IPage<AssistantMessageResponse> findMessages(AuthPrincipal principal, UUID conversationId, int page, int size) {
		ensureConversation(principal, conversationId);
		var messages = conversationMapper.selectMessages(
				Page.of(page + 1L, size),
				principal.organizationId(),
				conversationId);
		var records = messages.getRecords().stream().map(this::toMessageResponse).toList();
		return new Page<AssistantMessageResponse>(messages.getCurrent(), messages.getSize(), messages.getTotal())
				.setRecords(records);
	}

	private AssistantChatResponse route(AuthPrincipal principal, String message) {
		return route(principal, null, message, new ArrayList<>(), AttachmentContext.empty());
	}

	private AssistantChatResponse route(AuthPrincipal principal, UUID conversationId, String message) {
		return route(principal, conversationId, message, new ArrayList<>(), AttachmentContext.empty());
	}

	private AssistantChatResponse route(AuthPrincipal principal, UUID conversationId, String message, AttachmentContext attachments) {
		return route(principal, conversationId, message, new ArrayList<>(), attachments);
	}

	private AssistantChatResponse route(AuthPrincipal principal, UUID conversationId, String message, List<AssistantToolTrace> traces, AttachmentContext attachments) {
		if (isHelpRequest(message)) {
			return help(traces);
		}
		com.yourcompany.salesagent.ai.application.AiModelRuntimeConfiguration configuration;
		try {
			configuration = aiModelService.requireRuntimeConfiguration(principal.organizationId(), principal.memberId());
		}
		catch (AiModelNotConfiguredException exception) {
			throw new AssistantWorkflowException("请先在设置中配置并启用 AI 模型，再使用 AI 助手。");
		}
		var context = new LinkedHashMap<String, Object>();
		context.put("attachmentCount", attachments.ids().size());
		context.put("attachments", attachments.preview());
		var startedAt = clock.instant();
		AssistantPlan plan;
		try {
			plan = modelClient.planAssistantAction(configuration, message, context, ASSISTANT_TOOLS);
		}
		catch (PythonAiException exception) {
			LOGGER.warn("FastAPI assistant planning request failed", exception);
			throw new AssistantWorkflowException(
					"AI 规划服务暂时不可用，请联系管理员检查 AI 服务地址和内部令牌配置。", exception);
		}
		var completedAt = clock.instant();
		recordPlannerModelCall(principal, configuration.model(), plan, startedAt, completedAt, message);
		traces.add(new AssistantToolTrace("assistant.langgraph.plan", "SUCCEEDED",
				"已识别意图：" + plan.intent() + (StringUtils.hasText(plan.toolName()) ? "，候选工具：" + plan.toolName() : "")));

		if (!plan.validationErrors().isEmpty()) {
			return reply(
					StringUtils.hasText(plan.response()) ? plan.response() : "还缺少执行所需的信息，请补充后重试。",
					"LangGraph 已生成候选计划，但 Java 执行前校验未通过：" + String.join("；", plan.validationErrors()),
					traces,
					planData(plan));
		}

		var arguments = plan.arguments();
		var toolName = plan.toolName() == null ? "" : plan.toolName();
		if ("KNOWLEDGE_QUERY".equals(plan.intent()) && toolName.isBlank()) toolName = "knowledge.query";
		AssistantChatResponse result = switch (toolName) {
			case "customer.create" -> createCustomer(principal, customerDraft(arguments), traces);
			case "interaction.chat_import" -> importChatAndRunAgent(
					principal, conversationId, importCommand(arguments), traces, attachments);
			case "email.send.prepare" -> proposeDocumentEmail(
					principal, conversationId, documentSendCommand(arguments), traces, attachments);
			case "approval.list" -> listPendingApprovals(principal, traces);
			case "approval.approve" -> approvePlanned(principal, message, stringArgument(arguments, "approvalId"), traces);
			case "agent.sales_follow_up.run" -> runAgent(
					principal, conversationId, stringArgument(arguments, "customerName"), traces, attachments);
			case "follow_up.list" -> listFollowUps(principal, traces);
			case "knowledge.query" -> queryKnowledge(principal, stringArgument(arguments, "question"), message, traces);
			case "" -> reply(
					StringUtils.hasText(plan.response()) ? plan.response() : "请补充你希望完成的销售工作。",
					"LangGraph 将本次请求识别为 " + plan.intent() + "，未提出业务工具调用。",
					traces,
					planData(plan));
			default -> throw new AssistantWorkflowException("AI 计划引用了未授权工具，已阻止执行: " + plan.toolName());
		};
		var resultData = new LinkedHashMap<>(result.data());
		resultData.putAll(planData(plan));
		return new AssistantChatResponse(result.conversationId(), result.messageId(), result.role(), result.content(),
				result.reasoningSummary(), result.toolTraces(), resultData, result.createdAt());
	}

	private AssistantChatResponse routeAgent(
			AuthPrincipal principal,
			UUID conversationId,
			String message,
			List<AssistantToolTrace> traces,
			AttachmentContext attachments,
			List<Map<String, Object>> history,
			BiConsumer<String, Object> events) {
		if (isHelpRequest(message)) {
			return agentHelp(traces);
		}
		com.yourcompany.salesagent.ai.application.AiModelRuntimeConfiguration configuration;
		try {
			configuration = aiModelService.requireRuntimeConfiguration(principal.organizationId(), principal.memberId());
		}
		catch (AiModelNotConfiguredException exception) {
			throw new AssistantWorkflowException("请先在设置中配置并启用 AI 模型，再使用自主 Agent 模式。");
		}

		var context = new LinkedHashMap<String, Object>();
		context.put("attachmentCount", attachments.ids().size());
		context.put("attachments", attachments.preview());
		context.put("memberName", principal.displayName());
		context.put("memberRole", principal.role());

		var observations = new ArrayList<Map<String, Object>>();
		var agentSteps = new ArrayList<Map<String, Object>>();
		var accumulatedData = new LinkedHashMap<String, Object>();
		var knowledgeSources = new ArrayList<KnowledgeAnswerResponse.Source>();
		var collectedApprovals = new ArrayList<Map<String, Object>>();
		AgentStepPlan lastPlan = null;
		String finalContent = "";

		for (int step = 1; step <= MAX_AGENT_STEPS; step++) {
			var startedAt = clock.instant();
			AgentStepPlan plan;
			try {
				plan = modelClient.planAgentStep(
						configuration, message, "AGENT", context, AGENT_TOOLS, history, observations);
			}
			catch (PythonAiException exception) {
				LOGGER.warn("FastAPI autonomous agent planning request failed at step {}", step, exception);
				throw new AssistantWorkflowException(
						"自主 Agent 规划服务暂时不可用，请联系管理员检查 AI 服务地址和内部令牌配置。", exception);
			}
			lastPlan = plan;
			recordAgentStepModelCall(principal, configuration.model(), plan, startedAt, clock.instant(), message, step);

			if (StringUtils.hasText(plan.thought())) {
				events.accept("progress", Map.of("text", "第 " + step + " 步思考：" + plan.thought()));
				traces.add(new AssistantToolTrace("assistant.agent.step", "SUCCEEDED", "第 " + step + " 步：" + plan.thought()));
				agentSteps.add(compactMap("step", step, "thought", plan.thought(), "intent", plan.intent(), "tool", plan.toolName()));
			}
			else if (step == 1) {
				traces.add(new AssistantToolTrace("assistant.langgraph.plan", "SUCCEEDED",
						"已识别意图：" + plan.intent() + (StringUtils.hasText(plan.toolName()) ? "，候选工具：" + plan.toolName() : "")));
			}

			if (!plan.validationErrors().isEmpty()) {
				var errorSummary = String.join("；", plan.validationErrors());
				if (step < MAX_AGENT_STEPS) {
					observations.add(agentObservation(step, plan.toolName(), plan.arguments(), "FAILED", errorSummary, Map.of("error", errorSummary)));
					continue;
				}
				finalContent = StringUtils.hasText(plan.response()) ? plan.response() : "还缺少执行所需的信息：" + errorSummary;
				break;
			}

			var toolName = plan.toolName() == null ? "" : plan.toolName();
			if ("KNOWLEDGE_QUERY".equals(plan.intent()) && toolName.isBlank()) {
				toolName = "knowledge.query";
			}
			if (toolName.isBlank() || "ANSWER".equals(plan.intent()) || "CLARIFY".equals(plan.intent())) {
				finalContent = StringUtils.hasText(plan.response())
						? plan.response()
						: observations.isEmpty() ? "请补充你希望完成的销售工作。" : "已完成多步检索与处理。";
				break;
			}

			var arguments = plan.arguments() == null ? Map.<String, Object>of() : plan.arguments();
			if (observations.size() > 0 && isDuplicateToolCall(observations, toolName, arguments)) {
				finalContent = StringUtils.hasText(plan.response()) ? plan.response() : "已完成多步核查与分析。";
				break;
			}

			traces.add(new AssistantToolTrace(toolName, "RUNNING", "正在执行 " + toolName));
			AgentToolOutcome outcome;
			try {
				outcome = executeAgentTool(principal, conversationId, message, toolName, arguments, attachments, traces);
				traces.add(new AssistantToolTrace(toolName, "SUCCEEDED", outcome.summary()));
				observations.add(agentObservation(step, toolName, arguments, "SUCCEEDED", outcome.summary(), outcome.output()));
				if (!outcome.extraData().isEmpty()) {
					accumulatedData.putAll(outcome.extraData());
					appendApprovals(collectedApprovals, outcome.extraData());
					appendKnowledgeSources(knowledgeSources, outcome.extraData());
				}
				if (outcome.terminalAfterSuccess()) {
					finalContent = outcome.summary();
					break;
				}
			}
			catch (RuntimeException exception) {
				var errorMessage = StringUtils.hasText(exception.getMessage()) ? exception.getMessage() : "工具执行失败";
				traces.add(new AssistantToolTrace(toolName, "FAILED", errorMessage));
				observations.add(agentObservation(step, toolName, arguments, "FAILED", errorMessage, Map.of("error", errorMessage)));
				if (step == MAX_AGENT_STEPS) {
					finalContent = "第 " + step + " 步执行「" + toolName + "」未完成：" + errorMessage;
				}
			}
		}

		if (lastPlan != null) {
			accumulatedData.putAll(agentPlanData(lastPlan));
		}
		if (!agentSteps.isEmpty()) {
			accumulatedData.put("agentSteps", agentSteps);
		}
		if (!observations.isEmpty()) {
			accumulatedData.put("agentMultiStep", true);
			accumulatedData.put("observationCount", observations.size());
			accumulatedData.put("observations", observations);
		}
		if (!collectedApprovals.isEmpty()) {
			accumulatedData.put("approvals", collectedApprovals);
		}
		if (!knowledgeSources.isEmpty()) {
			accumulatedData.put("knowledgeSources", knowledgeSources);
		}
		if (!StringUtils.hasText(finalContent)) {
			finalContent = observations.isEmpty() ? "请补充你希望完成的销售工作。" : "自主 Agent 已完成多步执行。";
		}
		var reasoningSummary = buildAgentReasoningSummary(agentSteps, observations, lastPlan);
		return reply(finalContent, reasoningSummary, traces, accumulatedData);
	}

	private AgentToolOutcome executeAgentTool(
			AuthPrincipal principal,
			UUID conversationId,
			String originalMessage,
			String toolName,
			Map<String, Object> arguments,
			AttachmentContext attachments,
			List<AssistantToolTrace> traces) {
		return switch (toolName) {
			case "customer.search" -> toolSearchCustomers(principal, stringArgument(arguments, "keyword"));
			case "customer.detail" -> toolCustomerDetail(principal, stringArgument(arguments, "customerName"));
			case "interaction.list" -> toolListInteractions(principal, stringArgument(arguments, "customerName"));
			case "opportunity.list" -> toolListOpportunities(principal, stringArgument(arguments, "customerName"));
			case "opportunity.create" -> toolCreateOpportunity(principal, arguments);
			case "quote.list" -> toolListQuotes(principal, stringArgument(arguments, "customerName"));
			case "mail.list" -> toolListMail(principal, stringArgument(arguments, "customerName"));
			case "follow_up.list" -> fromChatResponse(listFollowUps(principal, new ArrayList<>()), false);
			case "follow_up.create" -> toolCreateFollowUp(principal, arguments);
			case "knowledge.query" -> toolQueryKnowledge(principal, stringArgument(arguments, "question"), originalMessage);
			case "customer.create" -> fromChatResponse(createCustomer(principal, customerDraft(arguments), new ArrayList<>()), false);
			case "interaction.chat_import" -> fromChatResponse(
					importChatAndRunAgent(principal, conversationId, importCommand(arguments), new ArrayList<>(), attachments), true);
			case "agent.sales_follow_up.run" -> fromChatResponse(
					runAgent(principal, conversationId, stringArgument(arguments, "customerName"), new ArrayList<>(), attachments), true);
			case "email.draft.intelligent" -> toolDraftIntelligentEmail(principal, conversationId, arguments, attachments);
			case "email.send.prepare" -> toolPrepareDocumentEmail(principal, conversationId, documentSendCommand(arguments), attachments);
			case "approval.list" -> fromChatResponse(listPendingApprovals(principal, new ArrayList<>()), false);
			case "approval.approve" -> toolApprovePlanned(principal, originalMessage, stringArgument(arguments, "approvalId"));
			default -> throw new AssistantWorkflowException("自主 Agent 引用了未授权工具：" + toolName);
		};
	}

	private AssistantChatResponse queryKnowledge(AuthPrincipal principal, String question, String message, List<AssistantToolTrace> traces) {
		traces.add(new AssistantToolTrace("knowledge.query", "RUNNING", "正在检索当前可访问的企业资料"));
		var answer = knowledgeService.ask(principal, new KnowledgeQueryRequest(StringUtils.hasText(question) ? question : message, null));
		traces.add(new AssistantToolTrace("knowledge.query", "SUCCEEDED", "引用 " + answer.sources().size() + " 个知识片段"));
		var data = new LinkedHashMap<String, Object>();
		data.put("knowledgeSources", answer.sources());
		if (answer.usage() != null) data.put("modelUsage", usageSnapshot(answer.usage()));
		return reply(answer.content(), "检索企业知识库并根据资料回答。", traces, data);
	}

	private AssistantChatResponse proposeDocumentEmail(AuthPrincipal principal, UUID conversationId, DocumentSendCommand command,
			List<AssistantToolTrace> traces, AttachmentContext attachments) {
		if (command == null || !StringUtils.hasText(command.customerName())) {
			return reply("我还缺准确的客户名称。可以这样发：给和成科技发送方案。",
					"识别为文件邮件发送意图，但未解析到客户名称，因此没有创建发送审批。", traces,
					Map.of("intent", "SEND_DOCUMENT_EMAIL"));
		}
		if (attachments.isEmpty()) {
			traces.add(new AssistantToolTrace("email.send.prepare", "FAILED", "发送" + command.documentType() + "需要先选择附件"));
			return reply(
					"发送" + command.documentType() + "需要带上文件。请先点击输入框旁的附件按钮选择方案文件，再发送同一句指令；文件会在你点击发送后上传，不会在选择时提前上传。",
					"识别到给客户发送文件的意图，但本次消息没有附件。为避免发错或漏发文件，未创建审批，也未发送邮件。",
					traces,
					Map.of("intent", "SEND_DOCUMENT_EMAIL", "customerName", command.customerName(), "attachmentRequired", true));
		}

		var customer = resolveCustomer(principal, command.customerName());
		traces.add(new AssistantToolTrace("customer.search", "SUCCEEDED", "已匹配客户：" + customer.name()));
		traces.add(new AssistantToolTrace("email.send.prepare", "RUNNING", "正在生成带附件的邮件发送审批"));
		var proposal = agentService.proposeDocumentEmailFromMcpAssistant(
				principal, customer, conversationId, command.documentType(), attachments.ids());
		traces.add(new AssistantToolTrace("email.send.prepare", "SUCCEEDED", "已生成待审批邮件：" + proposal.approvalId()));
		return reply(
				"已为客户「" + customer.name() + "」生成一封带 " + attachments.ids().size() + " 个附件的"
						+ command.documentType() + "邮件，当前尚未发送。请在审批中心核对收件人、主题、正文和附件，审批通过后系统才会发送。",
				"识别文件发送指令 → 校验客户与附件 → 生成邮件预览 → 创建高风险待审批动作；未直接发送邮件。",
				traces,
				Map.of(
						"customerId", customer.id(),
						"customerName", customer.name(),
						"agentRunId", proposal.runId(),
						"approvalId", proposal.approvalId(),
						"to", proposal.to(),
						"subject", proposal.subject(),
						"attachments", attachments.preview()));
	}

	private AssistantChatResponse importChatAndRunAgent(AuthPrincipal principal, UUID conversationId, ImportCommand command, List<AssistantToolTrace> traces, AttachmentContext attachments) {
		if (command == null || !StringUtils.hasText(command.customerName()) || !StringUtils.hasText(command.content())) {
			return reply("我还缺客户名或聊天内容。可以这样发：\n\n给云岚科技导入聊天：客户说下周想看报价，需要私有化方案。", "识别为聊天导入意图，但缺少客户名或聊天正文，因此没有调用业务写入工具。", traces, Map.of("intent", "CHAT_IMPORT"));
		}
		var customer = resolveOrCreateCustomer(principal, command.customerName(), command.createCustomer(), traces);
		traces.add(new AssistantToolTrace("interaction.chat_import", "RUNNING", "正在保存聊天记录"));
		var interaction = interactionService.importChat(
				principal, customer.id(),
				new ChatImportRequest(ChatPlatform.OTHER, clock.instant(), "MCP 助手导入聊天", command.content().strip(), null));
		traces.add(new AssistantToolTrace("interaction.chat_import", "SUCCEEDED", "已导入聊天记录：" + interaction.id()));
		traces.add(new AssistantToolTrace("agent.sales_follow_up.run", "RUNNING", "正在分析客户并生成待审批建议"));
		var run = agentService.runFromMcpAssistant(principal, new AgentRunCreateRequest(5, 30, List.of(customer.id())), conversationId, attachments.ids());
		var approvals = pendingApprovalsForRun(principal, run.id());
		traces.add(new AssistantToolTrace("agent.sales_follow_up.run", "SUCCEEDED", "已触发客户跟进建议 Agent：" + run.id()));
		return reply(
				"已完成自动化处理：我先找到客户「" + customer.name() + "」，导入聊天记录，然后只针对这个客户跑了一次跟进建议 Agent。"
						+ nextRunHint(run) + attachmentHint(attachments),
				"识别聊天导入指令 → 匹配或创建客户 → 写入互动记录 → 触发客户跟进建议 Agent → 返回待审批数量。",
				traces,
				Map.of(
						"customerId", customer.id(),
						"interactionId", interaction.id(),
						"agentRunId", run.id(),
						"agentRunStatus", run.status(),
						"pendingApprovalCount", run.pendingApprovalCount(),
						"approvals", approvals,
						"attachments", attachments.preview()));
	}

	private AssistantChatResponse runAgent(AuthPrincipal principal, UUID conversationId, String customerName, List<AssistantToolTrace> traces, AttachmentContext attachments) {
		traces.add(new AssistantToolTrace("agent.sales_follow_up.run", "RUNNING", "正在读取互动并调用模型分析客户"));
		AgentRunResponse run;
		if (StringUtils.hasText(customerName)) {
			var customer = resolveCustomer(principal, customerName);
			traces.add(new AssistantToolTrace("customer.search", "SUCCEEDED", "已匹配客户：" + customer.name()));
			run = agentService.runFromMcpAssistant(principal, new AgentRunCreateRequest(5, 30, List.of(customer.id())), conversationId, attachments.ids());
		}
		else {
			if (!attachments.isEmpty()) {
				return reply("我已收到附件，但为了避免把文件带给错误客户，请在指令里写清楚客户名，例如：运行 Agent 分析云岚科技。",
						"识别到 Agent 运行意图和附件，但未指定客户；附件类动作必须绑定明确客户，未执行 Agent。",
						traces,
						attachments.data());
			}
			run = agentService.runFromMcpAssistant(principal, new AgentRunCreateRequest(5, 30, null), conversationId);
		}
		traces.add(new AssistantToolTrace("agent.sales_follow_up.run", "SUCCEEDED", "已触发客户跟进建议 Agent：" + run.id()));
		var approvals = pendingApprovalsForRun(principal, run.id());
		return reply("Agent 已运行完成。" + nextRunHint(run) + attachmentHint(attachments), "识别 Agent 运行指令 → 判断是否指定客户 → 触发客户跟进建议 Agent → 汇总运行结果。", traces, Map.of(
				"agentRunId", run.id(),
				"agentRunStatus", run.status(),
				"processedCount", run.processedCount(),
				"pendingApprovalCount", run.pendingApprovalCount(),
				"approvals", approvals,
				"attachments", attachments.preview()));
	}

	private List<Map<String, Object>> pendingApprovalsForRun(AuthPrincipal principal, UUID runId) {
		return approvalService.findApprovals(principal, "PENDING", 0, 50).getRecords().stream()
				.filter(approval -> runId.equals(approval.runId()))
				.map(approval -> compactMap(
						"id", approval.id(),
						"customerName", approval.customerName(),
						"actionType", approval.actionType(),
						"riskLevel", approval.riskLevel(),
						"version", approval.version()))
				.toList();
	}

	private AssistantChatResponse createCustomer(AuthPrincipal principal, CustomerDraft draft, List<AssistantToolTrace> traces) {
		if (!StringUtils.hasText(draft.name())) {
			return reply("我还缺客户名称。可以这样发：\n\n新增客户：沐光医疗，行业：医疗科技，联系人：苏恬，电话：13800000007，邮箱：su@example.com", "识别为新增客户意图，但缺少客户名称，因此没有创建客户。", traces, Map.of("intent", "CUSTOMER_CREATE"));
		}
		traces.add(new AssistantToolTrace("customer.create", "RUNNING", "正在创建客户档案"));
		var customer = createCustomerFromDraft(principal, draft);
		traces.add(new AssistantToolTrace("customer.create", "SUCCEEDED", "已新增客户：" + customer.name()));
		return reply("客户「" + customer.name() + "」已经创建完成。你可以继续说：给" + customer.name() + "导入聊天：……，我会自动导入并运行 Agent。", "识别新增客户指令 → 抽取客户名称、行业和联系人字段 → 创建客户主档和主要联系人。", traces, Map.of(
				"customerId", customer.id(),
				"customerName", customer.name()));
	}

	private AssistantChatResponse listPendingApprovals(AuthPrincipal principal, List<AssistantToolTrace> traces) {
		traces.add(new AssistantToolTrace("approval.list", "RUNNING", "正在查询待审批建议"));
		var page = approvalService.findApprovals(principal, "PENDING", 0, 10);
		traces.add(new AssistantToolTrace("approval.list", "SUCCEEDED", "读取待审批建议 " + page.getTotal() + " 条"));
		var approvals = page.getRecords().stream()
				.map(approval -> compactMap(
						"id", approval.id(),
						"customerName", approval.customerName(),
						"actionType", approval.actionType(),
						"riskLevel", approval.riskLevel(),
						"version", approval.version(),
						"reason", approval.reason()))
				.toList();
		var content = approvals.isEmpty()
				? "现在没有待审批建议。"
				: "当前有 " + page.getTotal() + " 条待审批建议。你可以去审批中心处理，也可以输入：批准 <审批ID>。";
		return reply(content, "识别查询审批指令 → 读取待审批列表 → 返回最近 10 条建议摘要。", traces, Map.of("approvals", approvals));
	}

	private AssistantChatResponse approveById(AuthPrincipal principal, UUID approvalId, List<AssistantToolTrace> traces) {
		traces.add(new AssistantToolTrace("approval.approve", "RUNNING", "正在审批并执行对应动作"));
		var approval = approvalService.approve(principal, approvalId, new ApprovalDecisionRequest(null, "由 MCP 助手聊天入口批准"));
		var actionStatus = approval.actionStatus();
		var failureMessage = approval.failureMessage();
		var actionMessage = "FAILED".equals(actionStatus)
				? "已批准，但工具执行失败：" + (failureMessage == null ? "请查看审批记录" : failureMessage)
				: "SUCCEEDED".equals(actionStatus)
						? "已批准并执行成功"
						: "已批准，工具正在执行";
		traces.add(new AssistantToolTrace("approval.approve", "FAILED".equals(actionStatus) ? "FAILED" : "SUCCEEDED", actionMessage));
		return reply("已审批通过「" + approval.customerName() + "」的建议。" + actionMessage + "。", "识别审批通过指令 → 校验审批 ID → 调用审批通过接口 → 返回审批后的业务状态。", traces, Map.of(
				"approvalId", approval.id(),
				"status", approval.status(),
				"actionStatus", actionStatus,
				"customerName", approval.customerName()));
	}

	private AssistantChatResponse listFollowUps(AuthPrincipal principal, List<AssistantToolTrace> traces) {
		traces.add(new AssistantToolTrace("follow_up.list", "RUNNING", "正在查询跟进任务"));
		var page = followUpService.findFollowUps(principal, "ALL", "MINE", 0, 10);
		traces.add(new AssistantToolTrace("follow_up.list", "SUCCEEDED", "读取跟进任务 " + page.getTotal() + " 条"));
		var tasks = page.getRecords().stream()
				.map(task -> compactMap(
				"id", task.id(),
						"customerName", task.customerName(),
						"status", task.status(),
						"priority", task.priority(),
						"reason", task.reason()))
				.toList();
		return reply(tasks.isEmpty() ? "现在没有开放中的跟进任务。" : "当前有 " + page.getTotal() + " 条跟进任务，我列出了最近 10 条。", "识别查询跟进任务指令 → 读取开放和历史跟进任务 → 返回最近 10 条任务摘要。", traces, Map.of("followUps", tasks));
	}

	private AssistantChatResponse help(List<AssistantToolTrace> traces) {
		traces.add(new AssistantToolTrace("assistant.router", "SUCCEEDED", "已返回可用自动化指令"));
		return reply("""
				我现在可以帮你自动化这些事：

				1. 新增客户
				示例：新增客户：沐光医疗，行业：医疗科技，联系人：苏恬，电话：13800000007，邮箱：su@example.com

				2. 新增客户、导入聊天并自动跑 Agent
				示例：新增客户云岚科技并导入聊天：客户说下周想看报价，需要私有化方案。

				3. 给已有客户导入聊天并自动跑 Agent
				示例：给云岚科技导入聊天：客户说下周想看报价，需要私有化方案。

				4. 直接运行客户跟进 Agent
				示例：运行 Agent 分析云岚科技

				5. 查看待审批建议
				示例：查看待审批

				6. 显式批准某条审批
				示例：批准 <审批ID>

				7. 查看跟进任务
				示例：查看跟进任务

				8. 给客户发送方案、报价或合同附件
				示例：选择文件后输入：给和成科技发送方案

				9. 查询企业知识库
				示例：查知识库：发送报价前需要哪些审批？
				""", "没有匹配到明确业务指令，因此返回当前支持的工具调用方式和示例。", traces, Map.of("intent", "HELP"));
	}

	private boolean isHelpRequest(String message) {
		var normalized = message.toLowerCase()
				.replaceAll("[\\s?？!！。,.，]+", "");
		return switch (normalized) {
			case "你能做什么", "能做什么", "你可以做什么", "可以做什么", "有什么功能", "支持什么",
					"帮助", "使用说明", "help" -> true;
			default -> false;
		};
	}

	private CustomerResponse resolveCustomer(AuthPrincipal principal, String keyword) {
        var customer = findCustomerByName(principal, keyword);
        if (customer == null) throw new AssistantWorkflowException("没有找到客户：" + keyword);
        return customer;
    }

    private CustomerResponse findCustomerByName(AuthPrincipal principal, String keyword) {
        var customers = customerService.findCustomers(principal, keyword.strip(), null, null, 0, 5).getRecords();
        if (customers.isEmpty()) return null;
		var exact = customers.stream().filter(customer -> customer.name().equalsIgnoreCase(keyword.strip())).findFirst();
		if (exact.isPresent()) {
			return exact.get();
		}
		if (customers.size() > 1) {
			throw new AssistantWorkflowException("找到多个相似客户，请把客户名写准确一点：" + customers.stream().map(CustomerResponse::name).toList());
		}
		return customers.get(0);
	}

	private CustomerResponse resolveOrCreateCustomer(AuthPrincipal principal, String keyword, boolean allowCreate, List<AssistantToolTrace> traces) {
        var customer = findCustomerByName(principal, keyword);
        if (customer != null) {
            traces.add(new AssistantToolTrace("customer.search", "SUCCEEDED", "已匹配客户：" + customer.name()));
            return customer;
        }
        if (!allowCreate) throw new AssistantWorkflowException("没有找到客户：" + keyword);
        customer = createCustomerFromDraft(principal, new CustomerDraft(keyword, null, null, null, null, null, null));
        traces.add(new AssistantToolTrace("customer.create", "SUCCEEDED", "未找到现有客户，已新建：" + customer.name()));
        return customer;
    }

	private CustomerResponse createCustomerFromDraft(AuthPrincipal principal, CustomerDraft draft) {
		return customerService.createCustomer(principal, new CustomerUpsertRequest(
				draft.name(),
				draft.website(),
				draft.industry(),
				draft.employeeRange(),
				CustomerStage.LEAD,
				CustomerStatus.ACTIVE,
				CustomerSource.CHAT,
				null,
				null,
				null,
				null,
				null,
				draft.contactName(),
				draft.contactEmail(),
				draft.contactPhone()));
	}

	private static CustomerDraft customerDraft(Map<String, Object> arguments) {
		return new CustomerDraft(
				stringArgument(arguments, "name"),
				stringArgument(arguments, "website"),
				stringArgument(arguments, "industry"),
				stringArgument(arguments, "employeeRange"),
				stringArgument(arguments, "contactName"),
				stringArgument(arguments, "contactEmail"),
				stringArgument(arguments, "contactPhone"));
	}

	private static ImportCommand importCommand(Map<String, Object> arguments) {
		return new ImportCommand(
				stringArgument(arguments, "customerName"),
				stringArgument(arguments, "chatContent"),
				booleanArgument(arguments, "createCustomer"));
	}

	private static DocumentSendCommand documentSendCommand(Map<String, Object> arguments) {
		return new DocumentSendCommand(
				stringArgument(arguments, "customerName"),
				stringArgument(arguments, "documentType"));
	}

	private static Map<String, Object> assistantTool(String name, String description, String riskLevel, List<String> requiredFields) {
		return Map.of(
				"name", name,
				"description", description,
				"risk_level", riskLevel,
				"required_fields", requiredFields);
	}

	private static String stringArgument(Map<String, Object> arguments, String name) {
		var value = arguments == null ? null : arguments.get(name);
		return value == null ? null : value.toString().strip();
	}

	private static boolean booleanArgument(Map<String, Object> arguments, String name) {
		var value = arguments == null ? null : arguments.get(name);
		return value instanceof Boolean booleanValue
				? booleanValue
				: value != null && Boolean.parseBoolean(value.toString());
	}

	private AssistantChatResponse approvePlanned(
			AuthPrincipal principal, String originalMessage, String approvalId, List<AssistantToolTrace> traces) {
		if ((!originalMessage.contains("审批通过") && !originalMessage.contains("批准")) || !StringUtils.hasText(approvalId)) {
			return reply(
					"审批属于高风险动作，请明确输入“批准 <审批ID>”。",
					"LangGraph 提出了审批动作，但 Java 未检测到明确确认语句或完整审批 ID，因此阻止执行。",
					traces,
					Map.of("intent", "APPROVE", "requiresApproval", true));
		}
		try {
			return approveById(principal, UUID.fromString(approvalId), traces);
		}
		catch (IllegalArgumentException exception) {
			return reply("审批 ID 格式不正确，请提供完整 UUID。",
					"Java 在执行高风险审批前校验审批 ID 失败，因此阻止执行。", traces,
					Map.of("intent", "APPROVE", "requiresApproval", true));
		}
	}

	private static Map<String, Object> planData(AssistantPlan plan) {
		return compactMap(
				"assistantPlanIntent", plan.intent(),
				"assistantPlanTool", plan.toolName(),
				"assistantPlanConfidence", plan.confidence(),
				"assistantPlanRequiresApproval", plan.requiresApproval(),
				"assistantPlanValidationErrors", plan.validationErrors(),
				"assistantPlanUsage", plan.usage() == null ? null : usageSnapshot(plan.usage()));
	}

	private void recordPlannerModelCall(
			AuthPrincipal principal,
			String configuredModel,
			AssistantPlan plan,
			java.time.Instant startedAt,
			java.time.Instant completedAt,
			String userMessage) {
		try {
			modelCallRecorder.record(new ModelCallRecordRequest(
					principal.organizationId(),
					principal.memberId(),
					null,
					null,
					null,
					"PLANNING",
					"QWEN",
					StringUtils.hasText(plan.model()) ? plan.model() : configuredModel,
					plan.providerRequestId(),
					"mcp-assistant-langgraph-plan-v1",
					null,
					"SUCCEEDED",
					1,
					plan.usage(),
					Math.max(0, completedAt.toEpochMilli() - startedAt.toEpochMilli()),
					sha256(userMessage),
					sha256(plan.toString()),
					Map.of("channel", "MCP_ASSISTANT", "userMessageChars", userMessage.length()),
					compactMap("intent", plan.intent(), "tool", plan.toolName(), "confidence", plan.confidence()),
					null,
					null,
					startedAt,
					completedAt));
		}
		catch (RuntimeException exception) {
			LOGGER.warn("Failed to record LangGraph planner model usage", exception);
		}
	}

	private static String nextRunHint(AgentRunResponse run) {
		if (run.pendingApprovalCount() > 0) {
			return " 已生成 " + run.pendingApprovalCount() + " 条待审批建议，下一步去审批中心批准后会生成跟进任务。";
		}
		if (run.processedCount() == 0) {
			return " 这次没有找到符合条件的近期聊天记录，可以先导入客户聊天再运行。";
		}
		return " 没有产生待审批建议。";
	}

	private AttachmentContext resolveAttachmentContext(AuthPrincipal principal, List<UUID> attachmentIds) {
		if (CollectionUtils.isEmpty(attachmentIds)) {
			return AttachmentContext.empty();
		}
		var ids = attachmentIds.stream()
				.filter(Objects::nonNull)
				.distinct()
				.limit(10)
				.toList();
		if (ids.isEmpty()) {
			return AttachmentContext.empty();
		}
		try {
			var files = ids.stream()
					.map(id -> fileStorageService.requireActive(principal.organizationId(), id))
					.toList();
			return new AttachmentContext(ids, fileStorageService.preview(files));
		}
		catch (FileStorageException exception) {
			throw new AssistantWorkflowException(exception.getMessage(), exception);
		}
	}

	private static String attachmentHint(AttachmentContext attachments) {
		if (attachments.isEmpty()) {
			return "";
		}
		return " 本次已带上 " + attachments.ids().size() + " 个附件；如果后续建议是发送邮件，审批和发送时会优先使用这些附件。";
	}

	private AssistantConversationRow resolveConversation(AuthPrincipal principal, UUID conversationId, String rawChannel, String firstMessage) {
		if (conversationId != null) {
			return ensureConversation(principal, conversationId);
		}
		var id = UUID.randomUUID();
		var now = clock.instant();
		conversationMapper.insertConversation(
				id,
				principal.organizationId(),
				principal.userId(),
				principal.memberId(),
				titleFrom(firstMessage),
				normalizeChannel(rawChannel),
				now);
		return conversationMapper.selectConversation(principal.organizationId(), id);
	}

	private AssistantConversationRow ensureConversation(AuthPrincipal principal, UUID conversationId) {
		var conversation = conversationMapper.selectConversation(principal.organizationId(), conversationId);
		if (conversation == null || !principal.memberId().equals(conversation.memberId())) {
			throw new AssistantWorkflowException("没有找到这条 MCP 助手会话，请刷新会话列表后重试");
		}
		return conversation;
	}

	private AssistantConversationResponse toConversationResponse(AssistantConversationRow row) {
		return new AssistantConversationResponse(
				row.id(),
				row.title(),
				row.channel(),
				row.status(),
				row.lastMessageAt(),
				row.createdAt(),
				row.updatedAt());
	}

	private AssistantMessageResponse toMessageResponse(AssistantMessageRow row) {
		return new AssistantMessageResponse(
				row.id(),
				row.conversationId(),
				row.role().toLowerCase(),
				row.content(),
				row.reasoningSummary(),
				parseToolTraces(row.toolTracesJson()),
				row.data(),
				row.createdAt());
	}

	private String toJson(List<AssistantToolTrace> traces) {
		return objectMapper.writeValueAsString(traces == null ? List.of() : traces);
	}

	private List<AssistantToolTrace> parseToolTraces(String json) {
		if (!StringUtils.hasText(json)) {
			return List.of();
		}
		try {
			return objectMapper.readValue(json, TOOL_TRACE_LIST_TYPE);
		}
		catch (RuntimeException exception) {
			return List.of(new AssistantToolTrace("assistant.history.parse", "FAILED", "历史工具轨迹解析失败"));
		}
	}

	private AssistantChatResponse reply(String content, String reasoningSummary, List<AssistantToolTrace> traces, Map<String, Object> data) {
		return new AssistantChatResponse(null, null, "assistant", content, reasoningSummary,
				traces.stream().filter(trace -> !trace.status().equals("RUNNING")).toList(), data, clock.instant());
	}

	private void recordAssistantModelCall(
			AuthPrincipal principal,
			String configuredModel,
			String responseModel,
			String providerRequestId,
			ModelUsage usage,
			java.time.Instant startedAt,
			java.time.Instant completedAt,
			String userMessage,
			String verifiedResult,
			String output) {
		try {
			modelCallRecorder.record(new ModelCallRecordRequest(
					principal.organizationId(),
					principal.memberId(),
					null,
					null,
					null,
					"SUMMARY",
					"QWEN",
					StringUtils.hasText(responseModel) ? responseModel : configuredModel,
					providerRequestId,
					"mcp-assistant-summary-v1",
					null,
					"SUCCEEDED",
					1,
					usage,
					Math.max(0, completedAt.toEpochMilli() - startedAt.toEpochMilli()),
					sha256(userMessage + "\n\n" + verifiedResult),
					sha256(output == null ? "" : output),
					Map.of(
							"channel", "MCP_ASSISTANT",
							"userMessageChars", userMessage == null ? 0 : userMessage.length(),
							"verifiedResultChars", verifiedResult == null ? 0 : verifiedResult.length()),
					Map.of("outputChars", output == null ? 0 : output.length()),
					null,
					null,
					startedAt,
					completedAt));
		}
		catch (RuntimeException exception) {
			LOGGER.warn("Failed to record Qwen model usage for MCP assistant summary", exception);
		}
	}

	private static Map<String, Object> usageSnapshot(ModelUsage usage) {
		var snapshot = new LinkedHashMap<String, Object>();
		snapshot.put("promptTokens", usage.promptTokens());
		snapshot.put("completionTokens", usage.completionTokens());
		snapshot.put("totalTokens", usage.totalTokens());
		snapshot.put("cachedInputTokens", usage.cachedInputTokens());
		return snapshot;
	}

	private static String normalizeChannel(String channel) {
		return "DESKTOP".equals(channel) ? "DESKTOP" : "WEB";
	}

	private static String titleFrom(String message) {
		var text = message == null ? "新的自动化会话" : message.strip().replaceAll("\\s+", " ");
		if (!StringUtils.hasText(text)) {
			return "新的自动化会话";
		}
		return text.length() <= 36 ? text : text.substring(0, 36) + "…";
	}

	private static Map<String, Object> compactMap(Object... values) {
		var map = new LinkedHashMap<String, Object>();
		for (var index = 0; index < values.length - 1; index += 2) {
			var key = values[index];
			var value = values[index + 1];
			if (key != null && value != null) {
				map.put(key.toString(), value);
			}
		}
		return map;
	}

	private static String sha256(String value) {
		try {
			var digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
			return HexFormat.of().formatHex(digest);
		}
		catch (NoSuchAlgorithmException exception) {
			throw new IllegalStateException("SHA-256 算法不可用", exception);
		}
	}

	private record AttachmentContext(List<UUID> ids, List<Map<String, Object>> preview) {

		static AttachmentContext empty() {
			return new AttachmentContext(List.of(), List.of());
		}

		boolean isEmpty() {
			return ids.isEmpty();
		}

		Map<String, Object> data() {
			if (isEmpty()) {
				return Map.of();
			}
			return Map.of("attachments", preview);
		}
	}

	private record ImportCommand(String customerName, String content, boolean createCustomer) {
	}

	private record DocumentSendCommand(String customerName, String documentType) {
	}

	private record CustomerDraft(
			String name,
			String website,
			String industry,
			String employeeRange,
			String contactName,
			String contactEmail,
			String contactPhone) {
	}

	private record AgentToolOutcome(
			String summary,
			Map<String, Object> output,
			Map<String, Object> extraData,
			boolean terminalAfterSuccess) {
	}

	private AgentToolOutcome toolSearchCustomers(AuthPrincipal principal, String keyword) {
		var query = StringUtils.hasText(keyword) ? keyword.strip() : "";
		var page = customerService.findCustomers(principal, query, null, null, 0, 10);
		var rows = page == null || page.getRecords() == null ? List.<CustomerResponse>of() : page.getRecords();
		var items = rows.stream()
				.map(c -> compactMap(
						"id", c.id(),
						"name", c.name(),
						"industry", c.industry(),
						"stage", c.stage() == null ? null : c.stage().name(),
						"score", c.score(),
						"ownerName", c.ownerName(),
						"contactName", c.primaryContact() == null ? null : c.primaryContact().name(),
						"contactEmail", c.primaryContact() == null ? null : c.primaryContact().email()))
				.toList();
		return new AgentToolOutcome(
				"找到 " + items.size() + " 位匹配客户",
				Map.of("count", items.size(), "customers", items),
				items.size() == 1 ? Map.of("customerId", rows.get(0).id(), "customerName", rows.get(0).name()) : Map.of(),
				false);
	}

	private AgentToolOutcome toolCustomerDetail(AuthPrincipal principal, String customerName) {
		if (!StringUtils.hasText(customerName)) {
			throw new AssistantWorkflowException("查询客户详情需要指定 customerName");
		}
		var customer = resolveCustomer(principal, customerName);
		var profile = new LinkedHashMap<String, Object>();
		profile.put("id", customer.id());
		profile.put("name", customer.name());
		profile.put("industry", customer.industry());
		profile.put("employeeRange", customer.employeeRange());
		profile.put("stage", customer.stage() == null ? null : customer.stage().name());
		profile.put("score", customer.score());
		profile.put("estimatedValue", customer.estimatedValue());
		profile.put("nextAction", customer.nextAction());
		profile.put("ownerName", customer.ownerName());
		profile.put("lastInteractionAt", customer.lastInteractionAt());
		profile.put("nextFollowUpAt", customer.nextFollowUpAt());
		if (customer.primaryContact() != null) {
			profile.put("primaryContact", compactMap(
					"name", customer.primaryContact().name(),
					"email", customer.primaryContact().email(),
					"phone", customer.primaryContact().phone()));
		}
		var interactionPage = interactionService.findTimeline(principal, customer.id(), 0, 5);
		var recentInteractions = interactionPage == null || interactionPage.getRecords() == null
				? List.of()
				: interactionPage.getRecords().stream()
						.map(i -> compactMap("type", i.type(), "occurredAt", i.occurredAt(), "subject", i.subject(), "preview", i.bodyPreview()))
						.toList();
		profile.put("recentInteractions", recentInteractions);
		if (opportunityService != null) {
			var oppPage = opportunityService.find(principal, customer.name(), null, null, 0, 5);
			var opps = oppPage == null || oppPage.getRecords() == null ? List.of() : oppPage.getRecords().stream()
					.filter(o -> customer.id().equals(o.customerId()))
					.map(o -> compactMap("id", o.id(), "name", o.name(), "stage", o.stage(), "amount", o.amount(), "probability", o.probability(), "nextStep", o.nextStep()))
					.toList();
			profile.put("opportunities", opps);
		}
		return new AgentToolOutcome(
				"已读取客户「" + customer.name() + "」的全景档案",
				profile,
				Map.of("customerId", customer.id(), "customerName", customer.name()),
				false);
	}

	private AgentToolOutcome toolListInteractions(AuthPrincipal principal, String customerName) {
		if (!StringUtils.hasText(customerName)) {
			throw new AssistantWorkflowException("读取沟通记录需要指定 customerName");
		}
		var customer = resolveCustomer(principal, customerName);
		var page = interactionService.findTimeline(principal, customer.id(), 0, 10);
		var items = page == null || page.getRecords() == null
				? List.<Map<String, Object>>of()
				: page.getRecords().stream()
						.map(i -> compactMap(
								"id", i.id(),
								"type", i.type(),
								"direction", i.direction(),
								"occurredAt", i.occurredAt(),
								"subject", i.subject(),
								"body", truncateText(i.bodyText(), 400)))
						.toList();
		return new AgentToolOutcome(
				"读取到「" + customer.name() + "」最近 " + items.size() + " 条沟通记录",
				Map.of("customerId", customer.id(), "customerName", customer.name(), "count", items.size(), "interactions", items),
				Map.of("customerId", customer.id(), "customerName", customer.name()),
				false);
	}

	private AgentToolOutcome toolListOpportunities(AuthPrincipal principal, String customerName) {
		if (opportunityService == null) {
			return new AgentToolOutcome("商机服务未启用", Map.of("opportunities", List.of()), Map.of(), false);
		}
		var keyword = StringUtils.hasText(customerName) ? customerName.strip() : "";
		var page = opportunityService.find(principal, keyword, null, null, 0, 10);
		var items = page == null || page.getRecords() == null
				? List.<Map<String, Object>>of()
				: page.getRecords().stream()
						.map(o -> compactMap(
								"id", o.id(),
								"company", o.company(),
								"name", o.name(),
								"stage", o.stage(),
								"status", o.status(),
								"amount", o.amount(),
								"probability", o.probability(),
								"expectedCloseDate", o.expectedCloseDate(),
								"nextStep", o.nextStep()))
						.toList();
		return new AgentToolOutcome(
				"查询到 " + items.size() + " 条商机记录",
				Map.of("count", items.size(), "opportunities", items),
				Map.of(),
				false);
	}

	private AgentToolOutcome toolCreateOpportunity(AuthPrincipal principal, Map<String, Object> arguments) {
		if (opportunityService == null) {
			throw new AssistantWorkflowException("商机创建服务暂不可用");
		}
		var customerName = stringArgument(arguments, "customerName");
		var name = stringArgument(arguments, "name");
		var amountText = stringArgument(arguments, "amount");
		if (!StringUtils.hasText(customerName) || !StringUtils.hasText(name) || !StringUtils.hasText(amountText)) {
			throw new AssistantWorkflowException("创建商机需要提供 customerName、name 和 amount");
		}
		var customer = resolveCustomer(principal, customerName);
		BigDecimal amount;
		try {
			amount = new BigDecimal(amountText.replaceAll("[,，\\s]", ""));
		}
		catch (NumberFormatException exception) {
			throw new AssistantWorkflowException("商机金额格式不正确：" + amountText);
		}
		LocalDate closeDate = null;
		var closeDateText = stringArgument(arguments, "expectedCloseDate");
		if (StringUtils.hasText(closeDateText)) {
			try {
				closeDate = LocalDate.parse(closeDateText);
			}
			catch (RuntimeException ignored) {
				closeDate = LocalDate.now(clock).plusDays(30);
			}
		}
		var ownerId = customer.ownerMemberId() != null ? customer.ownerMemberId() : principal.memberId();
		var created = opportunityService.create(principal, new OpportunityUpsertRequest(
				customer.id(),
				name,
				ownerId,
				amount,
				20,
				closeDate,
				ForecastCategory.PIPELINE,
				stringArgument(arguments, "nextStep"),
				null));
		return new AgentToolOutcome(
				"已为客户「" + customer.name() + "」创建商机「" + created.name() + "」（金额 " + created.amount() + "）",
				compactMap("opportunityId", created.id(), "name", created.name(), "amount", created.amount(), "customerId", customer.id()),
				compactMap("opportunityId", created.id(), "customerId", customer.id(), "customerName", customer.name()),
				false);
	}

	private AgentToolOutcome toolListQuotes(AuthPrincipal principal, String customerName) {
		if (quoteService == null) {
			return new AgentToolOutcome("报价服务未启用", Map.of("quotes", List.of()), Map.of(), false);
		}
		var keyword = StringUtils.hasText(customerName) ? customerName.strip() : "";
		var page = quoteService.list(principal, keyword, "", 0, 10);
		var items = page == null || page.getRecords() == null
				? List.<Map<String, Object>>of()
				: page.getRecords().stream()
						.map(q -> compactMap(
								"id", q.getId(),
								"number", q.getNumber(),
								"customerName", q.getCustomerName(),
								"title", q.getTitle(),
								"status", q.getStatus(),
								"revision", q.getRevision(),
								"total", q.getTotal(),
								"validUntil", q.getValidUntil()))
						.toList();
		return new AgentToolOutcome(
				"查询到 " + items.size() + " 条报价单记录",
				Map.of("count", items.size(), "quotes", items),
				Map.of(),
				false);
	}

	private AgentToolOutcome toolListMail(AuthPrincipal principal, String customerName) {
		if (mailConversationService == null) {
			return new AgentToolOutcome("邮件同步服务未启用", Map.of("mails", List.of()), Map.of(), false);
		}
		var page = mailConversationService.list(principal, "ALL", 0, 15);
		var rows = page == null || page.getRecords() == null ? List.<com.yourcompany.salesagent.mail.infrastructure.MailMessageRow>of() : page.getRecords();
		var filterKeyword = StringUtils.hasText(customerName) ? customerName.strip().toLowerCase(java.util.Locale.ROOT) : null;
		var items = rows.stream()
				.filter(m -> filterKeyword == null || (m.getCustomerName() != null && m.getCustomerName().toLowerCase(java.util.Locale.ROOT).contains(filterKeyword)))
				.limit(10)
				.map(m -> compactMap(
						"id", m.getId(),
						"customerName", m.getCustomerName(),
						"direction", m.getDirection(),
						"status", m.getStatus(),
						"subject", m.getSubject(),
						"body", truncateText(m.getBodyText(), 350),
						"occurredAt", m.getOccurredAt()))
				.toList();
		return new AgentToolOutcome(
				"查询到 " + items.size() + " 封往来邮件",
				Map.of("count", items.size(), "mails", items),
				Map.of(),
				false);
	}

	private AgentToolOutcome toolCreateFollowUp(AuthPrincipal principal, Map<String, Object> arguments) {
		var customerName = stringArgument(arguments, "customerName");
		var title = stringArgument(arguments, "title");
		if (!StringUtils.hasText(customerName) || !StringUtils.hasText(title)) {
			throw new AssistantWorkflowException("创建跟进任务需要提供 customerName 和 title");
		}
		var customer = resolveCustomer(principal, customerName);
		var rawActionType = stringArgument(arguments, "actionType");
		var actionType = rawActionType != null && List.of("CALL", "EMAIL", "MEETING", "OTHER").contains(rawActionType.toUpperCase(java.util.Locale.ROOT))
				? rawActionType.toUpperCase(java.util.Locale.ROOT)
				: "CALL";
		int dueDays = 1;
		var dueDaysText = stringArgument(arguments, "dueDays");
		if (StringUtils.hasText(dueDaysText)) {
			try {
				dueDays = Math.max(1, Math.min(90, Integer.parseInt(dueDaysText)));
			}
			catch (NumberFormatException ignored) {
				dueDays = 1;
			}
		}
		var ownerId = customer.ownerMemberId() != null ? customer.ownerMemberId() : principal.memberId();
		var created = followUpService.create(principal, new FollowUpUpsertRequest(
				customer.id(),
				ownerId,
				title,
				clock.instant().plus(Duration.ofDays(dueDays)),
				80,
				StringUtils.hasText(stringArgument(arguments, "reason")) ? stringArgument(arguments, "reason") : "由自主 Agent 创建跟进任务",
				actionType,
				null));
		return new AgentToolOutcome(
				"已为客户「" + customer.name() + "」创建跟进任务：" + created.recommendedAction().getOrDefault("title", title),
				compactMap("followUpId", created.id(), "customerId", customer.id(), "dueAt", created.dueAt()),
				compactMap("customerId", customer.id(), "customerName", customer.name(), "followUpId", created.id()),
				false);
	}

	private AgentToolOutcome toolQueryKnowledge(AuthPrincipal principal, String question, String originalMessage) {
		var query = StringUtils.hasText(question) ? question : originalMessage;
		var answer = knowledgeService.ask(principal, new KnowledgeQueryRequest(query, null));
		var sources = answer.sources() == null ? List.<KnowledgeAnswerResponse.Source>of() : answer.sources();
		var sourcePreviews = sources.stream()
				.map(s -> compactMap("title", s.title(), "pageNumber", s.pageNumber(), "excerpt", truncateText(s.excerpt(), 400)))
				.toList();
		return new AgentToolOutcome(
				"检索知识库完成，引用 " + sources.size() + " 个片段",
				compactMap("answer", answer.content(), "sources", sourcePreviews),
				sources.isEmpty() ? Map.of() : Map.of("knowledgeSources", sources),
				false);
	}

	private AgentToolOutcome toolDraftIntelligentEmail(
			AuthPrincipal principal,
			UUID conversationId,
			Map<String, Object> arguments,
			AttachmentContext attachments) {
		var customerName = stringArgument(arguments, "customerName");
		var subject = stringArgument(arguments, "subject");
		var body = stringArgument(arguments, "body");
		if (!StringUtils.hasText(customerName) || !StringUtils.hasText(subject) || !StringUtils.hasText(body)) {
			throw new AssistantWorkflowException("生成个性化跟进邮件需要提供 customerName、subject 和 body");
		}
		var customer = resolveCustomer(principal, customerName);
		var proposal = agentService.proposeIntelligentEmailFromMcpAssistant(
				principal,
				customer,
				conversationId,
				subject,
				body,
				stringArgument(arguments, "reason"),
				attachments.ids());
		return new AgentToolOutcome(
				"已为客户「" + customer.name() + "」智能起草定制跟进邮件，待审批 ID：" + proposal.approvalId(),
				compactMap(
						"approvalId", proposal.approvalId(),
						"agentRunId", proposal.runId(),
						"to", proposal.to(),
						"subject", proposal.subject(),
						"body", body,
						"customerName", customer.name()),
				compactMap(
						"customerId", customer.id(),
						"customerName", customer.name(),
						"agentRunId", proposal.runId(),
						"approvalId", proposal.approvalId(),
						"to", proposal.to(),
						"subject", proposal.subject(),
						"attachments", attachments.preview()),
				true);
	}

	private AgentToolOutcome toolPrepareDocumentEmail(
			AuthPrincipal principal,
			UUID conversationId,
			DocumentSendCommand command,
			AttachmentContext attachments) {
		var result = proposeDocumentEmail(principal, conversationId, command, new ArrayList<>(), attachments);
		return fromChatResponse(result, result.data().containsKey("approvalId"));
	}

	private AgentToolOutcome toolApprovePlanned(AuthPrincipal principal, String originalMessage, String approvalId) {
		var result = approvePlanned(principal, originalMessage, approvalId, new ArrayList<>());
		return fromChatResponse(result, result.data().containsKey("status"));
	}

	private static AgentToolOutcome fromChatResponse(AssistantChatResponse response, boolean terminal) {
		return new AgentToolOutcome(response.content(), response.data(), response.data(), terminal);
	}

	private AssistantChatResponse agentHelp(List<AssistantToolTrace> traces) {
		traces.add(new AssistantToolTrace("assistant.router", "SUCCEEDED", "已返回自主 Agent 模式能力说明"));
		return reply("""
				当前处于【自主 Agent 模式】（桌面客户端与企业 SVIP 专享）。相比轻辅助模式，我具备以下能力：

				1. 多轮上下文记忆：你可以直接说“查一下他的历史报价”“接着给他们写一封跟进邮件”，无需反复写完整指令。
				2. 多步自主推理：收到复合目标后，我会自动先查客户档案、聊天记录、商机与报价，再结合企业知识库执行动作。
				3. 跨模块 CRM 操作：支持创建商机、创建跟进任务、智能撰写结合痛点的个性化跟进邮件（提交高风险审批等待你确认）。

				示例指令：
				- 先查一下云岚科技最近的聊天记录和报价，结合我们的折扣政策，帮我起草一封有针对性的跟进邮件。
				- 搜索包含“智造”的客户，看看他们目前的商机进度和待办。
				""", "返回自主 Agent 模式支持的跨模块推理与记忆能力说明。", traces, Map.of("intent", "HELP", "assistantMode", "AGENT"));
	}

	private void requireModeAuthorized(AuthPrincipal principal, String mode, boolean desktopClient) {
		if (!"AGENT".equals(mode)) {
			return;
		}
		if (!capabilities(principal, desktopClient).agentModeAvailable()) {
			throw new AssistantWorkflowException("自主 Agent 模式仅开放给桌面客户端和企业 SVIP 用户");
		}
	}

	private static String normalizeMode(String rawMode) {
		return "AGENT".equalsIgnoreCase(rawMode) ? "AGENT" : "LIGHT";
	}

	private List<Map<String, Object>> loadConversationHistory(AuthPrincipal principal, UUID conversationId, String currentMessage) {
		var rows = conversationMapper.selectRecentMessages(principal.organizationId(), conversationId, HISTORY_LIMIT);
		if (rows == null || rows.isEmpty()) {
			return List.of();
		}
		var ordered = new ArrayList<>(rows);
		Collections.reverse(ordered);
		// 跳过刚刚在 beginStream 阶段写入的当前轮次 USER 消息，避免模型把当前指令当成历史。
		if (!ordered.isEmpty()) {
			var last = ordered.get(ordered.size() - 1);
			if ("USER".equalsIgnoreCase(last.role()) && Objects.equals(currentMessage.strip(), last.content() == null ? "" : last.content().strip())) {
				ordered.remove(ordered.size() - 1);
			}
		}
		var history = new ArrayList<Map<String, Object>>();
		for (var row : ordered) {
			if (!StringUtils.hasText(row.content())) {
				continue;
			}
			var role = "USER".equalsIgnoreCase(row.role()) ? "user" : "assistant";
			history.add(Map.of("role", role, "content", truncateText(row.content(), 600)));
		}
		return history;
	}

	private static Map<String, Object> agentObservation(
			int step,
			String toolName,
			Map<String, Object> arguments,
			String status,
			String summary,
			Map<String, Object> output) {
		var entry = new LinkedHashMap<String, Object>();
		entry.put("step", step);
		entry.put("tool_name", toolName == null ? "" : toolName);
		entry.put("arguments", arguments == null ? Map.of() : arguments);
		entry.put("status", status);
		entry.put("summary", summary == null ? "" : summary);
		entry.put("output", output == null ? Map.of() : output);
		return entry;
	}

	private static boolean isDuplicateToolCall(List<Map<String, Object>> observations, String toolName, Map<String, Object> arguments) {
		return observations.stream().anyMatch(obs ->
				Objects.equals(obs.get("tool_name"), toolName) && Objects.equals(obs.get("arguments"), arguments));
	}

	@SuppressWarnings("unchecked")
	private static void appendApprovals(List<Map<String, Object>> collected, Map<String, Object> extraData) {
		if (extraData.get("approvalId") != null) {
			collected.add(compactMap(
					"id", extraData.get("approvalId"),
					"customerName", extraData.get("customerName"),
					"actionType", "SEND_EMAIL",
					"riskLevel", "HIGH"));
		}
		var list = extraData.get("approvals");
		if (list instanceof Iterable<?> items) {
			for (var item : items) {
				if (item instanceof Map<?, ?> map) {
					collected.add((Map<String, Object>) map);
				}
			}
		}
	}

	@SuppressWarnings("unchecked")
	private static void appendKnowledgeSources(List<KnowledgeAnswerResponse.Source> collected, Map<String, Object> extraData) {
		var list = extraData.get("knowledgeSources");
		if (list instanceof Iterable<?> items) {
			for (var item : items) {
				if (item instanceof KnowledgeAnswerResponse.Source source) {
					collected.add(source);
				}
			}
		}
	}

	private static Map<String, Object> agentPlanData(AgentStepPlan plan) {
		return compactMap(
				"assistantPlanIntent", plan.intent(),
				"assistantPlanTool", plan.toolName(),
				"assistantPlanConfidence", plan.confidence(),
				"assistantPlanRequiresApproval", plan.requiresApproval(),
				"assistantPlanValidationErrors", plan.validationErrors(),
				"assistantPlanUsage", plan.usage() == null ? null : usageSnapshot(plan.usage()));
	}

	private static String buildAgentReasoningSummary(
			List<Map<String, Object>> agentSteps,
			List<Map<String, Object>> observations,
			AgentStepPlan lastPlan) {
		if (observations.isEmpty()) {
			return lastPlan != null && StringUtils.hasText(lastPlan.thought())
					? lastPlan.thought()
					: "自主 Agent 已结合上下文完成判断，未调用业务工具。";
		}
		var tools = observations.stream()
				.map(obs -> String.valueOf(obs.get("tool_name")))
				.distinct()
				.toList();
		return "自主 Agent 共执行 " + observations.size() + " 步工具推理（" + String.join(" → ", tools) + "）。";
	}

	private void recordAgentStepModelCall(
			AuthPrincipal principal,
			String configuredModel,
			AgentStepPlan plan,
			java.time.Instant startedAt,
			java.time.Instant completedAt,
			String userMessage,
			int step) {
		try {
			modelCallRecorder.record(new ModelCallRecordRequest(
					principal.organizationId(),
					principal.memberId(),
					null,
					null,
					null,
					"AGENT_PLAN",
					"QWEN",
					StringUtils.hasText(plan.model()) ? plan.model() : configuredModel,
					plan.providerRequestId(),
					"mcp-assistant-agent-react-v1",
					null,
					"SUCCEEDED",
					step,
					plan.usage(),
					Math.max(0, completedAt.toEpochMilli() - startedAt.toEpochMilli()),
					sha256(userMessage + "#step=" + step),
					sha256(plan.toString()),
					Map.of("channel", "MCP_ASSISTANT", "mode", "AGENT", "step", step),
					compactMap("intent", plan.intent(), "tool", plan.toolName(), "confidence", plan.confidence()),
					null,
					null,
					startedAt,
					completedAt));
		}
		catch (RuntimeException exception) {
			LOGGER.warn("Failed to record autonomous agent step model usage", exception);
		}
	}

	private static String truncateText(String value, int maxLength) {
		if (!StringUtils.hasText(value)) {
			return "";
		}
		var stripped = value.strip();
		return stripped.length() <= maxLength ? stripped : stripped.substring(0, maxLength) + "…";
	}
}

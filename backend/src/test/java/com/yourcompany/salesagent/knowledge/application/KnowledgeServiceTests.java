package com.yourcompany.salesagent.knowledge.application;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import java.time.*;
import java.util.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.server.ResponseStatusException;
import com.yourcompany.salesagent.ai.application.*;
import com.yourcompany.salesagent.ai.infrastructure.PythonAiClient;
import com.yourcompany.salesagent.auth.security.AuthPrincipal;
import com.yourcompany.salesagent.file.application.FileStorageService;
import com.yourcompany.salesagent.file.api.UploadedFileResponse;
import com.yourcompany.salesagent.file.domain.UploadedFile;
import com.yourcompany.salesagent.knowledge.api.*;
import com.yourcompany.salesagent.knowledge.infrastructure.*;

class KnowledgeServiceTests {
	private final UUID org = UUID.randomUUID(), member = UUID.randomUUID(), document = UUID.randomUUID(), chunk = UUID.randomUUID();
	private final Instant now = Instant.parse("2026-11-09T07:00:00Z");
	private final KnowledgeMapper mapper = mock(KnowledgeMapper.class);
	private final FileStorageService files = mock(FileStorageService.class);
	private final PythonAiClient python = mock(PythonAiClient.class);
	private final AiModelService models = mock(AiModelService.class);
	private final ModelCallRecorder recorder = mock(ModelCallRecorder.class);
	private final PlatformTransactionManager tx = mock(PlatformTransactionManager.class);
	private final KnowledgeService service = new KnowledgeService(mapper, files, python, models, recorder, Clock.fixed(now, ZoneOffset.UTC), tx);
	private AuthPrincipal actor(String role) { return new AuthPrincipal(UUID.randomUUID(), UUID.randomUUID(), org, member, "test@local", "销售", "团队", role, now.plusSeconds(3600)); }
	private KnowledgeDocumentRow row() {
		var row = new KnowledgeDocumentRow(); row.setId(document); row.setUploadedByMemberId(member); row.setFileId(UUID.randomUUID());
		row.setTitle("报价流程"); row.setCategory("POLICY"); row.setVisibility("TEAM"); row.setStatus("READY"); row.setEnabled(true); row.setRevision(1); row.setUpdatedAt(now); return row;
	}
	@BeforeEach
	void setup() {
		when(tx.getTransaction(any())).thenReturn(new SimpleTransactionStatus());
		when(models.defaultEmbeddingDimensions()).thenReturn(1024);
		when(models.findRuntimeConfiguration(org)).thenReturn(Optional.empty());
		when(python.prepareKnowledgeSearch(anyString(), any(), anyInt()))
				.thenReturn(new PythonAiClient.PythonSearchTerms("报价 | 审批"));
		when(models.requireRuntimeConfiguration(org, member))
				.thenReturn(new AiModelRuntimeConfiguration("QWEN", "test", "qwen3.7-text-embedding-flash", "https://example.invalid/v1", "key"));
	}
	@Test
	void noQuotaPreventsRetrievalAndModelUse() {
		doThrow(new TokenQuotaExceededException("未分配额度")).when(models).requireAvailableTokenQuota(org, member);
		assertThatThrownBy(() -> service.ask(actor("SALES"), new KnowledgeQueryRequest("报价审批", null))).isInstanceOf(TokenQuotaExceededException.class);
		verifyNoInteractions(python, mapper);
	}
	@Test
	void inaccessibleDocumentIsNotFoundBeforeRetrieval() {
		assertThatThrownBy(() -> service.ask(actor("SALES"), new KnowledgeQueryRequest("报价审批", document))).isInstanceOf(ResponseStatusException.class);
		verify(mapper).selectDocument(org, member, document);
		verifyNoInteractions(python);
	}
	@Test
	void noMatchDoesNotInvokeTheModel() {
		when(mapper.selectCandidates(org, member, "报价 | 审批", null)).thenReturn(List.of());
		var response = service.ask(actor("SALES"), new KnowledgeQueryRequest("报价审批", null));
		assertThat(response.sources()).isEmpty();
		assertThat(response.content()).contains("没有找到");
		verify(python, never()).answerKnowledge(any(), any(), any());
	}
	private void groundedAnswer(String returnedSourceId, int available) {
		when(mapper.selectCandidates(org, member, "报价 | 审批", null)).thenReturn(List.of(new KnowledgeChunkResponse(chunk, document, 0, 2, "报价流程", "报价需要销售经理审批", 1)));
		when(python.answerKnowledge(any(), any(), any())).thenReturn(new PythonAiClient.PythonKnowledgeAnswer("需要经理审批。[资料 1]", new PythonAiClient.PythonUsage(20, 10, 30, 0L), "test-request", "test", List.of(new PythonAiClient.PythonKnowledgeSource(returnedSourceId, "untrusted title", "untrusted excerpt", 0.8, Map.of()))));
		when(mapper.sourceAvailable(org, member, chunk, 1)).thenReturn(available);
	}
	@Test
	void answersWithVerifiedSourceAndRecordsTokenUsage() {
		groundedAnswer(chunk.toString(), 1);
		var response = service.ask(actor("SALES"), new KnowledgeQueryRequest("报价审批", null));
		assertThat(response.sources().get(0).title()).isEqualTo("报价流程");
		assertThat(response.sources().get(0).excerpt()).isEqualTo("报价需要销售经理审批");
		assertThat(response.sources().get(0).pageNumber()).isEqualTo(2);
		assertThat(response.usage().totalTokens()).isEqualTo(30);
		verify(recorder).record(argThat(call -> call.purpose().equals("KNOWLEDGE_QA") && call.memberId().equals(member) && call.usage().totalTokens() == 30));
	}
	@Test
	void sourceRemovedDuringGenerationSuppressesStaleAnswer() {
		groundedAnswer(chunk.toString(), 0);
		var response = service.ask(actor("SALES"), new KnowledgeQueryRequest("报价审批", null));
		assertThat(response.content()).contains("重新提问");
		assertThat(response.content()).doesNotContain("经理审批");
		assertThat(response.sources()).isEmpty();
	}
	@Test
	void unknownSourceIdIsNeverTrusted() {
		groundedAnswer(UUID.randomUUID().toString(), 1);
		assertThat(service.ask(actor("SALES"), new KnowledgeQueryRequest("报价审批", null)).sources()).isEmpty();
	}
	@Test
	void viewerCannotWriteKnowledge() {
		assertThatThrownBy(() -> service.createText(actor("VIEWER"), new KnowledgeTextRequest(new KnowledgeDocumentRequest("资料", "OTHER", "TEAM", null), "正文"))).isInstanceOf(AccessDeniedException.class);
		verifyNoInteractions(files, mapper);
	}
	@Test
	void ordinaryMemberCannotDeleteAnotherMembersDocument() {
		var row = row(); row.setUploadedByMemberId(UUID.randomUUID());
		when(mapper.lockDocument(org, member, document)).thenReturn(row);
		assertThatThrownBy(() -> service.delete(actor("SALES"), document, 0)).isInstanceOf(AccessDeniedException.class);
		verify(mapper, never()).deleteDocument(any(), any(), anyLong(), any());
	}
	@Test
	void failedParsingIsPersistedAndCanBeRetried() {
		var row = row(); row.setStatus("PROCESSING");
		var file = UploadedFile.create(row.getFileId(), org, member, null, "资料.txt", "text/plain", "正文".getBytes(java.nio.charset.StandardCharsets.UTF_8), "0".repeat(64), now);
		when(files.uploadContent(any(), any(), any(), any(), any())).thenReturn(UploadedFileResponse.from(file));
		when(mapper.selectDocument(eq(org), eq(member), any())).thenReturn(row);
		when(files.requireActive(org, row.getFileId())).thenReturn(file);
		when(python.ingestDocument(any(), any(), any(), any(), any(), anyInt())).thenThrow(new PythonAiClient.PythonAiException("Document: 文件无法解析"));
		when(mapper.completeProcessing(eq(org), any(), eq(1L), eq(0), eq(0), anyString(), eq(now))).thenAnswer(call -> { row.setStatus("FAILED"); row.setErrorMessage(call.getArgument(5)); return 1; });
		var result = service.createText(actor("SALES"), new KnowledgeTextRequest(new KnowledgeDocumentRequest("资料", "OTHER", "TEAM", null), "正文"));
		assertThat(result.status()).isEqualTo("FAILED");
		assertThat(result.errorMessage()).isEqualTo("文件无法解析");
	}
	@Test
	void hybridRetrievalMergesVectorAndLexicalHitsAndRecordsEmbeddingUsage() {
		var semanticChunk = UUID.randomUUID();
		when(python.prepareKnowledgeSearch(eq("重点客户打折流程"), any(), eq(1024)))
				.thenReturn(new PythonAiClient.PythonSearchTerms(
						"重点 | 客户 | 打折",
						List.of(0.1, 0.2, 0.3),
						"qwen3.7-text-embedding-flash",
						new PythonAiClient.PythonUsage(8, 0, 8, 0L),
						null));
		when(mapper.selectVectorCandidates(org, member, "[0.1,0.2,0.3]", "qwen3.7-text-embedding-flash", null))
				.thenReturn(List.of(new KnowledgeVectorCandidateRow(semanticChunk, document, 0, 1, "价格政策", "大客户年度采购可申请阶梯返点", 1, 0.88)));
		when(mapper.selectCandidates(org, member, "重点 | 客户 | 打折", null))
				.thenReturn(List.of(new KnowledgeChunkResponse(chunk, document, 1, 2, "报价流程", "折扣需总监审批", 1)));
		when(python.answerKnowledge(any(), eq("重点客户打折流程"), argThat(list -> list.size() == 2
				&& Double.valueOf(0.88).equals(list.get(0).get("vector_score"))
				&& Integer.valueOf(1).equals(list.get(0).get("vector_rank"))
				&& Integer.valueOf(1).equals(list.get(1).get("lexical_rank")))))
				.thenReturn(new PythonAiClient.PythonKnowledgeAnswer(
						"大客户可申请阶梯返点并由总监审批。[资料 1]",
						new PythonAiClient.PythonUsage(30, 12, 42, 0L),
						"req-hybrid",
						"qwen-plus",
						List.of(new PythonAiClient.PythonKnowledgeSource(semanticChunk.toString(), "价格政策", "大客户年度采购可申请阶梯返点", 0.82, Map.of()))));
		when(mapper.sourceAvailable(org, member, semanticChunk, 1)).thenReturn(1);

		var response = service.ask(actor("SALES"), new KnowledgeQueryRequest("重点客户打折流程", null));

		assertThat(response.sources()).hasSize(1);
		assertThat(response.sources().get(0).id()).isEqualTo(semanticChunk);
		verify(recorder).record(argThat(call -> "KNOWLEDGE_EMBEDDING".equals(call.purpose()) && call.usage().totalTokens() == 8));
		verify(recorder).record(argThat(call -> "KNOWLEDGE_QA".equals(call.purpose()) && call.usage().totalTokens() == 42));
	}
	@Test
	void uploadEmbedsChunksAndPersistsVectorLiteral() {
		var row = row(); row.setStatus("PROCESSING"); row.setTitle("价格政策");
		var file = UploadedFile.create(row.getFileId(), org, member, null, "政策.txt", "text/plain", "折扣审批规则".getBytes(java.nio.charset.StandardCharsets.UTF_8), "0".repeat(64), now);
		var config = new AiModelRuntimeConfiguration("QWEN", "qwen-plus", "qwen3.7-text-embedding-flash", "https://dashscope.aliyuncs.com/compatible-mode/v1", "sk-test");
		when(models.findRuntimeConfiguration(org)).thenReturn(Optional.of(config));
		when(files.uploadContent(any(), any(), any(), any(), any())).thenReturn(UploadedFileResponse.from(file));
		when(mapper.selectDocument(eq(org), eq(member), any())).thenReturn(row);
		when(mapper.lockDocument(eq(org), eq(member), any())).thenReturn(row);
		when(files.requireActive(org, row.getFileId())).thenReturn(file);
		when(python.ingestDocument(eq("政策.txt"), eq("价格政策"), eq("POLICY"), any(), eq(config), eq(1024)))
				.thenReturn(new PythonAiClient.PythonDocument(
						List.of(new PythonAiClient.PythonDocumentChunk(0, null, "折扣审批规则", "折扣 审批", List.of(0.25, -0.5))),
						6,
						"qwen3.7-text-embedding-flash",
						new PythonAiClient.PythonUsage(15, 0, 15, 0L),
						null));
		when(mapper.completeProcessing(eq(org), any(), eq(1L), eq(1), eq(6), isNull(), eq(now))).thenAnswer(call -> { row.setStatus("READY"); row.setChunkCount(1); row.setEmbeddedChunkCount(1); return 1; });

		var result = service.createText(actor("SALES"), new KnowledgeTextRequest(new KnowledgeDocumentRequest("价格政策", "POLICY", "TEAM", null), "折扣审批规则"));

		assertThat(result.status()).isEqualTo("READY");
		assertThat(result.embeddedChunkCount()).isEqualTo(1);
		verify(mapper).insertChunk(eq(org), any(), eq(row.getId()), eq(1L), eq(0), isNull(), eq("折扣审批规则"), eq("折扣 审批"), eq("[0.25,-0.5]"), eq("qwen3.7-text-embedding-flash"));
		verify(recorder).record(argThat(call -> "KNOWLEDGE_EMBEDDING".equals(call.purpose()) && call.usage().totalTokens() == 15));
	}
	@Test
	void expandsAdjacentChunkRecordsTelemetryAndPreservesRefusalWithoutSources() {
		var page1 = UUID.randomUUID();
		var page2 = UUID.randomUUID();
		when(python.prepareKnowledgeSearch(eq("成都专户限额"), any(), eq(1024)))
				.thenReturn(new PythonAiClient.PythonSearchTerms("成都 | 专户 | 限额", List.of(0.3, 0.4), "qwen3.7-text-embedding-flash", null, null));
		when(mapper.selectVectorCandidates(org, member, "[0.3,0.4]", "qwen3.7-text-embedding-flash", null))
				.thenReturn(List.of(new KnowledgeVectorCandidateRow(page1, document, 0, 1, "成都规程", "一、适用范围", 1, 0.85)));
		when(mapper.selectCandidates(org, member, "成都 | 专户 | 限额", null)).thenReturn(List.of());
		when(mapper.selectAdjacentChunks(org, member, document, List.of(1)))
				.thenReturn(List.of(new KnowledgeChunkResponse(page2, document, 1, 2, "成都规程", "单笔300万，T+3", 1)));
		when(python.answerKnowledge(any(), eq("成都专户限额"), argThat(list -> list.size() == 2
				&& page2.toString().equals(list.get(1).get("id"))
				&& Boolean.TRUE.equals(((Map<?, ?>) list.get(1).get("metadata")).get("adjacent")))))
				.thenReturn(new PythonAiClient.PythonKnowledgeAnswer(
						"当前知识库中没有相关记载，无法确认。",
						new PythonAiClient.PythonUsage(15, 8, 23, 0L),
						"req-refusal",
						"qwen4-max",
						List.of()));

		var response = service.ask(actor("SALES"), new KnowledgeQueryRequest("成都专户限额", null));

		assertThat(response.sources()).isEmpty();
		assertThat(response.content()).isEqualTo("当前知识库中没有相关记载，无法确认。");
		verify(recorder).record(argThat(call -> "KNOWLEDGE_QA".equals(call.purpose())
				&& call.inputSnapshot().containsKey("embedMs")
				&& call.inputSnapshot().containsKey("vectorDbMs")
				&& call.inputSnapshot().containsKey("adjacentDbMs")));
	}
}

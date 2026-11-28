package com.yourcompany.salesagent.admin.application;

import java.time.Clock;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.yourcompany.salesagent.admin.api.AdminMemberCreateRequest;
import com.yourcompany.salesagent.admin.api.AdminMemberPasswordResetRequest;
import com.yourcompany.salesagent.admin.api.AdminMemberResponse;
import com.yourcompany.salesagent.admin.api.AdminMemberUpdateRequest;
import com.yourcompany.salesagent.admin.api.AdminTeamResponse;
import com.yourcompany.salesagent.admin.api.AdminTeamUpdateRequest;
import com.yourcompany.salesagent.admin.api.MemberTokenQuotaRequest;
import com.yourcompany.salesagent.admin.api.TeamTokenBudgetRequest;
import com.yourcompany.salesagent.admin.api.TeamTokenBudgetResponse;
import com.yourcompany.salesagent.admin.domain.MemberRole;
import com.yourcompany.salesagent.admin.domain.MemberStatus;
import com.yourcompany.salesagent.admin.infrastructure.AdminMapper;
import com.yourcompany.salesagent.admin.infrastructure.AdminMemberRow;
import com.yourcompany.salesagent.auth.security.AuthPrincipal;

@Service
public class AdminService {

	private static final Set<MemberRole> ASSIGNABLE_ROLES = Set.of(
			MemberRole.ADMIN, MemberRole.MANAGER, MemberRole.SALES, MemberRole.VIEWER);
	private static final Set<MemberStatus> ASSIGNABLE_STATUSES = Set.of(
			MemberStatus.ACTIVE, MemberStatus.SUSPENDED, MemberStatus.LEFT);

	private final AdminMapper adminMapper;
	private final PasswordEncoder passwordEncoder;
	private final Clock clock;

	public AdminService(AdminMapper adminMapper, PasswordEncoder passwordEncoder, Clock clock) {
		this.adminMapper = adminMapper;
		this.passwordEncoder = passwordEncoder;
		this.clock = clock;
	}

	@Transactional(readOnly = true)
	public IPage<AdminMemberResponse> findMembers(
			AuthPrincipal actor,
			String keyword,
			MemberRole role,
			MemberStatus status,
			int page,
			int size) {
		var rows = adminMapper.selectMembers(
				Page.of(page + 1L, size), actor.organizationId(), trimToNull(keyword), role, status);
		return new Page<AdminMemberResponse>(rows.getCurrent(), rows.getSize(), rows.getTotal())
				.setRecords(rows.getRecords().stream().map(AdminMemberResponse::from).toList());
	}

	@Transactional
	public AdminMemberResponse createMember(AuthPrincipal actor, AdminMemberCreateRequest request) {
		validateAssignableRole(actor, request.role());
		var email = request.email().strip().toLowerCase(Locale.ROOT);
		if (adminMapper.countEmail(email) > 0) {
			throw new AdminValidationException("该邮箱已被其他账号使用");
		}

		var now = clock.instant();
		var userId = UUID.randomUUID();
		var memberId = UUID.randomUUID();
		adminMapper.insertUser(userId, email, request.displayName().strip(), "local-" + userId, now);
		adminMapper.insertCredential(userId, passwordEncoder.encode(request.initialPassword()), now);
		adminMapper.insertMember(memberId, actor.organizationId(), userId, request.role(), now);
		return AdminMemberResponse.from(requireMember(actor.organizationId(), memberId));
	}

	@Transactional
	public AdminMemberResponse updateMember(
			AuthPrincipal actor,
			UUID memberId,
			AdminMemberUpdateRequest request) {
		var current = requireManageableMember(actor, memberId);
		validateAssignableRole(actor, request.role());
		if (!ASSIGNABLE_STATUSES.contains(request.status())) {
			throw new AdminValidationException("不支持设置该成员状态");
		}

		var now = clock.instant();
		if (adminMapper.updateMember(
				actor.organizationId(), memberId, request.displayName().strip(), request.role(), request.status(), now) == 0) {
			throw new AdminResourceNotFoundException("成员不存在或已被移出当前团队");
		}
		if (request.status() != MemberStatus.ACTIVE || request.role() != current.role()) {
			adminMapper.revokeMemberSessions(actor.organizationId(), memberId, now);
		}
		return AdminMemberResponse.from(requireMember(actor.organizationId(), memberId));
	}

	@Transactional
	public void resetMemberPassword(
			AuthPrincipal actor,
			UUID memberId,
			AdminMemberPasswordResetRequest request) {
		requireManageableMember(actor, memberId);
		var now = clock.instant();
		var encoded = passwordEncoder.encode(request.newPassword());
		if (adminMapper.updateMemberPassword(actor.organizationId(), memberId, encoded, now) == 0) {
			throw new AdminValidationException("该成员账号未启用本地密码登录，无法重置密码");
		}
		adminMapper.revokeMemberSessions(actor.organizationId(), memberId, now);
	}

	@Transactional
	public int revokeMemberSessions(AuthPrincipal actor, UUID memberId) {
		requireManageableMember(actor, memberId);
		return adminMapper.revokeMemberSessions(actor.organizationId(), memberId, clock.instant());
	}

	@Transactional
	public AdminMemberResponse updateMemberTokenQuota(
			AuthPrincipal actor,
			UUID memberId,
			MemberTokenQuotaRequest request) {
		lockOrganization(actor.organizationId());
		var member = requireMember(actor.organizationId(), memberId);
		boolean updateAllocated = request.updateAllocatedQuota() == null || Boolean.TRUE.equals(request.updateAllocatedQuota());
		boolean updateEmbedding = Boolean.TRUE.equals(request.updateEmbeddingQuota())
				|| (request.updateEmbeddingQuota() == null && request.embeddingAllocatedTokens() != null);

		var nextAllocated = updateAllocated ? request.allocatedTokens() : member.allocatedTokens();
		var nextEmbedding = updateEmbedding ? request.embeddingAllocatedTokens() : member.embeddingAllocatedTokens();

		if (nextAllocated != null && nextAllocated > 1_000_000_000_000L) {
			throw new AdminValidationException("单个成员普通模型 Token 额度不能超过 1 万亿");
		}
		if (nextEmbedding != null && nextEmbedding > 1_000_000_000_000L) {
			throw new AdminValidationException("单个成员向量模型 Token 额度不能超过 1 万亿");
		}

		if (updateAllocated) {
			var budget = adminMapper.selectTeamTokenBudget(actor.organizationId());
			if (nextAllocated != null && budget == null) {
				throw new AdminValidationException("请先设置团队 Token 总额");
			}
			var assigned = adminMapper.sumMemberTokenQuotas(actor.organizationId());
			var nextAssigned = assigned - (member.allocatedTokens() == null ? 0 : member.allocatedTokens())
					+ (nextAllocated == null ? 0 : nextAllocated);
			if (budget != null && nextAssigned > budget) {
				throw new AdminValidationException("分配后将超过团队 Token 总额，请先增加总额或减少其他成员额度");
			}
		}

		if (updateEmbedding) {
			var embeddingBudget = adminMapper.selectTeamEmbeddingTokenBudget(actor.organizationId());
			if (nextEmbedding != null && embeddingBudget == null) {
				throw new AdminValidationException("请先设置团队向量模型 Token 总额");
			}
			var embeddingAssigned = adminMapper.sumMemberEmbeddingTokenQuotas(actor.organizationId());
			var nextEmbeddingAssigned = embeddingAssigned
					- (member.embeddingAllocatedTokens() == null ? 0 : member.embeddingAllocatedTokens())
					+ (nextEmbedding == null ? 0 : nextEmbedding);
			if (embeddingBudget != null && nextEmbeddingAssigned > embeddingBudget) {
				throw new AdminValidationException("分配后将超过团队向量模型 Token 总额，请先增加总额或减少其他成员额度");
			}
		}

		if (nextAllocated == null && nextEmbedding == null) {
			adminMapper.deleteMemberTokenQuota(actor.organizationId(), memberId);
		}
		else {
			adminMapper.upsertMemberTokenQuota(
					actor.organizationId(), memberId, nextAllocated, nextEmbedding, actor.memberId(), clock.instant());
		}
		return AdminMemberResponse.from(requireMember(actor.organizationId(), memberId));
	}

	@Transactional(readOnly = true)
	public TeamTokenBudgetResponse getTeamTokenBudget(AuthPrincipal actor) {
		return teamTokenBudget(actor.organizationId());
	}

	@Transactional
	public TeamTokenBudgetResponse updateTeamTokenBudget(AuthPrincipal actor, TeamTokenBudgetRequest request) {
		lockOrganization(actor.organizationId());
		var currentTotal = adminMapper.selectTeamTokenBudget(actor.organizationId());
		var currentEmbeddingTotal = adminMapper.selectTeamEmbeddingTokenBudget(actor.organizationId());
		var assigned = adminMapper.sumMemberTokenQuotas(actor.organizationId());
		var embeddingAssigned = adminMapper.sumMemberEmbeddingTokenQuotas(actor.organizationId());

		var nextTotal = request.totalTokens() != null ? request.totalTokens() : currentTotal;
		if (nextTotal == null) {
			throw new AdminValidationException("请先设置团队普通模型 Token 总额");
		}
		if (nextTotal > 1_000_000_000_000L) {
			throw new AdminValidationException("团队 Token 总额不能超过 1 万亿");
		}
		if (nextTotal < assigned) {
			throw new AdminValidationException("团队总额不能低于已分配额度，请先调整成员额度");
		}

		boolean updateEmbedding = Boolean.TRUE.equals(request.updateEmbeddingBudget())
				|| request.embeddingTotalTokens() != null;
		var nextEmbeddingTotal = updateEmbedding ? request.embeddingTotalTokens() : currentEmbeddingTotal;
		if (nextEmbeddingTotal != null) {
			if (nextEmbeddingTotal > 1_000_000_000_000L) {
				throw new AdminValidationException("团队向量模型 Token 总额不能超过 1 万亿");
			}
			if (nextEmbeddingTotal < embeddingAssigned) {
				throw new AdminValidationException("团队向量模型总额不能低于已分配额度，请先调整成员额度");
			}
		}
		else if (updateEmbedding && embeddingAssigned > 0) {
			throw new AdminValidationException("团队向量模型总额不能低于已分配额度，请先调整成员额度");
		}

		adminMapper.upsertTeamTokenBudget(
				actor.organizationId(), nextTotal, nextEmbeddingTotal, actor.memberId(), clock.instant());
		return new TeamTokenBudgetResponse(
				nextTotal,
				assigned,
				nextTotal - assigned,
				nextEmbeddingTotal,
				embeddingAssigned,
				nextEmbeddingTotal == null ? null : Math.max(0, nextEmbeddingTotal - embeddingAssigned));
	}

	private TeamTokenBudgetResponse teamTokenBudget(UUID organizationId) {
		var total = adminMapper.selectTeamTokenBudget(organizationId);
		var assigned = adminMapper.sumMemberTokenQuotas(organizationId);
		var embeddingTotal = adminMapper.selectTeamEmbeddingTokenBudget(organizationId);
		var embeddingAssigned = adminMapper.sumMemberEmbeddingTokenQuotas(organizationId);
		return new TeamTokenBudgetResponse(
				total,
				assigned,
				total == null ? null : Math.max(0, total - assigned),
				embeddingTotal,
				embeddingAssigned,
				embeddingTotal == null ? null : Math.max(0, embeddingTotal - embeddingAssigned));
	}

	private void lockOrganization(UUID organizationId) {
		if (adminMapper.lockOrganization(organizationId) == 0) {
			throw new AdminResourceNotFoundException("当前团队不存在");
		}
	}

	@Transactional(readOnly = true)
	public AdminTeamResponse getTeam(AuthPrincipal actor) {
		var team = adminMapper.selectTeam(actor.organizationId());
		if (team == null) {
			throw new AdminResourceNotFoundException("当前团队不存在");
		}
		return AdminTeamResponse.from(team);
	}

	@Transactional
	public AdminTeamResponse updateTeam(AuthPrincipal actor, AdminTeamUpdateRequest request) {
		try {
			java.time.ZoneId.of(request.timezone());
		}
		catch (java.time.DateTimeException exception) {
			throw new AdminValidationException("请输入有效的 IANA 时区，例如 Asia/Shanghai");
		}
		if (adminMapper.updateTeam(
				actor.organizationId(), request.name().strip(), request.timezone(), request.locale(), clock.instant()) == 0) {
			throw new AdminResourceNotFoundException("当前团队不存在");
		}
		return getTeam(actor);
	}

	private AdminMemberRow requireManageableMember(AuthPrincipal actor, UUID memberId) {
		var current = requireMember(actor.organizationId(), memberId);
		if (current.role() == MemberRole.OWNER) {
			throw new AdminValidationException("团队所有者不能在成员管理中修改");
		}
		if (memberId.equals(actor.memberId())) {
			throw new AdminValidationException("不能修改自己的角色或账号状态");
		}
		if ("ADMIN".equals(actor.role()) && current.role() == MemberRole.ADMIN) {
			throw new AdminValidationException("管理员不能修改其他管理员，请由团队所有者操作");
		}
		return current;
	}

	private void validateAssignableRole(AuthPrincipal actor, MemberRole role) {
		if (!ASSIGNABLE_ROLES.contains(role)) {
			throw new AdminValidationException("团队所有者角色不能通过成员管理分配");
		}
		if (role == MemberRole.ADMIN && !"OWNER".equals(actor.role())) {
			throw new AdminValidationException("只有团队所有者可以任命管理员");
		}
	}

	private AdminMemberRow requireMember(UUID organizationId, UUID memberId) {
		var member = adminMapper.selectMember(organizationId, memberId);
		if (member == null) {
			throw new AdminResourceNotFoundException("成员不存在或已被移出当前团队");
		}
		return member;
	}

	private static String trimToNull(String value) {
		return StringUtils.hasText(value) ? value.strip() : null;
	}
}

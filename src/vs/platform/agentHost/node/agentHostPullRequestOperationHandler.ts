/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { GITHUB_REPO_PROTECTED_RESOURCE, IAgentService } from '../common/agentService.js';
import { parseChangesetUri } from '../common/changesetUri.js';
import { AHP_AUTH_REQUIRED, ProtocolError } from '../common/state/sessionProtocol.js';
import { readSessionGitState, type ChangesetOperationFollowUp } from '../common/state/sessionState.js';
import { ILogService } from '../../log/common/log.js';
import { AgentHostStateManager } from './agentHostStateManager.js';
import { IAgentHostGitService } from './agentHostGitService.js';
import { type IChangesetOperationHandler } from './agentService.js';
import { IAgentHostOctoKitService } from './shared/agentHostOctoKitService.js';
import type { InvokeChangesetOperationParams, InvokeChangesetOperationResult } from '../common/state/protocol/channels-changeset/commands.js';

// JSON-RPC error codes — keep in sync with `JsonRpcErrorCodes` in
// `base/common/jsonRpcProtocol.ts`. Imported here as constants to avoid
// pulling that whole module just for two numbers.
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

/**
 * Server-side handler for the `create-pr` and `create-draft-pr` changeset
 * operations advertised on git-backed sessions whose working directory has
 * a GitHub remote (see {@link AgentService._updateBranchChangesetOperations}).
 *
 * The flow mirrors the Copilot CLI extension's `createPullRequest` helper
 * (`extensions/copilot/src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts`):
 *
 * 1. Resolve session → working directory + current/base branch from
 *    {@link ISessionGitState}.
 * 2. Push the current branch to `origin` (with `--set-upstream` when missing).
 * 3. Resolve `owner` / `repo` from {@link ISessionGitState.githubOwner}
 *    / {@link ISessionGitState.githubRepo} (populated by the git probe).
 * 4. POST `/repos/{owner}/{repo}/pulls` via {@link IAgentHostOctoKitService}.
 * 5. Return the PR URL as an {@link InvokeChangesetOperationResult.followUp}.
 *
 * Uncommitted working-tree changes are intentionally NOT auto-committed
 * in v1 — they simply do not end up in the PR. The user is responsible
 * for committing before invoking the op. A warning is included in the
 * result message when the working tree is dirty.
 */
export class AgentHostPullRequestOperationHandler implements IChangesetOperationHandler {

	public static readonly OPERATION_CREATE_PR = 'create-pr';
	public static readonly OPERATION_CREATE_DRAFT_PR = 'create-draft-pr';

	constructor(
		private readonly _draft: boolean,
		private readonly _stateManager: AgentHostStateManager,
		@IAgentService private readonly _agentService: IAgentService,
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
		@IAgentHostOctoKitService private readonly _octoKitService: IAgentHostOctoKitService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async invoke(params: InvokeChangesetOperationParams, _token: CancellationToken): Promise<InvokeChangesetOperationResult> {
		const parsed = parseChangesetUri(params.channel);
		if (!parsed) {
			throw new ProtocolError(JSON_RPC_INVALID_PARAMS, `Not a changeset URI: ${params.channel}`);
		}
		const sessionUri = parsed.sessionUri;

		const sessionState = this._stateManager.getSessionState(sessionUri);
		if (!sessionState) {
			throw new ProtocolError(JSON_RPC_INTERNAL_ERROR, `Session not found: ${sessionUri}`);
		}

		const workingDirectoryStr = sessionState.summary.workingDirectory;
		if (!workingDirectoryStr) {
			throw new ProtocolError(JSON_RPC_INTERNAL_ERROR, `Session has no working directory: ${sessionUri}`);
		}
		const workingDirectory = URI.parse(workingDirectoryStr);

		const gitState = readSessionGitState(sessionState._meta);
		if (!gitState?.hasGitHubRemote || !gitState.githubOwner || !gitState.githubRepo) {
			throw new ProtocolError(
				JSON_RPC_INTERNAL_ERROR,
				`Session's working directory is not a GitHub-backed git repo: ${sessionUri}`,
			);
		}

		const branchName = gitState.branchName ?? await this._gitService.getCurrentBranch(workingDirectory);
		if (!branchName) {
			throw new ProtocolError(JSON_RPC_INTERNAL_ERROR, `Could not determine current branch for ${workingDirectory}`);
		}

		const baseBranchName = gitState.baseBranchName ?? await this._gitService.getDefaultBranch(workingDirectory);
		if (!baseBranchName) {
			throw new ProtocolError(JSON_RPC_INTERNAL_ERROR, `Could not determine base branch for ${workingDirectory}`);
		}
		// `getDefaultBranch` may return `origin/<branch>` — `pulls` API wants the bare name.
		const base = baseBranchName.startsWith('origin/') ? baseBranchName.substring('origin/'.length) : baseBranchName;

		const token = this._agentService.getAuthToken(GITHUB_REPO_PROTECTED_RESOURCE.resource);
		if (!token) {
			throw new ProtocolError(
				AHP_AUTH_REQUIRED,
				localize('agentHost.changeset.pr.authRequired', "Sign in to GitHub with repository access to create a pull request."),
				[GITHUB_REPO_PROTECTED_RESOURCE],
			);
		}

		const hasUncommitted = await this._gitService.hasUncommittedChanges(workingDirectory);

		this._logService.info(`[AgentHostPullRequestOperationHandler] Pushing branch ${branchName} for session ${sessionUri}`);
		const upstreamPresent = await this._gitService.hasUpstream(workingDirectory, branchName);
		try {
			await this._gitService.pushBranch(workingDirectory, branchName, !upstreamPresent);
		} catch (err) {
			throw new ProtocolError(JSON_RPC_INTERNAL_ERROR, `Failed to push branch '${branchName}': ${err instanceof Error ? err.message : String(err)}`);
		}

		const title = this._formatTitle(branchName);
		const body = this._formatBody(branchName, base, hasUncommitted);

		this._logService.info(`[AgentHostPullRequestOperationHandler] Creating ${this._draft ? 'draft ' : ''}PR ${gitState.githubOwner}/${gitState.githubRepo} ${branchName} -> ${base}`);
		const created = await this._octoKitService.createPullRequest(
			gitState.githubOwner,
			gitState.githubRepo,
			title,
			body,
			branchName,
			base,
			this._draft,
			token,
		);

		const followUp: ChangesetOperationFollowUp = {
			content: { uri: created.url, contentType: 'text/html' },
			external: true,
		};
		const message = this._draft
			? localize('agentHost.changeset.pr.createdDraft', "Created draft pull request [#{0}]({1}).", created.number, created.url)
			: localize('agentHost.changeset.pr.created', "Created pull request [#{0}]({1}).", created.number, created.url);

		return { message, followUp };
	}

	private _formatTitle(branchName: string): string {
		// Beautify a branch name like `feat/foo-bar` into `feat: foo bar`.
		const idx = branchName.indexOf('/');
		if (idx > 0 && idx < branchName.length - 1) {
			const prefix = branchName.substring(0, idx);
			const rest = branchName.substring(idx + 1).replace(/[-_]+/g, ' ');
			return `${prefix}: ${rest}`;
		}
		return branchName.replace(/[-_]+/g, ' ');
	}

	private _formatBody(branchName: string, baseBranchName: string, hasUncommitted: boolean): string {
		const lines: string[] = [];
		lines.push(`Created from \`${branchName}\` targeting \`${baseBranchName}\`.`);
		if (hasUncommitted) {
			lines.push('');
			lines.push('> ⚠ The working tree had uncommitted changes when this pull request was created; only committed work is included.');
		}
		return lines.join('\n');
	}
}

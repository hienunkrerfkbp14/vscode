/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentSession, IAgentSessionMetadata } from '../../common/agentService.js';
import { buildDefaultChangesetCatalogue, buildUncommittedChangesetUri } from '../../common/changesetUri.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { SessionStatus, type ISessionFileDiff } from '../../common/state/sessionState.js';
import { AgentConfigurationService } from '../../node/agentConfigurationService.js';
import { ChangesetSessionCoordinator, IChangesetSessionMetadata } from '../../node/agentHostChangesetCoordinator.js';
import { IAgentHostChangesetService, IPersistedChangesetMetadata, IRestoredChangesetDiffs, StaticChangesetKind } from '../../node/agentHostChangesetService.js';
import { IAgentHostFileMonitorOptions, IAgentHostFileMonitorService } from '../../node/agentHostFileMonitorService.js';
import { IAgentHostGitService } from '../../node/agentHostGitService.js';
import { AgentHostStateManager } from '../../node/agentHostStateManager.js';
import { createNoopGitService } from '../common/sessionTestHelpers.js';

suite('ChangesetSessionCoordinator', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createSession(stateManager: AgentHostStateManager, session: string, workingDirectory?: string, emitNotification = true): void {
		stateManager.createSession({
			resource: session,
			provider: 'mock',
			title: 'Test',
			status: SessionStatus.Idle,
			createdAt: Date.now(),
			modifiedAt: Date.now(),
			project: { uri: 'file:///test-project', displayName: 'Test Project' },
			workingDirectory,
			changesets: buildDefaultChangesetCatalogue(session),
		}, { emitNotification });
		stateManager.dispatchServerAction(session, { type: ActionType.SessionReady });
	}

	function createEnvironment(root: URI = URI.file('/repo')): {
		stateManager: AgentHostStateManager;
		changesets: TestChangesetService;
		monitor: TestFileMonitorService;
		gitService: IAgentHostGitService & { readonly rootLookupCalls: string[]; waitForRootLookups(count: number): Promise<void> };
		coordinator: ChangesetSessionCoordinator;
	} {
		const stateManager = disposables.add(new AgentHostStateManager(new NullLogService()));
		const configurationService = disposables.add(new AgentConfigurationService(stateManager, new NullLogService()));
		const changesets = new TestChangesetService();
		const monitor = disposables.add(new TestFileMonitorService());
		const gitService = createGitService(root);
		const coordinator = disposables.add(new ChangesetSessionCoordinator(stateManager, changesets, configurationService, monitor, gitService));
		return { stateManager, changesets, monitor, gitService, coordinator };
	}

	test('shares root watchers across sessions and fans out root changes', async () => {
		const firstSession = AgentSession.uri('mock', 'session-1').toString();
		const secondSession = AgentSession.uri('mock', 'session-2').toString();
		const root = URI.file('/repo');
		const environment = createEnvironment(root);
		createSession(environment.stateManager, firstSession, 'file:///repo/worktree-a');
		createSession(environment.stateManager, secondSession, 'file:///repo/worktree-b');

		environment.coordinator.onFirstSubscriber(URI.parse(firstSession));
		await environment.monitor.waitForAcquisitions(1);
		environment.coordinator.onFirstSubscriber(URI.parse(buildUncommittedChangesetUri(secondSession)));
		await environment.gitService.waitForRootLookups(2);
		await tick();

		environment.monitor.fire(root);
		await environment.changesets.waitForRootRefreshes(1);

		assert.deepStrictEqual({
			acquisitions: environment.monitor.acquisitions,
			rootRefreshes: environment.changesets.rootRefreshes,
		}, {
			acquisitions: ['file:///repo'],
			rootRefreshes: [{ root: 'file:///repo', sessions: [firstSession, secondSession] }],
		});
	});

	test('releases a root watcher after the last interested session unsubscribes', async () => {
		const firstSession = AgentSession.uri('mock', 'session-1').toString();
		const secondSession = AgentSession.uri('mock', 'session-2').toString();
		const environment = createEnvironment();
		createSession(environment.stateManager, firstSession, 'file:///repo/worktree-a');
		createSession(environment.stateManager, secondSession, 'file:///repo/worktree-b');

		environment.coordinator.onFirstSubscriber(URI.parse(firstSession));
		await environment.monitor.waitForAcquisitions(1);
		environment.coordinator.onFirstSubscriber(URI.parse(buildUncommittedChangesetUri(secondSession)));
		await environment.gitService.waitForRootLookups(2);
		await tick();

		environment.coordinator.onLastSubscriber(URI.parse(firstSession));
		assert.deepStrictEqual(environment.monitor.disposals, []);
		environment.coordinator.onLastSubscriber(URI.parse(buildUncommittedChangesetUri(secondSession)));
		assert.deepStrictEqual(environment.monitor.disposals, ['file:///repo']);
	});

	test('attaches deferred watch interest on materialization without re-querying an unchanged root', async () => {
		const session = AgentSession.uri('mock', 'session-1').toString();
		const environment = createEnvironment();
		createSession(environment.stateManager, session, undefined, false);

		environment.coordinator.onFirstSubscriber(URI.parse(buildUncommittedChangesetUri(session)));
		await tick();
		assert.deepStrictEqual({ acquisitions: environment.monitor.acquisitions, rootLookups: environment.gitService.rootLookupCalls }, { acquisitions: [], rootLookups: [] });

		const summary = environment.stateManager.getSessionState(session)!.summary;
		environment.stateManager.markSessionPersisted(session, { ...summary, workingDirectory: 'file:///repo/worktree' });
		environment.coordinator.onSessionMaterialized(session);
		await environment.monitor.waitForAcquisitions(1);

		environment.coordinator.onSessionMaterialized(session);
		await tick();

		assert.deepStrictEqual({ acquisitions: environment.monitor.acquisitions, rootLookups: environment.gitService.rootLookupCalls }, {
			acquisitions: ['file:///repo'],
			rootLookups: ['file:///repo/worktree'],
		});
	});
});

function createGitService(root: URI): IAgentHostGitService & { readonly rootLookupCalls: string[]; waitForRootLookups(count: number): Promise<void> } {
	const rootLookupCalls: string[] = [];
	const waiters: Array<{ count: number; deferred: DeferredPromise<void> }> = [];
	const releaseWaiters = () => {
		for (const waiter of [...waiters]) {
			if (rootLookupCalls.length >= waiter.count) {
				waiters.splice(waiters.indexOf(waiter), 1);
				void waiter.deferred.complete(undefined);
			}
		}
	};
	return {
		...createNoopGitService(),
		rootLookupCalls,
		async getRepositoryRoot(workingDirectory: URI): Promise<URI> {
			rootLookupCalls.push(workingDirectory.toString());
			releaseWaiters();
			return root;
		},
		waitForRootLookups(count: number): Promise<void> {
			if (rootLookupCalls.length >= count) {
				return Promise.resolve();
			}
			const deferred = new DeferredPromise<void>();
			waiters.push({ count, deferred });
			return deferred.p;
		},
	};
}

class TestFileMonitorService extends Disposable implements IAgentHostFileMonitorService {
	declare readonly _serviceBrand: undefined;

	readonly acquisitions: string[] = [];
	readonly disposals: string[] = [];
	private readonly _callbacks = new Map<string, Set<() => void>>();
	private readonly _acquisitionWaiters: Array<{ count: number; deferred: DeferredPromise<void> }> = [];

	acquire(folder: URI, callback: () => void, _options?: IAgentHostFileMonitorOptions): IDisposable {
		const root = folder.toString();
		this.acquisitions.push(root);
		let callbacks = this._callbacks.get(root);
		if (!callbacks) {
			callbacks = new Set<() => void>();
			this._callbacks.set(root, callbacks);
		}
		callbacks.add(callback);
		this._releaseAcquisitionWaiters();
		return toDisposable(() => {
			callbacks.delete(callback);
			this.disposals.push(root);
		});
	}

	fire(root: URI): void {
		for (const callback of this._callbacks.get(root.toString()) ?? []) {
			callback();
		}
	}

	waitForAcquisitions(count: number): Promise<void> {
		if (this.acquisitions.length >= count) {
			return Promise.resolve();
		}
		const deferred = new DeferredPromise<void>();
		this._acquisitionWaiters.push({ count, deferred });
		return deferred.p;
	}

	private _releaseAcquisitionWaiters(): void {
		for (const waiter of [...this._acquisitionWaiters]) {
			if (this.acquisitions.length >= waiter.count) {
				this._acquisitionWaiters.splice(this._acquisitionWaiters.indexOf(waiter), 1);
				void waiter.deferred.complete(undefined);
			}
		}
	}
}

class TestChangesetService implements IAgentHostChangesetService {
	declare readonly _serviceBrand: undefined;

	readonly rootRefreshes: Array<{ root: string; sessions: string[] }> = [];
	private readonly _rootRefreshWaiters: Array<{ count: number; deferred: DeferredPromise<void> }> = [];

	registerStaticChangesets(_session: string): void { }
	restoreStaticChangeset(_session: string, _kind: StaticChangesetKind, _diffs: readonly ISessionFileDiff[]): void { }
	restorePersistedStaticChangesets(_sessionUri: string, _metadata: IPersistedChangesetMetadata): IRestoredChangesetDiffs { return {}; }
	refreshUncommittedChangeset(_session: string): void { }
	refreshUncommittedChangesetsForRoot(repositoryRoot: URI, sessions: readonly string[]): void {
		this.rootRefreshes.push({ root: repositoryRoot.toString(), sessions: [...sessions] });
		this._releaseRootRefreshWaiters();
	}
	refreshSessionChangeset(_session: string): void { }
	async computeTurnChangeset(session: string, turnId: string): Promise<string> { return `${session}/changeset/turn/${turnId}`; }
	async computeCompareTurnsChangeset(session: string, originalTurnId: string, modifiedTurnId: string): Promise<string> { return `${session}/changeset/compare/${originalTurnId}/${modifiedTurnId}`; }
	onToolCallEditsApplied(_session: string, _turnId: string): void { }
	onTurnComplete(_session: string, _turnId: string | undefined): void { }
	onSessionTruncated(_session: string): void { }
	setTurnSubscriberProbe(_probe: (session: string, turnId: string) => boolean): void { }

	waitForRootRefreshes(count: number): Promise<void> {
		if (this.rootRefreshes.length >= count) {
			return Promise.resolve();
		}
		const deferred = new DeferredPromise<void>();
		this._rootRefreshWaiters.push({ count, deferred });
		return deferred.p;
	}

	private _releaseRootRefreshWaiters(): void {
		for (const waiter of [...this._rootRefreshWaiters]) {
			if (this.rootRefreshes.length >= waiter.count) {
				this._rootRefreshWaiters.splice(this._rootRefreshWaiters.indexOf(waiter), 1);
				void waiter.deferred.complete(undefined);
			}
		}
	}

	getListMetadataKeys(_sessionStr: string): Record<string, true> | undefined { return undefined; }
	decorateListEntry(entry: IAgentSessionMetadata, _metadata: IChangesetSessionMetadata): IAgentSessionMetadata { return entry; }
}

function tick(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

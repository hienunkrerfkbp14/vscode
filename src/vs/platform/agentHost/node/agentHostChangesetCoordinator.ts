/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../base/common/async.js';
import { Disposable, DisposableMap, IReference, ReferenceCollection } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IAgentSessionMetadata } from '../common/agentService.js';
import {
	buildSessionChangesetUri,
	buildUncommittedChangesetUri,
	ChangesetKind,
	parseChangesetUri,
} from '../common/changesetUri.js';
import { ChangesetStatus } from '../common/state/sessionState.js';
import { IAgentConfigurationService } from './agentConfigurationService.js';
import { DEFAULT_AGENT_HOST_WATCH_EXCLUDES, IAgentHostFileMonitorService } from './agentHostFileMonitorService.js';
import { IAgentHostGitService } from './agentHostGitService.js';
import { AgentHostStateManager } from './agentHostStateManager.js';
import {
	buildCatalogueFromLiveState,
	buildCatalogueFromPersistedDiffs,
	IAgentHostChangesetService,
	META_CHANGESET_SESSION,
	META_CHANGESET_UNCOMMITTED,
	META_LEGACY_DIFFS,
} from './agentHostChangesetService.js';

class WatchInterestReferenceCollection extends ReferenceCollection<string> {
	constructor(
		private readonly _create: (sessionStr: string) => void,
		private readonly _destroy: (sessionStr: string) => void,
	) {
		super();
	}

	protected createReferencedObject(sessionStr: string): string {
		this._create(sessionStr);
		return sessionStr;
	}

	protected destroyReferencedObject(sessionStr: string): void {
		this._destroy(sessionStr);
	}
}

/**
 * Raw metadata blob values for the session DB, batch-read by the caller.
 * Keys are the changeset-specific metadata keys ({@link META_CHANGESET_UNCOMMITTED}
 * etc.); values are the raw `string | undefined` payloads as returned by
 * `ISessionDatabase.getMetadataObject`.
 */
export type IChangesetSessionMetadata = Record<string, string | undefined>;

/**
 * The set of session-DB metadata keys the coordinator needs in a batched
 * read. {@link AgentService} merges these into its own metadata key set
 * before calling `getMetadataObject` so the DB is hit exactly once per
 * session, then hands the result to {@link ChangesetSessionCoordinator}'s
 * apply methods.
 */
export const CHANGESET_DB_METADATA_KEYS: Record<string, true> = {
	[META_CHANGESET_UNCOMMITTED]: true,
	[META_CHANGESET_SESSION]: true,
	[META_LEGACY_DIFFS]: true,
};

/**
 * Coordinator that encapsulates all `AgentService`-side orchestration of
 * the changeset feature. Sits between `AgentService` (which owns session
 * lifecycle / subscription refcounting / batched DB reads) and
 * {@link IAgentHostChangesetService} (which owns compute / publish /
 * persist primitives).
 *
 * Owns the deferred uncommitted-refresh state machine — refreshes that
 * fire before the session's working directory is known are queued and
 * drained from {@link onSessionMaterialized} / {@link onSessionRestored}.
 *
 * No per-session controllers — the cross-cutting concerns (listSessions
 * overlay, subscribe URI routing) inherently span sessions, so a single
 * coordinator with internal maps is simpler than per-session RAII.
 */
export class ChangesetSessionCoordinator extends Disposable {

	/**
	 * Sessions that subscribed to their uncommitted changeset before the
	 * working directory was known (provisional / not-yet-materialized
	 * sessions). Drained by {@link onSessionMaterialized} and
	 * {@link onSessionRestored} once the working directory is set.
	 */
	private readonly _pendingUncommittedRefreshes = new Set<string>();

	/**
	 * Per-session set of turn ids that have at least one live subscriber to
	 * `<sessionUri>/changeset/turn/<turnId>`. Drives the per-turn recompute
	 * gating: the changeset service only schedules a per-turn recompute when
	 * this set says someone is watching the turn URI (per-turn URIs have no
	 * catalogue chip aggregates, so recomputing for an unobserved turn is
	 * pure waste).
	 */
	private readonly _subscribedTurns = new Map<string, Set<string>>();

	/** Per-resource references into the per-session watch-interest collection. */
	private readonly _watchInterestReferences = this._register(new DisposableMap<string, IReference<string>>());
	private readonly _watchInterestCollection = new WatchInterestReferenceCollection(
		sessionStr => this._attachWatcherIfPossible(sessionStr),
		sessionStr => this._destroyWatchInterest(sessionStr),
	);
	/** Sessions waiting for materialization before a root watcher can attach. */
	private readonly _pendingWatchInterest = new Set<string>();
	/** Session URI string to the working directory that produced the current root attachment. */
	private readonly _sessionWorkingDirectory = new Map<string, string>();
	/** Session URI string to repository-root URI string. */
	private readonly _sessionRoot = new Map<string, string>();
	/** Repository-root URI string to sessions currently fanned out from that root. */
	private readonly _rootSessions = new Map<string, Set<string>>();
	/** Repository-root URI string to the shared monitor acquisition. */
	private readonly _rootWatchAcquisitions = this._register(new DisposableMap<string>());
	/** Repository-root URI string to parsed root URI, for root-level refresh calls. */
	private readonly _rootUris = new Map<string, URI>();
	private readonly _watchAttachmentSequencer = new SequencerByKey<string>();

	constructor(
		private readonly _stateManager: AgentHostStateManager,
		private readonly _changesets: IAgentHostChangesetService,
		private readonly _configurationService: IAgentConfigurationService,
		private readonly _fileMonitorService: IAgentHostFileMonitorService,
		private readonly _gitService: IAgentHostGitService,
	) {
		super();
		this._changesets.setTurnSubscriberProbe((session, turnId) => this.hasTurnSubscribers(session, turnId));
	}

	/**
	 * Returns `true` when at least one client is subscribed to
	 * `<session>/changeset/turn/<turnId>`. Consulted by the changeset
	 * service via the probe installed in the constructor.
	 */
	hasTurnSubscribers(session: string, turnId: string): boolean {
		return this._subscribedTurns.get(session)?.has(turnId) ?? false;
	}

	// ---- Lifecycle hooks ----------------------------------------------------

	/**
	 * Called at session create time. Registers the static changeset URIs
	 * on the state manager so client subscriptions resolve to a
	 * `status: computing` snapshot before the first compute pass.
	 *
	 * The catalogue summary (`summary.changesets`) is seeded synchronously
	 * by `_buildInitialSummary` in {@link AgentService} via
	 * {@link buildDefaultChangesetCatalogue}; this method only registers
	 * the backing per-changeset state. Both halves run before
	 * `SessionReady` is dispatched.
	 */
	onSessionCreated(sessionStr: string): void {
		this._changesets.registerStaticChangesets(sessionStr);
	}

	/**
	 * Called at session restore time. Registers the static changeset URIs
	 * and reseeds them from any persisted blobs already read from the DB.
	 * `metadata` must come from the same batched `getMetadataObject` call
	 * `AgentService` already issues for title / read / archive / config
	 * keys.
	 */
	onSessionRestored(sessionStr: string, metadata: IChangesetSessionMetadata): void {
		this._changesets.registerStaticChangesets(sessionStr);
		this._changesets.restorePersistedStaticChangesets(sessionStr, {
			uncommittedRaw: metadata[META_CHANGESET_UNCOMMITTED],
			sessionRaw: metadata[META_CHANGESET_SESSION],
			legacyRaw: metadata[META_LEGACY_DIFFS],
		});
		// `addSubscriber`'s 0→1 trigger may have fired before the session
		// state existed; now that `summary.workingDirectory` is populated,
		// drain the deferred refresh. Idempotent — the per-session
		// sequencer collapses overlapping computes.
		this._drainPendingRefresh(sessionStr);
		this._retryWatchAttachment(sessionStr);
	}

	/**
	 * Called when a provisional session is materialized (working directory
	 * becomes known). Drains any uncommitted refresh that was deferred
	 * because the working directory was not yet known.
	 */
	onSessionMaterialized(sessionStr: string): void {
		this._drainPendingRefresh(sessionStr);
		this._retryWatchAttachment(sessionStr);
	}

	/**
	 * Called when a session is disposed. Forgets any pending refresh
	 * queued for that session.
	 */
	onSessionDisposed(sessionStr: string): void {
		this._pendingUncommittedRefreshes.delete(sessionStr);
		this._subscribedTurns.delete(sessionStr);
		this._stopWatchInterest(buildUncommittedChangesetUri(sessionStr));
		this._stopWatchInterest(sessionStr);
		this._destroyWatchInterest(sessionStr);
	}

	// ---- Subscription hooks -------------------------------------------------

	/**
	 * Called on every `addSubscriber` 0→1 transition. When `resource` is
	 * the uncommitted changeset URI, triggers the first git-diff refresh
	 * (or queues it for later if the working directory is not yet known).
	 *
	 * Both {@link AgentService.subscribe} and the handshake fast-path
	 * (`ProtocolServerHandler.initialSubscriptions`) call into
	 * `addSubscriber`, so this single hook covers both paths.
	 */
	onFirstSubscriber(resource: URI): void {
		const resourceStr = resource.toString();
		const parsed = parseChangesetUri(resourceStr);
		if (parsed?.kind === ChangesetKind.Uncommitted) {
			this._triggerUncommittedRefresh(parsed.sessionUri);
			this._startWatchInterest(resourceStr, parsed.sessionUri);
			return;
		}
		if (parsed?.kind === ChangesetKind.Session) {
			// Session-changeset compute uses git when a working dir is
			// available and falls back to the SDK edit-tracker otherwise,
			// so it doesn't need the same deferral as uncommitted.
			this._changesets.refreshSessionChangeset(parsed.sessionUri);
			return;
		}
		if (parsed?.kind === ChangesetKind.Turn && parsed.turnId !== undefined) {
			// Track the new subscriber so the service's per-turn recompute
			// gating starts including this turn. The initial snapshot is
			// already produced by `tryHandleSubscribe → computeTurnChangeset`;
			// subsequent deltas flow from `onToolCallEditsApplied` /
			// `onTurnComplete` once we've added this turn id here.
			let set = this._subscribedTurns.get(parsed.sessionUri);
			if (!set) {
				set = new Set();
				this._subscribedTurns.set(parsed.sessionUri, set);
			}
			set.add(parsed.turnId);
			return;
		}
		if (!parsed && this._stateManager.getSessionState(resourceStr)) {
			// Plain session-URI subscription (Agents Window list / detail
			// observing the session). Refresh both static changesets so
			// the catalogue chip doesn't show a stale value just because
			// no turn has run since process start, no one ever subscribed
			// to the changeset URIs directly, and the user has been
			// editing files manually in the working tree.
			this._triggerUncommittedRefresh(resourceStr);
			this._changesets.refreshSessionChangeset(resourceStr);
			this._startWatchInterest(resourceStr, resourceStr);
		}
	}

	/**
	 * Called when a resource's last subscriber drops. Cleans up any
	 * deferred uncommitted refresh queued for that session — if no one is
	 * subscribed anymore, there's no point firing it on materialize.
	 */
	onLastSubscriber(resource: URI): void {
		const resourceStr = resource.toString();
		const parsed = parseChangesetUri(resourceStr);
		if (parsed?.kind === ChangesetKind.Uncommitted) {
			this._pendingUncommittedRefreshes.delete(parsed.sessionUri);
			this._stopWatchInterest(resourceStr);
			return;
		}
		if (parsed?.kind === ChangesetKind.Turn && parsed.turnId !== undefined) {
			const set = this._subscribedTurns.get(parsed.sessionUri);
			if (set) {
				set.delete(parsed.turnId);
				if (set.size === 0) {
					this._subscribedTurns.delete(parsed.sessionUri);
				}
			}
		}
		if (!parsed) {
			this._stopWatchInterest(resourceStr);
		}
	}

	/**
	 * If `resource` is a known changeset URI (uncommitted / session /
	 * turn), seeds its state on the state manager and returns `true`.
	 * Returns `false` for non-changeset URIs so callers fall through to
	 * their default routing (session / subagent / terminal).
	 *
	 * The parent session is restored via the provided `restoreSession`
	 * callback when no live state exists yet — this matches the previous
	 * inline behaviour in `AgentService.subscribe`.
	 *
	 * Throws when the URI matches the changeset shape but the id is not
	 * a well-known kind ({@link ChangesetKind.Unknown}). The unknown-id
	 * rejection MUST fire before any parent-session restore so subscribing
	 * to a bogus child URI cannot materialize the parent as a side effect.
	 */
	async tryHandleSubscribe(resource: URI, restoreSession: (session: URI) => Promise<void>): Promise<boolean> {
		const resourceStr = resource.toString();
		const parsed = parseChangesetUri(resourceStr);
		if (!parsed) {
			return false;
		}
		if (parsed.kind === ChangesetKind.Unknown) {
			throw new Error(`Cannot subscribe to unknown changeset resource: ${resourceStr}`);
		}
		if (!this._stateManager.getSessionState(parsed.sessionUri)) {
			await restoreSession(URI.parse(parsed.sessionUri));
		}
		if (parsed.kind === ChangesetKind.Turn && parsed.turnId) {
			await this._changesets.computeTurnChangeset(parsed.sessionUri, parsed.turnId);
		} else if (parsed.kind === ChangesetKind.Compare && parsed.originalTurnId && parsed.modifiedTurnId) {
			// Compare-turns is computed once on subscribe. Both turns are
			// typically historical so the snapshot doesn't need to track
			// live edits; `onFirstSubscriber` / `onLastSubscriber` do not
			// need to participate.
			await this._changesets.computeCompareTurnsChangeset(parsed.sessionUri, parsed.originalTurnId, parsed.modifiedTurnId);
		} else {
			// Static changesets are seeded by `onSessionRestored` /
			// `onSessionCreated`. Re-register defensively in case the
			// session was created in this process before the coordinator
			// existed. The uncommitted refresh itself is fired from
			// {@link onFirstSubscriber} on the 0→1 path.
			this._changesets.registerStaticChangesets(parsed.sessionUri);
		}
		return true;
	}

	// ---- listSessions overlay ----------------------------------------------

	/**
	 * Returns the session-DB metadata keys to merge into a batched read
	 * for `sessionStr`, OR `undefined` when live state already answers
	 * the catalogue question (so the caller can skip loading the
	 * potentially-large persisted blobs).
	 *
	 * Returning `undefined` is the fast path: live `summary.changesets`
	 * (loaded session) or a ready live changeset state (registered but
	 * not-yet-restored session) is authoritative.
	 */
	getListMetadataKeys(sessionStr: string): Record<string, true> | undefined {
		if (this._readyLiveCatalogueExists(sessionStr)) {
			return undefined;
		}
		const liveSessionState = this._stateManager.getSessionState(sessionStr);
		if (liveSessionState?.summary.changesets) {
			return undefined;
		}
		return CHANGESET_DB_METADATA_KEYS;
	}

	/**
	 * Decorates a single listSessions entry with the catalogue overlay.
	 * `metadata` is the already-batched DB read; if it lacks the
	 * changeset keys (because {@link getListMetadataKeys} returned
	 * `undefined`), this method falls through to synthesising the
	 * catalogue from live state.
	 *
	 * Precedence: live `summary.changesets` > ready live changeset state
	 * > parsed persisted blobs > undefined (no catalogue advertised).
	 * This mirrors the inline pre-coordinator logic.
	 */
	decorateListEntry(entry: IAgentSessionMetadata, metadata: IChangesetSessionMetadata): IAgentSessionMetadata {
		const sessionStr = entry.session.toString();
		const liveSessionState = this._stateManager.getSessionState(sessionStr);
		const liveUncommitted = this._stateManager.getChangesetState(buildUncommittedChangesetUri(sessionStr));
		const liveSession = this._stateManager.getChangesetState(buildSessionChangesetUri(sessionStr));
		const hasReadyLiveCatalogue = liveUncommitted?.status === ChangesetStatus.Ready
			|| liveSession?.status === ChangesetStatus.Ready;

		// Ready live state for an unopened session: synthesise the catalogue
		// from that live state. Counts stay in lockstep with the actual
		// changeset state for the session-list chip.
		if (!liveSessionState && hasReadyLiveCatalogue) {
			const catalogue = buildCatalogueFromLiveState(sessionStr, liveUncommitted, liveSession);
			if (catalogue) {
				return { ...entry, changesets: catalogue };
			}
			return entry;
		}

		// No live source — try persisted blobs (if the caller batched them).
		const uncommittedRaw = metadata[META_CHANGESET_UNCOMMITTED];
		const sessionRaw = metadata[META_CHANGESET_SESSION];
		const legacyRaw = metadata[META_LEGACY_DIFFS];
		if (uncommittedRaw === undefined && sessionRaw === undefined && legacyRaw === undefined) {
			return entry;
		}
		const restored = this._changesets.restorePersistedStaticChangesets(sessionStr, {
			uncommittedRaw,
			sessionRaw,
			legacyRaw,
		});
		// `restorePersistedStaticChangesets` seeds the state manager; the
		// catalogue itself is built here for unopened sessions only. Once
		// the session is opened via `restoreSession`, the live overlay in
		// `AgentService.listSessions` replaces this.
		if (!liveSessionState) {
			const catalogue = buildCatalogueFromPersistedDiffs(sessionStr, restored.uncommitted, restored.session);
			if (catalogue) {
				return { ...entry, changesets: catalogue };
			}
		}
		return entry;
	}

	// ---- Internal -----------------------------------------------------------

	private _readyLiveCatalogueExists(sessionStr: string): boolean {
		const uncommitted = this._stateManager.getChangesetState(buildUncommittedChangesetUri(sessionStr));
		if (uncommitted?.status === ChangesetStatus.Ready) {
			return true;
		}
		const session = this._stateManager.getChangesetState(buildSessionChangesetUri(sessionStr));
		return session?.status === ChangesetStatus.Ready;
	}

	/**
	 * Triggers the first uncommitted refresh for `sessionStr`, deferring
	 * it until materialization when the working directory is not yet
	 * known.
	 *
	 * Firing the refresh before the session is materialized would compute
	 * against a missing working directory, the git path would bail, and
	 * the edit-tracker fallback would silently rebrand SDK-tracked edits
	 * as `git status` output. Deferring keeps that whole class of bug
	 * closed.
	 */
	private _triggerUncommittedRefresh(sessionStr: string): void {
		const wd = this._configurationService.getEffectiveWorkingDirectory(sessionStr);
		if (!wd) {
			this._pendingUncommittedRefreshes.add(sessionStr);
			return;
		}
		this._changesets.refreshUncommittedChangeset(sessionStr);
	}

	private _drainPendingRefresh(sessionStr: string): void {
		if (this._pendingUncommittedRefreshes.delete(sessionStr)) {
			this._triggerUncommittedRefresh(sessionStr);
		}
	}

	private _startWatchInterest(resourceStr: string, sessionStr: string): void {
		if (!this._watchInterestReferences.has(resourceStr)) {
			this._watchInterestReferences.set(resourceStr, this._watchInterestCollection.acquire(sessionStr));
		}
	}

	private _stopWatchInterest(resourceStr: string): void {
		this._watchInterestReferences.deleteAndDispose(resourceStr);
	}

	private _destroyWatchInterest(sessionStr: string): void {
		this._pendingWatchInterest.delete(sessionStr);
		this._releaseSessionRoot(sessionStr);
	}

	private _retryWatchAttachment(sessionStr: string): void {
		if (this._hasWatchInterest(sessionStr) || this._pendingWatchInterest.has(sessionStr)) {
			this._attachWatcherIfPossible(sessionStr);
		}
	}

	private _hasWatchInterest(sessionStr: string): boolean {
		return this._watchInterestReferences.has(sessionStr) || this._watchInterestReferences.has(buildUncommittedChangesetUri(sessionStr));
	}

	private _attachWatcherIfPossible(sessionStr: string): void {
		this._watchAttachmentSequencer.queue(sessionStr, async () => {
			if (!this._hasWatchInterest(sessionStr)) {
				return;
			}
			const workingDirectory = this._configurationService.getEffectiveWorkingDirectory(sessionStr);
			if (!workingDirectory) {
				this._pendingWatchInterest.add(sessionStr);
				this._releaseSessionRoot(sessionStr);
				return;
			}
			let workingDirectoryUri: URI;
			try {
				workingDirectoryUri = URI.parse(workingDirectory);
			} catch {
				this._pendingWatchInterest.add(sessionStr);
				this._releaseSessionRoot(sessionStr);
				return;
			}
			if (this._sessionRoot.has(sessionStr) && this._sessionWorkingDirectory.get(sessionStr) === workingDirectory) {
				this._pendingWatchInterest.delete(sessionStr);
				return;
			}
			const repositoryRoot = await this._gitService.getRepositoryRoot(workingDirectoryUri);
			if (!this._hasWatchInterest(sessionStr)) {
				return;
			}
			if (!repositoryRoot) {
				this._pendingWatchInterest.delete(sessionStr);
				this._releaseSessionRoot(sessionStr);
				return;
			}
			this._pendingWatchInterest.delete(sessionStr);
			this._attachSessionToRoot(sessionStr, repositoryRoot, workingDirectory);
		});
	}

	private _attachSessionToRoot(sessionStr: string, repositoryRoot: URI, workingDirectory: string): void {
		const rootStr = repositoryRoot.toString();
		if (this._sessionRoot.get(sessionStr) === rootStr) {
			this._sessionWorkingDirectory.set(sessionStr, workingDirectory);
			return;
		}
		this._releaseSessionRoot(sessionStr);
		let sessions = this._rootSessions.get(rootStr);
		if (!sessions) {
			sessions = new Set<string>();
			this._rootSessions.set(rootStr, sessions);
			this._rootUris.set(rootStr, repositoryRoot);
			this._rootWatchAcquisitions.set(rootStr, this._fileMonitorService.acquire(repositoryRoot, () => this._onRootChanged(rootStr), {
				excludes: DEFAULT_AGENT_HOST_WATCH_EXCLUDES,
				debounceMs: 750,
			}));
		}
		sessions.add(sessionStr);
		this._sessionRoot.set(sessionStr, rootStr);
		this._sessionWorkingDirectory.set(sessionStr, workingDirectory);
	}

	private _releaseSessionRoot(sessionStr: string): void {
		const rootStr = this._sessionRoot.get(sessionStr);
		if (!rootStr) {
			this._sessionWorkingDirectory.delete(sessionStr);
			return;
		}
		this._sessionRoot.delete(sessionStr);
		this._sessionWorkingDirectory.delete(sessionStr);
		const sessions = this._rootSessions.get(rootStr);
		if (!sessions) {
			return;
		}
		sessions.delete(sessionStr);
		if (sessions.size === 0) {
			this._rootSessions.delete(rootStr);
			this._rootUris.delete(rootStr);
			this._rootWatchAcquisitions.deleteAndDispose(rootStr);
		}
	}

	private _onRootChanged(rootStr: string): void {
		const root = this._rootUris.get(rootStr);
		const sessions = this._rootSessions.get(rootStr);
		if (!root || !sessions || sessions.size === 0) {
			return;
		}
		const activeSessions = [...sessions].filter(session => {
			return this._hasWatchInterest(session)
				&& this._sessionRoot.get(session) === rootStr
				&& !!this._stateManager.getSessionState(session);
		});
		if (activeSessions.length === 0) {
			return;
		}
		this._changesets.refreshUncommittedChangesetsForRoot(root, activeSessions);
	}
}

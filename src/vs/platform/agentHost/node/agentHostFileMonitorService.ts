/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../base/common/async.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { FileChangesEvent, IFileService } from '../../files/common/files.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';

export const IAgentHostFileMonitorService = createDecorator<IAgentHostFileMonitorService>('agentHostFileMonitorService');

export const DEFAULT_AGENT_HOST_WATCH_EXCLUDES: readonly string[] = Object.freeze([
	'**/.git/objects/**',
	'**/.git/subtree-cache/**',
	'**/.git/**/*.lock',
	'**/.hg/store/**',
	'**/*.watchman-cookie-*',
]);

export interface IAgentHostFileMonitorOptions {
	readonly excludes?: readonly string[];
	readonly debounceMs?: number;
}

export interface IAgentHostFileMonitorService extends IDisposable {
	readonly _serviceBrand: undefined;
	acquire(folder: URI, callback: () => void, options?: IAgentHostFileMonitorOptions): IDisposable;
}

interface IMonitorEntry {
	readonly folder: URI;
	readonly callbacks: Set<() => void>;
	readonly debounce: MutableDisposable<IDisposable>;
	readonly debounceMs: number;
	readonly excludes: readonly string[];
	readonly disposable: IDisposable;
}

function normalizeExcludes(excludes: readonly string[]): readonly string[] {
	return [...excludes].sort();
}

export class AgentHostFileMonitorService extends Disposable implements IAgentHostFileMonitorService {
	declare readonly _serviceBrand: undefined;

	private static readonly _DEFAULT_DEBOUNCE_MS = 750;

	private readonly _entries = new Map<string, IMonitorEntry>();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._fileService.onDidWatchError(error => {
			this._logService.warn('[AgentHostFileMonitorService] File watcher error', error);
		}));
	}

	acquire(folder: URI, callback: () => void, options: IAgentHostFileMonitorOptions = {}): IDisposable {
		const excludes = normalizeExcludes(options.excludes ?? DEFAULT_AGENT_HOST_WATCH_EXCLUDES);
		const debounceMs = options.debounceMs ?? AgentHostFileMonitorService._DEFAULT_DEBOUNCE_MS;
		const key = this._key(folder, excludes, debounceMs);

		let entry = this._entries.get(key);
		if (!entry) {
			try {
				entry = this._createEntry(key, folder, excludes, debounceMs);
			} catch (err) {
				this._logService.warn(`[AgentHostFileMonitorService] Failed to watch ${folder.toString()}`, err);
				return Disposable.None;
			}
			this._entries.set(key, entry);
		}

		entry.callbacks.add(callback);
		return toDisposable(() => {
			const current = this._entries.get(key);
			if (!current) {
				return;
			}
			current.callbacks.delete(callback);
			if (current.callbacks.size === 0) {
				current.disposable.dispose();
				this._entries.delete(key);
			}
		});
	}

	private _createEntry(key: string, folder: URI, excludes: readonly string[], debounceMs: number): IMonitorEntry {
		const disposable = new DisposableStore();
		try {
			const debounce = disposable.add(new MutableDisposable<IDisposable>());
			const callbacks = new Set<() => void>();
			disposable.add(this._fileService.watch(folder, { recursive: true, excludes: [...excludes] }));
			disposable.add(this._fileService.onDidFilesChange(event => this._onDidFilesChange(key, event)));
			return { folder, callbacks, debounce, debounceMs, excludes, disposable };
		} catch (err) {
			disposable.dispose();
			throw err;
		}
	}

	private _onDidFilesChange(key: string, event: FileChangesEvent): void {
		const entry = this._entries.get(key);
		if (!entry || entry.callbacks.size === 0) {
			return;
		}
		if (!event.affects(entry.folder) || !this._hasRelevantRawChange(entry, event)) {
			return;
		}
		entry.debounce.value = disposableTimeout(() => {
			entry.debounce.clear();
			for (const callback of [...entry.callbacks]) {
				try {
					callback();
				} catch (err) {
					this._logService.warn('[AgentHostFileMonitorService] Folder change callback failed', err);
				}
			}
		}, entry.debounceMs);
	}

	private _hasRelevantRawChange(entry: IMonitorEntry, event: FileChangesEvent): boolean {
		for (const resource of [...event.rawAdded, ...event.rawUpdated, ...event.rawDeleted]) {
			if (!extUriBiasedIgnorePathCase.isEqualOrParent(resource, entry.folder)) {
				continue;
			}
			if (!this._isNoise(resource)) {
				return true;
			}
		}
		return false;
	}

	private _isNoise(resource: URI): boolean {
		const path = resource.path;
		if (path.includes('/.git/objects/') || path.includes('/.git/subtree-cache/') || path.includes('/.hg/store/')) {
			return true;
		}
		if (path.includes('/.git/') && path.endsWith('.lock')) {
			return true;
		}
		const name = path.substring(path.lastIndexOf('/') + 1);
		return name.includes('.watchman-cookie-');
	}

	private _key(folder: URI, excludes: readonly string[], debounceMs: number): string {
		return `${folder.toString()}\u0000${debounceMs}\u0000${excludes.join('\n')}`;
	}
}

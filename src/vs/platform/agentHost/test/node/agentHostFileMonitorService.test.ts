/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FileChangesEvent, FileChangeType, IFileService } from '../../../files/common/files.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentHostFileMonitorService } from '../../node/agentHostFileMonitorService.js';

suite('AgentHostFileMonitorService', () => {

	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shares one recursive watcher per folder/options and refcounts callbacks', () => {
		return runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fileService = new TestFileService();
			const monitor = disposables.add(new AgentHostFileMonitorService(fileService.service, new NullLogService()));
			const folder = URI.file('/repo');
			let first = 0;
			let second = 0;

			const firstRegistration = monitor.acquire(folder, () => first++, { debounceMs: 10 });
			const secondRegistration = monitor.acquire(folder, () => second++, { debounceMs: 10 });
			assert.deepStrictEqual(fileService.snapshot(), { watches: 1, disposed: 0 });

			fileService.fire(URI.file('/repo/src/a.ts'));
			await timeout(11);
			assert.deepStrictEqual({ first, second }, { first: 1, second: 1 });

			firstRegistration.dispose();
			fileService.fire(URI.file('/repo/src/b.ts'));
			await timeout(11);
			assert.deepStrictEqual({ first, second, snapshot: fileService.snapshot() }, { first: 1, second: 2, snapshot: { watches: 1, disposed: 0 } });

			secondRegistration.dispose();
			assert.deepStrictEqual(fileService.snapshot(), { watches: 1, disposed: 1 });
		});
	});

	test('filters known repository metadata noise before debouncing', () => {
		return runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 10_000 }, async () => {
			const fileService = new TestFileService();
			const monitor = disposables.add(new AgentHostFileMonitorService(fileService.service, new NullLogService()));
			let calls = 0;

			disposables.add(monitor.acquire(URI.file('/repo'), () => calls++, { debounceMs: 10 }));
			fileService.fire(URI.file('/repo/.git/objects/12/abcdef'));
			fileService.fire(URI.file('/repo/.git/index.lock'));
			fileService.fire(URI.file('/repo/.watchman-cookie-123'));
			await timeout(11);
			assert.strictEqual(calls, 0);

			fileService.fire(URI.file('/repo/src/a.ts'));
			await timeout(11);
			assert.strictEqual(calls, 1);
		});
	});

	test('sorts excludes when sharing watchers', () => {
		const fileService = new TestFileService();
		const monitor = disposables.add(new AgentHostFileMonitorService(fileService.service, new NullLogService()));
		const folder = URI.file('/repo');

		disposables.add(monitor.acquire(folder, () => { }, { excludes: ['**/b/**', '**/a/**'], debounceMs: 10 }));
		disposables.add(monitor.acquire(folder, () => { }, { excludes: ['**/a/**', '**/b/**'], debounceMs: 10 }));

		assert.deepStrictEqual(fileService.snapshot(), { watches: 1, disposed: 0 });
	});

	test('cleans up a partially-created watcher when listener registration fails', () => {
		const fileService = new TestFileService();
		fileService.throwOnDidFilesChangeListen = true;
		const monitor = disposables.add(new AgentHostFileMonitorService(fileService.service, new NullLogService()));

		const failedRegistration = monitor.acquire(URI.file('/repo'), () => { }, { debounceMs: 10 });
		failedRegistration.dispose();

		assert.deepStrictEqual(fileService.snapshot(), { watches: 1, disposed: 1 });
	});
});

class TestFileService {
	private readonly _onDidFilesChange = new Emitter<FileChangesEvent>();
	private readonly _onDidWatchError = new Emitter<Error>();
	private _watchCount = 0;
	private _disposeCount = 0;
	throwOnDidFilesChangeListen = false;

	private readonly _onDidFilesChangeEvent: Event<FileChangesEvent> = (listener, thisArgs, disposables) => {
		if (this.throwOnDidFilesChangeListen) {
			throw new Error('listener failed');
		}
		return this._onDidFilesChange.event(listener, thisArgs, disposables);
	};

	readonly service = {
		_serviceBrand: undefined,
		onDidChangeFileSystemProviderRegistrations: Event.None,
		onDidChangeFileSystemProviderCapabilities: Event.None,
		onWillActivateFileSystemProvider: Event.None,
		onDidFilesChange: this._onDidFilesChangeEvent,
		onDidWatchError: this._onDidWatchError.event,
		watch: (_resource: URI, _options?: Parameters<IFileService['watch']>[1]): IDisposable => {
			this._watchCount++;
			return toDisposable(() => this._disposeCount++);
		},
		dispose: () => { },
	} as Partial<IFileService> as IFileService;

	fire(resource: URI, type: FileChangeType = FileChangeType.UPDATED): void {
		this._onDidFilesChange.fire(new FileChangesEvent([{ resource, type }], false));
	}

	snapshot(): { watches: number; disposed: number } {
		return { watches: this._watchCount, disposed: this._disposeCount };
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parseGitHubRepoFromRemoteUrl } from '../../common/githubRemote.js';

suite('parseGitHubRepoFromRemoteUrl', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses every supported shape and rejects invalid input', () => {
		const cases: Array<{ input: string | undefined; expected: { owner: string; repo: string } | undefined }> = [
			// HTTPS — with and without .git, trailing slash, scheme casing.
			{ input: 'https://github.com/microsoft/vscode', expected: { owner: 'microsoft', repo: 'vscode' } },
			{ input: 'https://github.com/microsoft/vscode.git', expected: { owner: 'microsoft', repo: 'vscode' } },
			{ input: 'https://github.com/microsoft/vscode/', expected: { owner: 'microsoft', repo: 'vscode' } },
			{ input: 'HTTPS://GITHUB.COM/microsoft/vscode.git', expected: { owner: 'microsoft', repo: 'vscode' } },
			{ input: 'http://github.com/microsoft/vscode', expected: { owner: 'microsoft', repo: 'vscode' } },
			// SSH — with and without .git, trailing slash.
			{ input: 'git@github.com:microsoft/vscode', expected: { owner: 'microsoft', repo: 'vscode' } },
			{ input: 'git@github.com:microsoft/vscode.git', expected: { owner: 'microsoft', repo: 'vscode' } },
			// Whitespace tolerance.
			{ input: '  https://github.com/o/r.git  ', expected: { owner: 'o', repo: 'r' } },
			// Rejections.
			{ input: '', expected: undefined },
			{ input: undefined, expected: undefined },
			{ input: 'https://gitlab.com/o/r.git', expected: undefined },
			{ input: 'https://github.com/onlyowner', expected: undefined },
			{ input: 'ssh://git@github.com/o/r.git', expected: undefined },
			{ input: 'https://example.com/github.com/o/r.git', expected: undefined },
		];

		const actual = cases.map(c => ({ input: c.input, actual: parseGitHubRepoFromRemoteUrl(c.input) }));
		const expected = cases.map(c => ({ input: c.input, actual: c.expected }));
		assert.deepStrictEqual(actual, expected);
	});
});

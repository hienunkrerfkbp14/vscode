/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IGitHubRepoCoordinates {
	readonly owner: string;
	readonly repo: string;
}

/**
 * Parses a git remote URL pointing at github.com and returns the
 * `owner` / `repo` it identifies. Handles both supported transports:
 *
 * - HTTPS: `https://github.com/<owner>/<repo>(.git)?`
 * - SSH:   `git@github.com:<owner>/<repo>(.git)?`
 *
 * Returns `undefined` for URLs that don't match either shape (including
 * non-github.com hosts — GHE is out of scope for v1).
 */
export function parseGitHubRepoFromRemoteUrl(remoteUrl: string | undefined): IGitHubRepoCoordinates | undefined {
	if (!remoteUrl) {
		return undefined;
	}
	const trimmed = remoteUrl.trim();
	// HTTPS — github.com/<owner>/<repo>(.git)?
	const httpsMatch = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s.]+)(?:\.git)?\/?$/i.exec(trimmed);
	if (httpsMatch) {
		return { owner: httpsMatch[1], repo: httpsMatch[2] };
	}
	// SSH — git@github.com:<owner>/<repo>(.git)?
	const sshMatch = /^git@github\.com:([^/\s]+)\/([^/\s.]+)(?:\.git)?\/?$/i.exec(trimmed);
	if (sshMatch) {
		return { owner: sshMatch[1], repo: sshMatch[2] };
	}
	return undefined;
}

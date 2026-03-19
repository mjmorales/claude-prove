import { execFile } from 'node:child_process';

/**
 * Interface for fetching file content at a given git ref.
 * Designed for extensibility: swap in EmbeddedDiffSource or
 * RemoteDiffSource for detached (non-git) review scenarios.
 */
export interface DiffContentSource {
  getContent(ref: string, filePath: string): Promise<string>;
}

/**
 * Fetches file content from the local git repository using `git show`.
 */
export class LocalGitSource implements DiffContentSource {
  constructor(private readonly workspaceRoot: string) {}

  getContent(ref: string, filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['show', `${ref}:${filePath}`],
        { cwd: this.workspaceRoot, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(new Error(`git show ${ref}:${filePath} failed: ${error.message}`));
          } else {
            resolve(stdout);
          }
        },
      );
    });
  }
}

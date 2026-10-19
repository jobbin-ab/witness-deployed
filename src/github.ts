/**
 * The two things the step asks GitHub: which commit the previous successful run of this
 * workflow deployed, and which commits lie between that and this one. Both come from the
 * API, so the job needs no checkout and no history depth.
 */
import type { Commit, Run } from './lib.ts';
import type { Fetch } from './witness.ts';

export type GitHubContext = Run & {
  apiUrl: string;
  /** `owner/repo/.github/workflows/deploy.yml@refs/heads/main` — GitHub's own form. */
  workflowRef: string;
  refName: string;
  token: string;
};

export class GitHub {
  constructor(
    private readonly ctx: GitHubContext,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
  ) {}

  /**
   * The head sha of the latest successful run of this workflow on this branch, which is
   * the previous deploy. Null when there is none, when it is this very commit, or when the
   * token may not read runs — the caller then takes the head commit alone and says so.
   */
  async previousDeploySha(): Promise<{ sha: string; runNumber: number } | null | 'forbidden'> {
    const file = workflowFile(this.ctx.workflowRef);
    if (!file) return null;
    const url =
      `${this.ctx.apiUrl}/repos/${this.ctx.repository}/actions/workflows/${encodeURIComponent(file)}/runs` +
      `?status=success&branch=${encodeURIComponent(this.ctx.refName)}&per_page=5`;
    const res = await this.get<{ workflow_runs: { head_sha: string; run_number: number }[] }>(url);
    if (res === 'forbidden' || res === null) return res === null ? null : 'forbidden';
    const previous = res.workflow_runs.find((r) => r.head_sha !== this.ctx.sha);
    return previous ? { sha: previous.head_sha, runNumber: previous.run_number } : null;
  }

  /** The commits after `base` up to this run's commit, oldest first. Null when base is unknown to GitHub. */
  async commitsSince(base: string): Promise<Commit[] | null> {
    const url = `${this.ctx.apiUrl}/repos/${this.ctx.repository}/compare/${base}...${this.ctx.sha}?per_page=250`;
    const res = await this.get<{ commits: { sha: string; commit: { message: string } }[] }>(url, [404, 422]);
    if (res === 'forbidden' || res === null) return null;
    return res.commits.map((c) => ({ sha: c.sha, message: c.commit.message }));
  }

  /** This run's commit alone. */
  async headCommit(): Promise<Commit> {
    const url = `${this.ctx.apiUrl}/repos/${this.ctx.repository}/commits/${this.ctx.sha}`;
    const res = await this.get<{ sha: string; commit: { message: string } }>(url);
    if (res === 'forbidden' || res === null) throw new Error('the token cannot read this repository\'s commits');
    return { sha: res.sha, message: res.commit.message };
  }

  private async get<T>(url: string, nullOn: number[] = []): Promise<T | null | 'forbidden'> {
    const res = await this.fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.ctx.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 401 || res.status === 403) return 'forbidden';
    if (nullOn.includes(res.status)) return null;
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url.replace(this.ctx.apiUrl, '')}`);
    return (await res.json()) as T;
  }
}

/** `deploy.yml` out of `owner/repo/.github/workflows/deploy.yml@refs/heads/main`. */
export function workflowFile(workflowRef: string): string | null {
  const m = /\.github\/workflows\/([^@]+)@/.exec(workflowRef);
  return m?.[1] ?? null;
}

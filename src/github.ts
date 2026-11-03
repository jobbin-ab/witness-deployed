/**
 * What the step asks GitHub: which commit the previous successful run of this workflow
 * deployed, which commits lie between that and this one, and which pull requests those
 * commits came from. All of it comes from the API, so the job needs no checkout and no
 * history depth.
 */
import type { Commit, PullRequest, Run } from './lib.ts';
import type { Fetch } from './witness.ts';

export type GitHubContext = Run & {
  apiUrl: string;
  /** GitHub's GraphQL endpoint; `<apiUrl>/graphql` when not given, as on github.com. */
  graphqlUrl?: string;
  /** `owner/repo/.github/workflows/deploy.yml@refs/heads/main` — GitHub's own form. */
  workflowRef: string;
  refName: string;
  token: string;
};

/**
 * GitHub's rate limit for this token is spent. Its own error, not a refusal: a token that
 * may read something is told to wait, not to ask for a permission it already has.
 */
export class GitHubRateLimited extends Error {
  constructor(readonly resetAt: Date | null) {
    const when = resetAt ? ` (it resets at ${resetAt.toISOString().slice(11, 16)} UTC)` : '';
    super(`GitHub's API rate limit for this token was reached${when}`);
  }
}

/** The most commits one GraphQL query asks about: GitHub's own page size. */
export const PULLS_PER_QUERY = 100;

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

  /**
   * The commits after `base` up to this run's commit, oldest first. Null when base is
   * unknown to GitHub. The compare endpoint pages its commits at most 100 at a time, and
   * once paged it has no 250-commit ceiling, so every page is followed until the range's
   * `total_commits` is in hand: a long range loses no commit.
   */
  async commitsSince(base: string): Promise<Commit[] | null> {
    const commits: Commit[] = [];
    for (let page = 1; ; page++) {
      const url = `${this.ctx.apiUrl}/repos/${this.ctx.repository}/compare/${base}...${this.ctx.sha}?per_page=100&page=${page}`;
      const res = await this.get<{ total_commits: number; commits: { sha: string; commit: { message: string } }[] }>(url, [404, 422]);
      if (res === 'forbidden' || res === null) return page === 1 ? null : commits;
      commits.push(...res.commits.map((c) => ({ sha: c.sha, message: c.commit.message })));
      if (res.commits.length < 100 || commits.length >= res.total_commits) return commits;
    }
  }

  /**
   * The pull requests the commits came from, with their descriptions, in one GraphQL query
   * for up to {@link PULLS_PER_QUERY} commits: the merged one that brought each to the
   * default branch, and off it the open ones that carry it. A pull request several commits
   * share comes back once per commit; the caller keeps it once. `forbidden` when the token
   * may not read pull requests — a private repository whose job lacks `pull-requests: read`
   * — whether GitHub says so with a 401, 403 or 404, or with a FORBIDDEN or NOT_FOUND error.
   */
  async pullRequestsOf(shas: readonly string[]): Promise<PullRequest[] | 'forbidden'> {
    if (shas.length > PULLS_PER_QUERY) throw new Error(`at most ${PULLS_PER_QUERY} commits a query`);
    const [owner, name] = this.ctx.repository.split('/');
    const params = shas.map((_, i) => `$c${i}: GitObjectID!`).join(', ');
    const fields = shas
      .map((_, i) => `c${i}: object(oid: $c${i}) { ... on Commit { associatedPullRequests(first: 10) { nodes { number body } } } }`)
      .join(' ');
    const query = `query($owner: String!, $name: String!, ${params}) { repository(owner: $owner, name: $name) { ${fields} } }`;
    const variables: Record<string, string> = { owner: owner ?? '', name: name ?? '' };
    shas.forEach((sha, i) => (variables[`c${i}`] = sha));

    type Answer = {
      data?: { repository: Record<string, { associatedPullRequests?: { nodes: { number: number; body: string | null }[] } } | null> | null } | null;
      errors?: { type?: string; message: string }[];
    };
    const res = await this.request<Answer>(this.ctx.graphqlUrl ?? `${this.ctx.apiUrl}/graphql`, {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
    }, [404]);
    if (res === 'forbidden' || res === null) return 'forbidden';
    const errors = res.errors ?? [];
    if (errors.some((e) => e.type === 'RATE_LIMITED')) throw new GitHubRateLimited(null);
    // A token that may not see pull requests is refused outright, or — when it may not see
    // the repository through GraphQL at all — told the repository does not exist.
    if (errors.some((e) => e.type === 'FORBIDDEN' || e.type === 'NOT_FOUND')) return 'forbidden';
    const repository = res.data?.repository;
    if (!repository) throw new Error(errors[0]?.message ?? 'GitHub answered no repository');
    return Object.values(repository).flatMap((commit) =>
      (commit?.associatedPullRequests?.nodes ?? []).map((p) => ({ number: p.number, body: p.body ?? '' })),
    );
  }

  /** This run's commit alone. */
  async headCommit(): Promise<Commit> {
    const url = `${this.ctx.apiUrl}/repos/${this.ctx.repository}/commits/${this.ctx.sha}`;
    const res = await this.get<{ sha: string; commit: { message: string } }>(url);
    if (res === 'forbidden' || res === null) throw new Error('the token cannot read this repository\'s commits');
    return { sha: res.sha, message: res.commit.message };
  }

  private get<T>(url: string, nullOn: number[] = []): Promise<T | null | 'forbidden'> {
    return this.request<T>(url, {}, nullOn);
  }

  /**
   * One call. A spent rate limit throws {@link GitHubRateLimited}: GitHub answers it with
   * 429, or with 403 and either no requests left or a `retry-after` — the same 403 a
   * refusal uses, told apart only by those headers. Any other 401 or 403 is `forbidden`.
   */
  private async request<T>(url: string, init: { method?: string; body?: string }, nullOn: number[] = []): Promise<T | null | 'forbidden'> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.ctx.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (rateLimited(res)) throw new GitHubRateLimited(resetAt(res));
    if (res.status === 401 || res.status === 403) return 'forbidden';
    if (nullOn.includes(res.status)) return null;
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url.replace(this.ctx.apiUrl, '')}`);
    return (await res.json()) as T;
  }
}

function rateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  return res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after');
}

/** When the limit lifts: `retry-after` seconds from now, or the `x-ratelimit-reset` epoch. */
function resetAt(res: Response): Date | null {
  const after = Number(res.headers.get('retry-after'));
  if (res.headers.has('retry-after') && Number.isFinite(after)) return new Date(Date.now() + after * 1000);
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  return res.headers.has('x-ratelimit-reset') && Number.isFinite(reset) ? new Date(reset * 1000) : null;
}

/** `deploy.yml` out of `owner/repo/.github/workflows/deploy.yml@refs/heads/main`. */
export function workflowFile(workflowRef: string): string | null {
  const m = /\.github\/workflows\/([^@]+)@/.exec(workflowRef);
  return m?.[1] ?? null;
}

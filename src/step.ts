/**
 * The step itself, with its two clients handed in so a test can run it against a real
 * project and a stand-in GitHub. It never throws for a card: what a card refuses is a line
 * in the summary, and the next card is still written.
 */
import { actor as actorFor, commentBody, declaredIds, idsOf, moveTo, runUrl, subject, type Commit, type Inputs, type Outcome, type Reached, type Run } from './lib.ts';
import { GitHubRateLimited, PULLS_PER_QUERY, type GitHub } from './github.ts';
import { Witness, WitnessError, type Fetch } from './witness.ts';

export type Clients = { witness: Witness; github: GitHub };

export function makeWitness(inputs: Inputs, run: Run, fetchImpl?: Fetch): Witness {
  return new Witness(inputs.link, actorFor(run), fetchImpl);
}

export async function step(inputs: Inputs, run: Run, clients: Clients): Promise<Outcome> {
  const warnings: string[] = [];
  const prefixes = await clients.witness.prefixes();

  const found = await deployedCommits(inputs, run, clients, warnings);
  const declared = await shippedByPullRequests(found.commits, clients.github, prefixes, warnings);
  const ids = [...new Set([...idsOf(found.commits, inputs.text, prefixes), ...declared.ids])];
  let range = found.range;
  if (declared.pulls > 0) range += `, and the Ships lines of ${declared.pulls} pull request(s)`;
  if (inputs.text?.trim() && !found.textOnly) range += ', and the text given';

  if (inputs.status === 'done') {
    warnings.push('`status: done` was ignored — done needs the name of a person who vouches, and a pipeline has none to give. The cards were commented on.');
  }

  const body = commentBody(run, inputs);
  let noRecord = false;
  const reached: Reached[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const card = await clients.witness.card(id);
    if (!card) {
      unknown.push(id);
      continue;
    }
    const row: Reached = { id, title: card.title, was: card.status, now: card.status };
    try {
      await clients.witness.comment(id, body);
    } catch (e) {
      row.note = `comment refused: ${describe(e)}`;
      reached.push(row);
      continue;
    }
    // The record the list and an agent can trust, beside the comment a person reads.
    try {
      const recorded = await clients.witness.recordDeploy(id, {
        environment: inputs.environment,
        sha: run.sha,
        release: inputs.release,
        url: inputs.url,
        run: runUrl(run),
      });
      if (!recorded && !noRecord) {
        noRecord = true;
        warnings.push('This witness keeps no deploy record yet (the comment landed; the list will not show the mark). Update witness to carry it.');
      }
    } catch (e) {
      row.note = `record refused: ${describe(e)}`;
    }
    const target = moveTo(card, inputs.status);
    if (target) {
      try {
        await clients.witness.setStatus(id, card.version, target);
        row.now = target;
      } catch (e) {
        row.note = `stays — ${describe(e)}`;
      }
    }
    reached.push(row);
  }
  // The project's own record, last: it moves only once the cards were told, so a step that
  // died halfway is covered by the next run rather than lost. Whether or not a card was
  // cited — the next deploy compares from here either way.
  try {
    await clients.witness.recordProjectDeploy({
      repository: run.repository,
      environment: inputs.environment,
      sha: run.sha,
      release: inputs.release,
      url: inputs.url,
      run: runUrl(run),
    });
  } catch (e) {
    warnings.push(`The deploy was not recorded on the project (${describe(e)}); the next run will compare from the one before.`);
  }
  return { range, reached, unknown, warnings };
}

/**
 * The ids the deployed commits' pull requests declare they ship. A squash or merge commit
 * carries the pull request's title by default, not its description, so a team that names
 * the cards in the description is read here, each pull request once. Only its `Ships` lines
 * count. A repository set to put the description in the commit message instead has every
 * id in it counted through the commit — nothing here can tell, so the README says to keep
 * that setting on the title. The commits are asked about in one GraphQL query per
 * {@link PULLS_PER_QUERY}. A token that may not read pull requests, a spent rate limit, or a
 * GitHub that fails to answer costs a warning and the pull requests not yet read — never
 * the ones already read, nor the commits' own ids.
 */
export async function shippedByPullRequests(
  commits: readonly Commit[],
  github: GitHub,
  prefixes: readonly string[],
  warnings: string[],
): Promise<{ ids: string[]; pulls: number }> {
  const bodies = new Map<number, string>();
  const done = () => ({ ids: declaredIds([...bodies.values()], prefixes), pulls: bodies.size });
  const kept = () => (bodies.size > 0 ? ` (the ${bodies.size} pull request(s) read before it count)` : '');
  try {
    for (let i = 0; i < commits.length; i += PULLS_PER_QUERY) {
      const pulls = await github.pullRequestsOf(commits.slice(i, i + PULLS_PER_QUERY).map((c) => c.sha));
      if (pulls === 'forbidden') {
        warnings.push(`The token may not read pull requests (\`permissions: pull-requests: read\`), so their Ships lines were not read${kept()}; the commits were.`);
        return done();
      }
      for (const p of pulls) if (!bodies.has(p.number)) bodies.set(p.number, p.body);
    }
  } catch (e) {
    const why = e instanceof GitHubRateLimited ? e.message : `the pull requests could not be read (${describe(e)})`;
    warnings.push(`${capitalise(why)}, so the Ships lines of the pull requests not yet read were skipped${kept()}; the commits were read.`);
  }
  return done();
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Found = { commits: Commit[]; range: string; textOnly?: boolean };

/**
 * The commits this deploy shipped: from the previous deploy to this environment up to this
 * one. Where the previous deploy is known from, in order: `since`, when the workflow says;
 * the project's own record (witness keeps it since 2026-11-03), which the step wrote on its
 * last run; and, when there is no record yet — a witness that predates it, or the first run
 * of a step that writes it — the previous successful run of this workflow on this branch,
 * so a team that upgrades keeps its range on the upgrade run. With nothing to compare from,
 * the text alone when the workflow handed one over — a list someone wrote beats a guess —
 * and otherwise the head commit, said so in the summary.
 */
async function deployedCommits(inputs: Inputs, run: Run, clients: Clients, warnings: string[]): Promise<Found> {
  const { github, witness } = clients;
  const since = inputs.since?.trim();
  if (since) {
    const commits = await github.commitsSince(since);
    if (commits) return { commits, range: `${commits.length} commit(s) since \`${since.slice(0, 7)}\` (from \`since\`)` };
    warnings.push(`\`since: ${since.slice(0, 7)}\` is not a commit GitHub can compare from; ${nothingToCompareFrom(inputs)}.`);
    return fallback(inputs, github, 'since could not be compared from');
  }
  const previous = await witness.previousDeploy(run.repository, inputs.environment);
  if (previous === 'unsupported') return fromRuns(inputs, github, warnings, 'older');
  if (previous === null) return fromRuns(inputs, github, warnings, 'first');
  const commits = await github.commitsSince(previous.sha);
  if (commits === null) {
    warnings.push(`The previous deploy's commit \`${previous.sha.slice(0, 7)}\` is no longer in this repository; ${nothingToCompareFrom(inputs)}.`);
    return fallback(inputs, github, 'the previous deploy is gone from the repository');
  }
  const named = previous.release ? ` (${previous.release})` : '';
  return { commits, range: `${commits.length} commit(s) since the previous deploy to ${inputs.environment}, \`${previous.sha.slice(0, 7)}\`${named}` };
}

/**
 * No record to compare from: the previous successful run of this workflow on this branch.
 * `older` is a witness from before the record, where this is the only way and a token that
 * may not read runs is worth a warning. `first` is a project with no deploy recorded here
 * yet, where this run writes the record and the next needs no runs at all — so a token that
 * cannot read them is no fault, and the summary says only that this is the first deploy.
 */
async function fromRuns(inputs: Inputs, github: GitHub, warnings: string[], why: 'older' | 'first'): Promise<Found> {
  const first = `the first deploy to ${inputs.environment} recorded here`;
  const previous = await github.previousDeploySha();
  if (previous === 'forbidden') {
    if (why === 'first') return fallback(inputs, github, first);
    warnings.push(`The token may not read workflow runs (\`permissions: actions: read\`), so the previous deploy is unknown; ${nothingToCompareFrom(inputs)}. Pass \`since\`, grant the permission, or update witness, which then keeps the record itself.`);
    return fallback(inputs, github, 'previous deploy unknown');
  }
  if (previous === null) {
    return fallback(inputs, github, why === 'first' ? first : 'no previous successful run of this workflow on this branch');
  }
  const commits = await github.commitsSince(previous.sha);
  if (commits === null) {
    warnings.push(`The previous deploy's commit \`${previous.sha.slice(0, 7)}\` is no longer in this branch's history; ${nothingToCompareFrom(inputs)}.`);
    return fallback(inputs, github, 'the previous deploy is gone from the branch');
  }
  return { commits, range: `${commits.length} commit(s) since the previous deploy, \`${previous.sha.slice(0, 7)}\` (run ${previous.runNumber})` };
}

function nothingToCompareFrom(inputs: Inputs): string {
  return inputs.text?.trim() ? 'the text alone was read' : 'the head commit alone was read';
}

/** Nothing to compare from: the text alone when there is one, else the head commit. */
async function fallback(inputs: Inputs, github: GitHub, why: string): Promise<Found> {
  if (inputs.text?.trim()) return { commits: [], range: `the text given only — ${why}`, textOnly: true };
  const head = await github.headCommit();
  return { commits: [head], range: `the head commit only — ${why}: ${subject(head.message)}` };
}

function describe(e: unknown): string {
  if (e instanceof WitnessError) {
    if (e.status === 403) return 'this link cannot change cards (a view link comments only)';
    if (e.status === 409) return 'the card changed while the step ran';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

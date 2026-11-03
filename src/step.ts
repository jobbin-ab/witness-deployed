/**
 * The step itself, with its two clients handed in so a test can run it against a real
 * project and a stand-in GitHub. It never throws for a card: what a card refuses is a line
 * in the summary, and the next card is still written.
 */
import { actor as actorFor, commentBody, idsOf, moveTo, runUrl, subject, type Commit, type Inputs, type Outcome, type Reached, type Run } from './lib.ts';
import type { GitHub } from './github.ts';
import { Witness, WitnessError, type Fetch } from './witness.ts';

export type Clients = { witness: Witness; github: GitHub };

export function makeWitness(inputs: Inputs, run: Run, fetchImpl?: Fetch): Witness {
  return new Witness(inputs.link, actorFor(run), fetchImpl);
}

export async function step(inputs: Inputs, run: Run, clients: Clients): Promise<Outcome> {
  const warnings: string[] = [];
  const prefixes = await clients.witness.prefixes();

  const found = await deployedCommits(inputs, run, clients, warnings);
  const ids = idsOf(found.commits, inputs.text, prefixes);
  const range = inputs.text?.trim() && !found.textOnly ? `${found.range}, and the text given` : found.range;

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

type Found = { commits: Commit[]; range: string; textOnly?: boolean };

/**
 * The commits this deploy shipped: from the previous deploy to this environment up to this
 * one. Where the previous deploy is known from, in order: `since`, when the workflow says;
 * the project's own record (witness keeps it since 2026-11-03), which the step wrote on its last run; and, for a
 * witness that predates the record, the previous successful run of this workflow on this
 * branch. With nothing to compare from, the text alone when the workflow handed one over —
 * a list someone wrote beats a guess — and otherwise the head commit, said so in the summary.
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
  if (previous === 'unsupported') return fromRuns(inputs, github, warnings);
  if (previous === null) return fallback(inputs, github, `the first deploy to ${inputs.environment} recorded here`);
  const commits = await github.commitsSince(previous.sha);
  if (commits === null) {
    warnings.push(`The previous deploy's commit \`${previous.sha.slice(0, 7)}\` is no longer in this repository; ${nothingToCompareFrom(inputs)}.`);
    return fallback(inputs, github, 'the previous deploy is gone from the repository');
  }
  const named = previous.release ? ` (${previous.release})` : '';
  return { commits, range: `${commits.length} commit(s) since the previous deploy to ${inputs.environment}, \`${previous.sha.slice(0, 7)}\`${named}` };
}

/** Before the project kept the record: the previous successful run of this workflow on this branch. */
async function fromRuns(inputs: Inputs, github: GitHub, warnings: string[]): Promise<Found> {
  const previous = await github.previousDeploySha();
  if (previous === 'forbidden') {
    warnings.push(`The token may not read workflow runs (\`permissions: actions: read\`), so the previous deploy is unknown; ${nothingToCompareFrom(inputs)}. Pass \`since\`, grant the permission, or update witness, which then keeps the record itself.`);
    return fallback(inputs, github, 'previous deploy unknown');
  }
  if (previous === null) {
    return fallback(inputs, github, 'no previous successful run of this workflow on this branch');
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

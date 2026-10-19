/**
 * The step itself, with its two clients handed in so a test can run it against a real
 * project and a stand-in GitHub. It never throws for a card: what a card refuses is a line
 * in the summary, and the next card is still written.
 */
import { actor as actorFor, citedIds, commentBody, moveTo, subject, type Commit, type Inputs, type Outcome, type Reached, type Run } from './lib.ts';
import type { GitHub } from './github.ts';
import { Witness, WitnessError, type Fetch } from './witness.ts';

export type Clients = { witness: Witness; github: GitHub };

export function makeWitness(inputs: Inputs, run: Run, fetchImpl?: Fetch): Witness {
  return new Witness(inputs.link, actorFor(run), fetchImpl);
}

export async function step(inputs: Inputs, run: Run, clients: Clients): Promise<Outcome> {
  const warnings: string[] = [];
  const prefixes = await clients.witness.prefixes();

  const { commits, range } = await deployedCommits(inputs, clients.github, warnings);
  const ids = citedIds(commits, prefixes);

  if (inputs.status === 'done') {
    warnings.push('`status: done` was ignored — done needs the name of a person who vouches, and a pipeline has none to give. The cards were commented on.');
  }

  const body = commentBody(run, inputs);
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
  return { range, reached, unknown, warnings };
}

async function deployedCommits(inputs: Inputs, github: GitHub, warnings: string[]): Promise<{ commits: Commit[]; range: string }> {
  const since = inputs.since?.trim();
  if (since) {
    const commits = await github.commitsSince(since);
    if (commits) return { commits, range: `${commits.length} commit(s) since \`${since.slice(0, 7)}\` (from \`since\`)` };
    warnings.push(`\`since: ${since.slice(0, 7)}\` is not a commit GitHub can compare from; the head commit alone was read.`);
    return headOnly(github, 'the head commit only');
  }
  const previous = await github.previousDeploySha();
  if (previous === 'forbidden') {
    warnings.push('The token may not read workflow runs (`permissions: actions: read`), so the previous deploy is unknown; the head commit alone was read. Pass `since` or grant the permission.');
    return headOnly(github, 'the head commit only — previous deploy unknown');
  }
  if (previous === null) {
    return headOnly(github, 'the head commit only — no previous successful run of this workflow on this branch');
  }
  const commits = await github.commitsSince(previous.sha);
  if (commits === null) {
    warnings.push(`The previous deploy's commit \`${previous.sha.slice(0, 7)}\` is no longer in this branch's history; the head commit alone was read.`);
    return headOnly(github, 'the head commit only');
  }
  return { commits, range: `${commits.length} commit(s) since the previous deploy, \`${previous.sha.slice(0, 7)}\` (run ${previous.runNumber})` };
}

async function headOnly(github: GitHub, why: string): Promise<{ commits: Commit[]; range: string }> {
  const head = await github.headCommit();
  return { commits: [head], range: `${why}: ${subject(head.message)}` };
}

function describe(e: unknown): string {
  if (e instanceof WitnessError) {
    if (e.status === 403) return 'this link cannot change cards (a view link comments only)';
    if (e.status === 409) return 'the card changed while the step ran';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

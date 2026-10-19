/**
 * The whole step against a real witness project — a local worker, provisioned with the
 * admin CLI, its links in WITNESS_EDIT_LINK and WITNESS_VIEW_LINK — with GitHub's API stood
 * in for. GitHub is the one boundary this suite cannot cross: a real run exists only
 * inside Actions, so the two answers the step reads (the previous successful run, the
 * compare) are served by a stand-in that returns the documented shapes. Everything on the
 * witness side is the real server: the ids it assigns, the writes it accepts, the ones it
 * refuses.
 *
 * Skipped, loudly, when no link is set.
 */
import { describe, expect, test } from 'bun:test';
import { GitHub } from '../src/github.ts';
import type { Fetch } from '../src/witness.ts';
import { actor, type Run } from '../src/lib.ts';
import { makeWitness, step } from '../src/step.ts';

const edit = process.env.WITNESS_EDIT_LINK;
const view = process.env.WITNESS_VIEW_LINK;
const live = edit && view ? test : test.skip;
if (!edit || !view) console.warn('WITNESS_EDIT_LINK and WITNESS_VIEW_LINK are not set: the live step test is skipped.');

const run: Run = {
  repository: 'acme/shop',
  sha: '3f9c2a1deadbeef0000000000000000000000000',
  runId: '99001',
  runNumber: '4183',
  serverUrl: 'https://github.com',
};
const previousSha = '1234567aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** GitHub's two answers, in the shapes the API documents. */
function githubStandIn(messages: string[], opts: { runs?: 'forbidden' | 'none' } = {}): GitHub {
  const fetchImpl: Fetch = async (input) => {
    const url = String(input);
    if (url.includes('/actions/workflows/')) {
      if (opts.runs === 'forbidden') return new Response('{"message":"Resource not accessible by integration"}', { status: 403 });
      const runs = opts.runs === 'none' ? [] : [{ head_sha: run.sha, run_number: 4183 }, { head_sha: previousSha, run_number: 4182 }];
      return Response.json({ workflow_runs: runs });
    }
    if (url.includes('/compare/')) {
      return Response.json({ commits: messages.map((message, i) => ({ sha: `c${i}`, commit: { message } })) });
    }
    if (url.includes('/commits/')) {
      return Response.json({ sha: run.sha, commit: { message: messages[messages.length - 1] ?? '' } });
    }
    return new Response('not stood in', { status: 500 });
  };
  return new GitHub(
    { ...run, apiUrl: 'https://api.github.test', workflowRef: 'acme/shop/.github/workflows/deploy.yml@refs/heads/main', refName: 'main', token: 't' },
    fetchImpl,
  );
}

const writer = { kind: 'human', name: 'Mia', via: 'the test' };

async function post(link: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(link + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function patch(link: string, id: string, version: number, body: unknown): Promise<any> {
  const res = await fetch(`${link}/cards/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'If-Match': String(version) },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function read(link: string, id: string): Promise<any> {
  const res = await fetch(`${link}/cards/${id}.json`, { headers: { Accept: 'application/json' } });
  return res.json();
}

/** Three cards: one waiting on a deploy, one done, one still being worked. */
async function seed(link: string) {
  const blocked = (await post(link, '/cards', { area: 'alerts', title: 'Fix discount total', status: 'blocked', statusReason: 'PR #212, awaiting staging', actor: writer })).card;
  const made = (await post(link, '/cards', { area: 'alerts', title: 'Tidy the footer', actor: writer })).card;
  const done = (await patch(link, made.id, made.version, { status: 'done', verifiedBy: 'Mia', actor: writer })).card;
  const working = (await post(link, '/cards', { area: 'vx', title: 'Retry on 502', actor: writer })).card;
  return { blocked, done, working };
}

describe('the step against a real project', () => {
  live('comments on every cited card, moves only the blocked one, and reports the rest', async () => {
    const link = edit!;
    const { blocked, done, working } = await seed(link);
    const messages = [
      `Fix discount total (${blocked.id})`,
      `Tidy the footer (${done.id})\n\nSeen in ${working.id} too.`,
      'Bump deps (PROJ-9)',
      'Retry on 502 (AL-99)',
    ];
    const inputs = { link, environment: 'staging', url: 'https://staging.acme.test', status: 'verify' };
    const outcome = await step(inputs, run, { witness: makeWitness(inputs, run), github: githubStandIn(messages) });

    expect(outcome.range).toContain('4 commit(s) since the previous deploy, `1234567` (run 4182)');
    expect(outcome.unknown).toEqual(['AL-99']);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.reached.map((r) => [r.id, r.was, r.now])).toEqual([
      [blocked.id, 'blocked', 'verify'],
      [done.id, 'done', 'done'],
      [working.id, 'investigating', 'investigating'],
    ]);
    expect(JSON.stringify(outcome)).not.toContain('PROJ');

    const after = await read(link, blocked.id);
    expect(after.card.status).toBe('verify');
    expect(after.comments).toHaveLength(1);
    expect(after.comments[0].body).toBe(
      'Deployed to **staging** at [`3f9c2a1`](https://github.com/acme/shop/commit/3f9c2a1deadbeef0000000000000000000000000) · [run 4183](https://github.com/acme/shop/actions/runs/99001) — https://staging.acme.test',
    );
    expect(after.comments[0].actor).toEqual(actor(run));
    expect(after.card.updatedBy).toEqual(actor(run));

    const stillDone = await read(link, done.id);
    expect(stillDone.card.status).toBe('done');
    expect(stillDone.comments).toHaveLength(1);
  });

  live('a view link comments and says why it could not move the card', async () => {
    const { blocked } = await seed(edit!);
    const inputs = { link: view!, environment: 'staging', status: 'verify' };
    const outcome = await step(inputs, run, { witness: makeWitness(inputs, run), github: githubStandIn([`Fix (${blocked.id})`]) });
    expect(outcome.reached).toHaveLength(1);
    expect(outcome.reached[0]!.now).toBe('blocked');
    expect(outcome.reached[0]!.note).toContain('a view link comments only');
    const after = await read(edit!, blocked.id);
    expect(after.card.status).toBe('blocked');
    expect(after.comments).toHaveLength(1);
  });

  live('done is never sent: the cards are commented on and the summary says why', async () => {
    const { blocked } = await seed(edit!);
    const inputs = { link: edit!, environment: 'production', status: 'done' };
    const outcome = await step(inputs, run, { witness: makeWitness(inputs, run), github: githubStandIn([`Fix (${blocked.id})`]) });
    expect(outcome.reached[0]!.now).toBe('blocked');
    expect(outcome.warnings[0]).toContain('done needs the name of a person');
  });

  live('a status the project does not have is refused by the server and reported, not thrown', async () => {
    const { blocked } = await seed(edit!);
    const inputs = { link: edit!, environment: 'staging', status: 'shipped' };
    const outcome = await step(inputs, run, { witness: makeWitness(inputs, run), github: githubStandIn([`Fix (${blocked.id})`]) });
    expect(outcome.reached[0]!.now).toBe('blocked');
    expect(outcome.reached[0]!.note).toMatch(/^stays — /);
  });

  live('without a previous run, or without permission to read runs, the head commit alone is read', async () => {
    const { blocked } = await seed(edit!);
    const inputs = { link: edit!, environment: 'staging' };
    const first = await step(inputs, run, { witness: makeWitness(inputs, run), github: githubStandIn([`Fix (${blocked.id})`], { runs: 'none' }) });
    expect(first.range).toContain('no previous successful run');
    expect(first.reached.map((r) => r.id)).toEqual([blocked.id]);
    const forbidden = await step(inputs, run, { witness: makeWitness(inputs, run), github: githubStandIn([`Fix (${blocked.id})`], { runs: 'forbidden' }) });
    expect(forbidden.warnings[0]).toContain('permissions: actions: read');
    expect(forbidden.reached.map((r) => r.id)).toEqual([blocked.id]);
  });

  live('a project the link cannot reach is one error, before any write', async () => {
    const inputs = { link: 'http://localhost:8787/r/not-a-link-at-all', environment: 'staging' };
    await expect(step(inputs, run, { witness: makeWitness(inputs, run), github: githubStandIn(['x']) })).rejects.toThrow(/Unknown project link|not_found|404/);
  });
});

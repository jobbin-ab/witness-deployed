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

/**
 * GitHub's answers, in the shapes the API documents. `compared` is every base the step
 * asked to compare from, which is how a test sees where the range began.
 */
function githubStandIn(messages: string[], opts: { runs?: 'forbidden' | 'none'; head?: string } = {}): GitHub & { compared: string[] } {
  const compared: string[] = [];
  const sha = opts.head ?? run.sha;
  const fetchImpl: Fetch = async (input) => {
    const url = String(input);
    if (url.includes('/actions/workflows/')) {
      if (opts.runs === 'forbidden') return new Response('{"message":"Resource not accessible by integration"}', { status: 403 });
      const runs = opts.runs === 'none' ? [] : [{ head_sha: sha, run_number: 4183 }, { head_sha: previousSha, run_number: 4182 }];
      return Response.json({ workflow_runs: runs });
    }
    const compare = /\/compare\/(.+?)\.\.\./.exec(url);
    if (compare) {
      compared.push(compare[1]!);
      return Response.json({ commits: messages.map((message, i) => ({ sha: `c${i}`, commit: { message } })) });
    }
    if (url.includes('/commits/')) {
      return Response.json({ sha, commit: { message: messages[messages.length - 1] ?? '' } });
    }
    return new Response('not stood in', { status: 500 });
  };
  const github = new GitHub(
    { ...run, sha, apiUrl: 'https://api.github.test', workflowRef: 'acme/shop/.github/workflows/deploy.yml@refs/heads/main', refName: 'main', token: 't' },
    fetchImpl,
  );
  return Object.assign(github, { compared });
}

/** An environment no earlier test has deployed to, so the project's record for it starts empty. */
const fresh = () => `e-${crypto.randomUUID().slice(0, 8)}`;

/**
 * The witness as it was before it kept the deploy record (v1.2 of this step against a
 * server from before witness kept the deploy record, 2026-11-03): the real server for everything, a 404 for the two calls the
 * record is made of. Stood in at that one boundary because no such server runs here.
 */
function olderWitnessFetch(): Fetch {
  return (input, init) => {
    const url = String(input);
    if (/\/deploys(\.json)?$/.test(url)) return Promise.resolve(Response.json({ error: 'not_found', message: 'Not found' }, { status: 404 }));
    return fetch(input, init);
  };
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
    const environment = fresh();
    // The previous deploy, as the step's last run recorded it on the project.
    await post(link, '/deploys', { repository: run.repository, environment, sha: previousSha, actor: actor(run) });
    const inputs = { link, environment, url: 'https://staging.acme.test', status: 'verify' };
    const github = githubStandIn(messages);
    const outcome = await step(inputs, run, { witness: makeWitness(inputs, run), github });

    expect(github.compared).toEqual([previousSha]);
    expect(outcome.range).toContain(`4 commit(s) since the previous deploy to ${environment}, \`1234567\``);
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
    // The record beside the comment: what the list's mark reads.
    expect(after.card.deployed[environment]).toMatchObject({
      sha: run.sha,
      url: 'https://staging.acme.test',
      run: 'https://github.com/acme/shop/actions/runs/99001',
    });
    expect(after.comments[0].body).toBe(
      `Deployed to **${environment}** at [\`3f9c2a1\`](https://github.com/acme/shop/commit/3f9c2a1deadbeef0000000000000000000000000) · [run 4183](https://github.com/acme/shop/actions/runs/99001) — https://staging.acme.test`,
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

  live('records the deploy on the project, cited cards or none, and the next run compares from it', async () => {
    const link = edit!;
    const environment = fresh();
    const first = { link, environment, release: 'v1.0.0' };
    const nothing = await step(first, run, { witness: makeWitness(first, run), github: githubStandIn(['Bump deps (PROJ-9)']) });
    expect(nothing.range).toContain(`the head commit only — the first deploy to ${environment} recorded here`);
    expect(nothing.reached).toEqual([]);

    const { blocked } = await seed(link);
    const next = { ...run, sha: '9d8c7b6a5f4e3d2c1b0a9d8c7b6a5f4e3d2c1b0a', runId: '99002', runNumber: '4184' };
    const inputs = { link, environment };
    const github = githubStandIn([`Fix (${blocked.id})`], { head: next.sha });
    const outcome = await step(inputs, next, { witness: makeWitness(inputs, next), github });
    expect(github.compared).toEqual([run.sha]);
    expect(outcome.range).toContain(`1 commit(s) since the previous deploy to ${environment}, \`3f9c2a1\` (v1.0.0)`);
    expect(outcome.reached.map((r) => r.id)).toEqual([blocked.id]);
    const after = await read(link, blocked.id);
    expect(after.card.deployed[environment]).toMatchObject({ sha: next.sha, release: '' });
  });

  live('with nothing to compare from, the text alone is read when given — never the head commit beside it', async () => {
    const link = edit!;
    const { blocked, done } = await seed(link);
    const withText = { link, environment: fresh(), text: `Shipped: ${blocked.id}` };
    const github = githubStandIn([`Tidy (${done.id})`]);
    const outcome = await step(withText, run, { witness: makeWitness(withText, run), github });
    expect(outcome.range).toContain('the text given only');
    expect(outcome.reached.map((r) => r.id)).toEqual([blocked.id]);
    expect(github.compared).toEqual([]);

    const withoutText = { link, environment: fresh() };
    const head = await step(withoutText, run, { witness: makeWitness(withoutText, run), github: githubStandIn([`Tidy (${done.id})`]) });
    expect(head.reached.map((r) => r.id)).toEqual([done.id]);
  });

  live('`since` wins over the record, and the deploy is recorded all the same', async () => {
    const link = edit!;
    const environment = fresh();
    await post(link, '/deploys', { repository: run.repository, environment, sha: previousSha, actor: actor(run) });
    const inputs = { link, environment, since: 'v1.2.0' };
    const github = githubStandIn(['Bump deps']);
    const outcome = await step(inputs, run, { witness: makeWitness(inputs, run), github });
    expect(github.compared).toEqual(['v1.2.0']);
    expect(outcome.range).toContain('(from `since`)');
    const next = githubStandIn(['Bump deps']);
    await step({ link, environment }, run, { witness: makeWitness({ link, environment }, run), github: next });
    expect(next.compared).toEqual([run.sha]);
  });

  live('against a witness from before the record: the previous run of this workflow, or the head commit alone', async () => {
    const { blocked } = await seed(edit!);
    const inputs = { link: edit!, environment: 'staging' };
    const witness = makeWitness(inputs, run, olderWitnessFetch());
    const known = githubStandIn([`Fix (${blocked.id})`]);
    const ranged = await step(inputs, run, { witness, github: known });
    expect(known.compared).toEqual([previousSha]);
    expect(ranged.range).toContain('since the previous deploy, `1234567` (run 4182)');
    const first = await step(inputs, run, { witness, github: githubStandIn([`Fix (${blocked.id})`], { runs: 'none' }) });
    expect(first.range).toContain('no previous successful run');
    expect(first.reached.map((r) => r.id)).toEqual([blocked.id]);
    const forbidden = await step(inputs, run, { witness, github: githubStandIn([`Fix (${blocked.id})`], { runs: 'forbidden' }) });
    expect(forbidden.warnings[0]).toContain('permissions: actions: read');
    expect(forbidden.reached.map((r) => r.id)).toEqual([blocked.id]);
  });

  live('a project the link cannot reach is one error, before any write', async () => {
    const inputs = { link: 'http://localhost:8787/r/not-a-link-at-all', environment: 'staging' };
    await expect(step(inputs, run, { witness: makeWitness(inputs, run), github: githubStandIn(['x']) })).rejects.toThrow(/Unknown project link|not_found|404/);
  });
});

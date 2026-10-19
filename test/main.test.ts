/**
 * The bundled entry, run the way GitHub runs it: node, inputs as INPUT_* variables, the run
 * context as GITHUB_* variables, the summary to a file. Against the real local project
 * when its links are set; the unreachable-link case needs nothing but a worker.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const edit = process.env.WITNESS_EDIT_LINK;
const live = edit ? test : test.skip;

let headMessage = 'nothing';
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.includes('/actions/workflows/')) return Response.json({ workflow_runs: [] });
    if (url.pathname.includes('/commits/')) return Response.json({ sha: 'abc', commit: { message: headMessage } });
    return new Response('not stood in', { status: 500 });
  },
});
afterAll(() => server.stop());

async function runEntry(inputs: Record<string, string>, message: string): Promise<{ code: number; out: string; summary: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'wd-'));
  const summaryFile = join(dir, 'summary.md');
  writeFileSync(summaryFile, '');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    GITHUB_REPOSITORY: 'acme/shop',
    GITHUB_SHA: 'abcdef1234567890abcdef1234567890abcdef12',
    GITHUB_RUN_ID: '1',
    GITHUB_RUN_NUMBER: '7',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: `http://localhost:${server.port}`,
    GITHUB_WORKFLOW_REF: 'acme/shop/.github/workflows/deploy.yml@refs/heads/main',
    GITHUB_REF_NAME: 'main',
    GITHUB_STEP_SUMMARY: summaryFile,
    INPUT_TOKEN: 'ghs_token',
  };
  headMessage = message;
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  const proc = Bun.spawn(['node', 'dist/main.cjs'], { env, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out: out + err, summary: readFileSync(summaryFile, 'utf8') };
}

describe('the entry GitHub runs', () => {
  test('a link that reaches nothing: exit 0, one warning, nothing else', async () => {
    const link = 'http://127.0.0.1:9/r/nothing-listens-here';
    const r = await runEntry({ link, environment: 'staging' }, 'x');
    expect(r.code).toBe(0);
    expect(r.out).toContain(`::add-mask::${link}`);
    expect(r.out).toMatch(/::warning::witness-deployed: .*the deploy is unaffected/);
    expect(r.summary).toBe('');
  });

  live('a link the worker does not know: exit 0, the server\'s own reason in the warning', async () => {
    const link = `${edit!.split('/r/')[0]}/r/not-a-link-at-all`;
    const r = await runEntry({ link, environment: 'staging' }, 'x');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/::warning::witness-deployed: Unknown project link.*the deploy is unaffected/);
    expect(r.summary).toBe('');
  });

  test('without the required inputs: exit 0 and a warning', async () => {
    const r = await runEntry({ environment: 'staging' }, 'x');
    expect(r.code).toBe(0);
    expect(r.out).toContain('::warning::witness-deployed: `link` and `environment` are required');
  });

  live('a real deploy: the summary names the card, and the link appears nowhere in it', async () => {
    const made = await fetch(`${edit}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ area: 'alerts', title: 'End to end', status: 'blocked', statusReason: 'PR #1', actor: { kind: 'human', name: 'Mia' } }),
    }).then((res) => res.json() as Promise<any>);
    const id: string = made.card.id;
    const r = await runEntry({ link: edit!, environment: 'staging', status: 'verify' }, `Ship it (${id})`);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('::warning::');
    expect(r.summary).toContain(`| ${id} | End to end | blocked | verify |`);
    expect(r.summary).toContain('no previous successful run');
    expect(r.summary).not.toContain(edit!.split('/r/')[1]!);
    expect(r.out.replace(`::add-mask::${edit}`, '')).not.toContain(edit!.split('/r/')[1]!);
  });
});

import { describe, expect, test } from 'bun:test';
import { citedIds, commentBody, idPattern, idsOf, moveTo, summaryMarkdown, type Run } from '../src/lib.ts';

const run: Run = {
  repository: 'acme/shop',
  sha: '3f9c2a1deadbeef0000000000000000000000000',
  runId: '99001',
  runNumber: '4183',
  serverUrl: 'https://github.com',
};

describe('which ids a deploy cites', () => {
  test("only the project's own prefixes, each once, in order of first sight", () => {
    const commits = [
      { sha: 'a', message: 'Fix discount total (AL-04)\n\nAlso touches AL-04 again and VX-13.' },
      { sha: 'b', message: 'Bump deps (PROJ-9)' },
      { sha: 'c', message: 'Retry on 502 (AL-99)' },
    ];
    expect(citedIds(commits, ['AL', 'VX'])).toEqual(['AL-04', 'VX-13', 'AL-99']);
  });

  test('a prefix inside a longer word is not a card', () => {
    expect(citedIds([{ sha: 'a', message: 'MAIL-04 and EMAIL-12' }], ['AL'])).toEqual([]);
  });

  test('a number too short is not a card', () => {
    expect(citedIds([{ sha: 'a', message: 'AL-4 is not an id; AL-04 is' }], ['AL'])).toEqual(['AL-04']);
  });

  test("a release's notes count beside the commits, by the same rule", () => {
    const commits = [{ sha: 'a', message: 'Bump version' }];
    const notes = '## 4.2\n- Retry on 502 (VX-13)\n- Jira: PROJ-9\n- AL-04 again';
    expect(idsOf(commits, notes, ['AL', 'VX'])).toEqual(['VX-13', 'AL-04']);
    expect(idsOf(commits, undefined, ['AL', 'VX'])).toEqual([]);
    expect(idsOf(commits, '   ', ['AL', 'VX'])).toEqual([]);
  });

  test('a project with no usable prefix cites nothing', () => {
    expect(idPattern([])).toBeNull();
    expect(citedIds([{ sha: 'a', message: 'AL-04' }], [])).toEqual([]);
  });
});

describe('what the card is told', () => {
  test('environment, commit and run as links, the address last', () => {
    expect(commentBody(run, { environment: 'staging', url: 'https://staging.acme.test' })).toBe(
      'Deployed to **staging** at [`3f9c2a1`](https://github.com/acme/shop/commit/3f9c2a1deadbeef0000000000000000000000000) · [run 4183](https://github.com/acme/shop/actions/runs/99001) — https://staging.acme.test',
    );
  });
  test('without an address', () => {
    expect(commentBody(run, { environment: 'production' })).toEndWith('[run 4183](https://github.com/acme/shop/actions/runs/99001)');
  });
});

describe('which cards a status moves', () => {
  test('only a blocked card', () => {
    expect(moveTo({ status: 'blocked' }, 'verify')).toBe('verify');
    expect(moveTo({ status: 'done' }, 'verify')).toBeNull();
    expect(moveTo({ status: 'triage' }, 'verify')).toBeNull();
    expect(moveTo({ status: 'investigating' }, 'verify')).toBeNull();
  });
  test('never to done, and nowhere without a status', () => {
    expect(moveTo({ status: 'blocked' }, 'done')).toBeNull();
    expect(moveTo({ status: 'blocked' }, undefined)).toBeNull();
  });
});

describe('the summary', () => {
  test('a table of the cards reached, the ids that named none, and the warnings', () => {
    const md = summaryMarkdown(
      {
        range: '3 commit(s) since the previous deploy, `1234567` (run 4182)',
        reached: [
          { id: 'AL-04', title: 'Fix discount | total', was: 'blocked', now: 'verify' },
          { id: 'AL-02', title: 'Tidy the footer', was: 'done', now: 'done' },
        ],
        unknown: ['AL-99'],
        warnings: ['one thing'],
      },
      { environment: 'staging' },
    );
    expect(md).toContain('| AL-04 | Fix discount \\| total | blocked | verify |');
    expect(md).toContain('| AL-02 | Tidy the footer | done | done |');
    expect(md).toContain('Named no card in this project: AL-99');
    expect(md).toContain('⚠ one thing');
  });
  test('nothing cited says so', () => {
    expect(summaryMarkdown({ range: 'r', reached: [], unknown: [], warnings: [] }, { environment: 'x' })).toContain('No card was cited');
  });
});

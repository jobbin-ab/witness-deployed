import { describe, expect, test } from 'bun:test';
import { citedIds, commentBody, declaredIds, idPattern, idsOf, moveTo, summaryMarkdown, type Run } from '../src/lib.ts';

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

  test("a pull request's description ships only what its Ships lines name", () => {
    const body = [
      'Builds on AL-02, which shipped last week.',
      '',
      'Ships AL-04.',
      '',
      'The rest is left for its own card, VX-20.',
    ].join('\n');
    expect(declaredIds([body], ['AL', 'VX'])).toEqual(['AL-04']);
  });

  test('a Ships line may be indented, listed, in any case, and name several', () => {
    const body = '  - ships: AL-04, VX-13\r\n1. SHIPS AL-07 (and PROJ-9)\n* Ships AL-04 again';
    expect(declaredIds([body], ['AL', 'VX'])).toEqual(['AL-04', 'VX-13', 'AL-07']);
  });

  test('a Ships word in emphasis or as a heading', () => {
    const body = '**Ships:** AL-04\n__Ships__ AL-05\n## Ships AL-06\n- **Ships** VX-13\n*ships*: AL-07';
    expect(declaredIds([body], ['AL', 'VX'])).toEqual(['AL-04', 'AL-05', 'AL-06', 'VX-13', 'AL-07']);
  });

  test('a Ships line inside a fenced code block quotes, it does not declare', () => {
    const body = ['```markdown', 'Ships AL-04', '```', '~~~~', 'Ships AL-05', '~~~', '```', 'Ships AL-06', '~~~~', 'Ships AL-07'].join('\n');
    expect(declaredIds([body], ['AL'])).toEqual(['AL-07']);
  });

  test('only the word that opens the line: not Shipped, not Shipshape, not a Ships mid-sentence', () => {
    const body = 'Shipped AL-04 before.\nShipshape AL-05\nThis ships AL-06 too.\n> Ships AL-07\n**Shipped** AL-08\n### Shipping AL-09';
    expect(declaredIds([body], ['AL'])).toEqual([]);
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
  test("the release's name between the commit and the run, when the team has one", () => {
    expect(commentBody(run, { environment: 'production', release: 'v2026.11.02.2' })).toContain(
      '[`3f9c2a1`](https://github.com/acme/shop/commit/3f9c2a1deadbeef0000000000000000000000000) · v2026.11.02.2 · [run 4183]',
    );
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

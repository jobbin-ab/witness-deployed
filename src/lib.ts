/**
 * The pure part of the step: which ids a deploy cites, what the comment says, which cards
 * a status may move, and what the step summary shows. Nothing here touches the network, so
 * all of it is tested without one.
 */

export type Inputs = {
  link: string;
  environment: string;
  url?: string;
  status?: string;
  since?: string;
  /** Text to scan beside the commits — a release's notes. */
  text?: string;
};

/** What the run knows about itself — GitHub's own context, read from the environment. */
export type Run = {
  repository: string;
  sha: string;
  runId: string;
  runNumber: string;
  serverUrl: string;
};

export type Commit = { sha: string; message: string };

/** The card as the step reads it: enough to comment, to decide a move, and to send If-Match. */
export type Card = { id: string; title: string; status: string; version: number };

/**
 * Card ids are `<area prefix>-<number>`, and only the project's own prefixes count: a
 * commit that cites a Jira key is a commit that cites nothing here. Matched on a word
 * boundary so `AL-04` inside `(AL-04)` is found and `MAIL-04` is not.
 */
export function idPattern(prefixes: readonly string[]): RegExp | null {
  const clean = prefixes.filter((p) => /^[A-Z]{2,4}$/.test(p));
  if (clean.length === 0) return null;
  return new RegExp(`(?<![A-Z])(?:${clean.join('|')})-\\d{2,}(?!\\d)`, 'g');
}

/** The ids the commits cite, each once, in the order first seen. */
export function citedIds(commits: readonly Commit[], prefixes: readonly string[]): string[] {
  const pattern = idPattern(prefixes);
  if (!pattern) return [];
  const seen = new Set<string>();
  for (const c of commits) {
    for (const m of c.message.matchAll(pattern)) seen.add(m[0]);
  }
  return [...seen];
}

/**
 * The ids a deploy cites: its commits, and whatever text the workflow handed over beside
 * them — a release's notes, when the cards are named there rather than in commits. The
 * same rule for both; the text is read as one more message, last.
 */
export function idsOf(commits: readonly Commit[], text: string | undefined, prefixes: readonly string[]): string[] {
  const extra = text?.trim() ? [{ sha: '', message: text }] : [];
  return citedIds([...commits, ...extra], prefixes);
}

/** The commit's first line, for the summary. */
export function subject(message: string): string {
  return message.split('\n', 1)[0]?.trim() ?? '';
}

/**
 * What the card is told. The environment in bold because it is the one word a reader
 * scans for; the commit and the run as links; the environment's address last, when it has
 * one, so a person verifying can open it from the card.
 */
export function commentBody(run: Run, inputs: Pick<Inputs, 'environment' | 'url'>): string {
  const commitUrl = `${run.serverUrl}/${run.repository}/commit/${run.sha}`;
  const runUrl = `${run.serverUrl}/${run.repository}/actions/runs/${run.runId}`;
  const where = inputs.url ? ` — ${inputs.url}` : '';
  return `Deployed to **${inputs.environment}** at [\`${run.sha.slice(0, 7)}\`](${commitUrl}) · [run ${run.runNumber}](${runUrl})${where}`;
}

/** The actor on every write: the deploy's own name. A pipeline claims on nobody's behalf. */
export function actor(run: Run): { kind: 'agent'; name: string; via: string } {
  return { kind: 'agent', name: `${run.repository} deploy`, via: 'GitHub Actions' };
}

/**
 * A status moves only a card that was waiting on a deploy — the one now in `blocked`. A
 * done card cited by a hotfix stays done; a card in triage keeps its question. `done`
 * itself is never sent: the server refuses it without a person's name, and the step has
 * none to give.
 */
export function moveTo(card: Pick<Card, 'status'>, status: string | undefined): string | null {
  if (!status || status === 'done') return null;
  return card.status === 'blocked' ? status : null;
}

export type Reached = { id: string; title: string; was: string; now: string; note?: string };

export type Outcome = {
  range: string;
  reached: Reached[];
  unknown: string[];
  warnings: string[];
};

/** The step summary, as GitHub renders it under the job. Never the link. */
export function summaryMarkdown(o: Outcome, inputs: Pick<Inputs, 'environment'>): string {
  const lines: string[] = [`### witness · deployed to ${inputs.environment}`, '', o.range, ''];
  if (o.reached.length === 0 && o.unknown.length === 0) {
    lines.push('No card was cited by these commits.');
  }
  if (o.reached.length > 0) {
    lines.push('| Card | Title | Was | Now |', '|---|---|---|---|');
    for (const r of o.reached) {
      const now = r.note ? `${r.now} — ${r.note}` : r.now;
      lines.push(`| ${r.id} | ${escapeCell(r.title)} | ${r.was} | ${now} |`);
    }
  }
  if (o.unknown.length > 0) {
    lines.push('', `Named no card in this project: ${o.unknown.join(', ')}`);
  }
  for (const w of o.warnings) lines.push('', `⚠ ${w}`);
  return lines.join('\n') + '\n';
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

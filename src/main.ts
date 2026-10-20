/**
 * The entry GitHub runs. Reads the inputs and the run's context from the environment, masks
 * the link, runs the step, writes the summary — and exits 0 whatever happened: a deploy is
 * never failed by the thing that reports it.
 */
import { appendFileSync } from 'node:fs';
import { GitHub } from './github.ts';
import { summaryMarkdown, type Inputs, type Run } from './lib.ts';
import { makeWitness, step } from './step.ts';

function input(name: string): string | undefined {
  const v = process.env[`INPUT_${name.toUpperCase()}`]?.trim();
  return v ? v : undefined;
}

function env(name: string): string {
  return process.env[name] ?? '';
}

function mask(secret: string): void {
  process.stdout.write(`::add-mask::${secret}\n`);
}

function warning(message: string): void {
  process.stdout.write(`::warning::witness-deployed: ${message.replace(/\r?\n/g, ' ')}\n`);
}

function summary(markdown: string): void {
  const file = env('GITHUB_STEP_SUMMARY');
  if (file) appendFileSync(file, markdown);
  else process.stdout.write(markdown);
}

function output(name: string, value: string): void {
  const file = env('GITHUB_OUTPUT');
  if (!file) return;
  const delimiter = `wd_${Date.now()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

async function main(): Promise<void> {
  const link = input('link');
  const environment = input('environment');
  if (!link || !environment) {
    warning('`link` and `environment` are required; nothing was written.');
    return;
  }
  mask(link);
  const token = input('token') ?? '';
  if (token) mask(token);

  const inputs: Inputs = { link, environment, url: input('url'), status: input('status'), since: input('since'), text: input('text') };
  const run: Run = {
    repository: env('GITHUB_REPOSITORY'),
    sha: env('GITHUB_SHA'),
    runId: env('GITHUB_RUN_ID'),
    runNumber: env('GITHUB_RUN_NUMBER'),
    serverUrl: env('GITHUB_SERVER_URL') || 'https://github.com',
  };
  const github = new GitHub({
    ...run,
    apiUrl: env('GITHUB_API_URL') || 'https://api.github.com',
    workflowRef: env('GITHUB_WORKFLOW_REF'),
    refName: env('GITHUB_REF_NAME'),
    token,
  });

  const outcome = await step(inputs, run, { witness: makeWitness(inputs, run), github });
  for (const w of outcome.warnings) warning(w);
  summary(summaryMarkdown(outcome, inputs));
  output('cards', JSON.stringify(outcome.reached));
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  warning(`${message}. Nothing more was written; the deploy is unaffected.`);
});

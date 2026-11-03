// src/main.ts
var import_node_fs = require("node:fs");

// src/github.ts
class GitHubRateLimited extends Error {
  resetAt;
  constructor(resetAt) {
    const when = resetAt ? ` (it resets at ${resetAt.toISOString().slice(11, 16)} UTC)` : "";
    super(`GitHub's API rate limit for this token was reached${when}`);
    this.resetAt = resetAt;
  }
}
var PULLS_PER_QUERY = 100;

class GitHub {
  ctx;
  fetchImpl;
  constructor(ctx, fetchImpl = (input, init) => fetch(input, init)) {
    this.ctx = ctx;
    this.fetchImpl = fetchImpl;
  }
  async previousDeploySha() {
    const file = workflowFile(this.ctx.workflowRef);
    if (!file)
      return null;
    const url = `${this.ctx.apiUrl}/repos/${this.ctx.repository}/actions/workflows/${encodeURIComponent(file)}/runs` + `?status=success&branch=${encodeURIComponent(this.ctx.refName)}&per_page=5`;
    const res = await this.get(url);
    if (res === "forbidden" || res === null)
      return res === null ? null : "forbidden";
    const previous = res.workflow_runs.find((r) => r.head_sha !== this.ctx.sha);
    return previous ? { sha: previous.head_sha, runNumber: previous.run_number } : null;
  }
  async commitsSince(base) {
    const commits = [];
    for (let page = 1;; page++) {
      const url = `${this.ctx.apiUrl}/repos/${this.ctx.repository}/compare/${base}...${this.ctx.sha}?per_page=100&page=${page}`;
      const res = await this.get(url, [404, 422]);
      if (res === "forbidden" || res === null)
        return page === 1 ? null : commits;
      commits.push(...res.commits.map((c) => ({ sha: c.sha, message: c.commit.message })));
      if (res.commits.length < 100 || commits.length >= res.total_commits)
        return commits;
    }
  }
  async mayReadPullRequests() {
    const url = `${this.ctx.apiUrl}/repos/${this.ctx.repository}/pulls?per_page=1&state=all`;
    const res = await this.get(url, [404]);
    return res !== "forbidden" && res !== null;
  }
  async pullRequestsOf(shas) {
    if (shas.length > PULLS_PER_QUERY)
      throw new Error(`at most ${PULLS_PER_QUERY} commits a query`);
    const [owner, name] = this.ctx.repository.split("/");
    const params = shas.map((_, i) => `$c${i}: GitObjectID!`).join(", ");
    const fields = shas.map((_, i) => `c${i}: object(oid: $c${i}) { ... on Commit { associatedPullRequests(first: 10) { nodes { number body baseRepository { nameWithOwner } } } } }`).join(" ");
    const query = `query($owner: String!, $name: String!, ${params}) { repository(owner: $owner, name: $name) { ${fields} } }`;
    const variables = { owner: owner ?? "", name: name ?? "" };
    shas.forEach((sha, i) => variables[`c${i}`] = sha);
    const res = await this.request(this.ctx.graphqlUrl ?? `${this.ctx.apiUrl}/graphql`, {
      method: "POST",
      body: JSON.stringify({ query, variables })
    }, [404]);
    if (res === "forbidden" || res === null)
      return "forbidden";
    const errors = res.errors ?? [];
    if (errors.some((e) => e.type === "RATE_LIMITED"))
      throw new GitHubRateLimited(null);
    if (errors.some((e) => e.type === "FORBIDDEN" || e.type === "NOT_FOUND"))
      return "forbidden";
    const repository = res.data?.repository;
    if (!repository)
      throw new Error(errors[0]?.message ?? "GitHub answered no repository");
    const here = this.ctx.repository.toLowerCase();
    return Object.values(repository).flatMap((commit) => (commit?.associatedPullRequests?.nodes ?? []).filter((p) => p.baseRepository?.nameWithOwner.toLowerCase() === here).map((p) => ({ repository: here, number: p.number, body: p.body ?? "" })));
  }
  async headCommit() {
    const url = `${this.ctx.apiUrl}/repos/${this.ctx.repository}/commits/${this.ctx.sha}`;
    const res = await this.get(url);
    if (res === "forbidden" || res === null)
      throw new Error("the token cannot read this repository's commits");
    return { sha: res.sha, message: res.commit.message };
  }
  get(url, nullOn = []) {
    return this.request(url, {}, nullOn);
  }
  async request(url, init, nullOn = []) {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.ctx.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.body ? { "Content-Type": "application/json" } : {}
      }
    });
    if (rateLimited(res))
      throw new GitHubRateLimited(resetAt(res));
    if (res.status === 401 || res.status === 403)
      return "forbidden";
    if (nullOn.includes(res.status))
      return null;
    if (!res.ok)
      throw new Error(`GitHub answered ${res.status} for ${url.replace(this.ctx.apiUrl, "")}`);
    return await res.json();
  }
}
function rateLimited(res) {
  if (res.status === 429)
    return true;
  if (res.status !== 403)
    return false;
  return res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after");
}
function resetAt(res) {
  const after = Number(res.headers.get("retry-after"));
  if (res.headers.has("retry-after") && Number.isFinite(after))
    return new Date(Date.now() + after * 1000);
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  return res.headers.has("x-ratelimit-reset") && Number.isFinite(reset) ? new Date(reset * 1000) : null;
}
function workflowFile(workflowRef) {
  const m = /\.github\/workflows\/([^@]+)@/.exec(workflowRef);
  return m?.[1] ?? null;
}

// src/lib.ts
function idPattern(prefixes) {
  const clean = prefixes.filter((p) => /^[A-Z]{2,4}$/.test(p));
  if (clean.length === 0)
    return null;
  return new RegExp(`(?<![A-Z])(?:${clean.join("|")})-\\d{2,}(?!\\d)`, "g");
}
function citedIds(commits, prefixes) {
  const pattern = idPattern(prefixes);
  if (!pattern)
    return [];
  const seen = new Set;
  for (const c of commits) {
    for (const m of c.message.matchAll(pattern))
      seen.add(m[0]);
  }
  return [...seen];
}
function idsOf(commits, text, prefixes) {
  const extra = text?.trim() ? [{ sha: "", message: text }] : [];
  return citedIds([...commits, ...extra], prefixes);
}
var shipsLine = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?(\*\*|__|\*|_)?ships(?![a-z0-9])(?::?\1:?)?(.*)$/i;
var fence = /^\s{0,3}(`{3,})(?!.*`)|^\s{0,3}(~{3,})/;
function declaredIds(bodies, prefixes) {
  const lines = [];
  for (const body of bodies) {
    let open = null;
    for (const line of body.split(/\r?\n/)) {
      const f = fence.exec(line);
      if (f) {
        const mark = f[1] ?? f[2];
        if (open === null)
          open = mark;
        else if (mark[0] === open[0] && mark.length >= open.length && line.trim() === mark)
          open = null;
        continue;
      }
      if (open !== null)
        continue;
      const m = shipsLine.exec(line);
      if (m)
        lines.push({ sha: "", message: m[2] });
    }
  }
  return citedIds(lines, prefixes);
}
function subject(message) {
  return message.split(`
`, 1)[0]?.trim() ?? "";
}
function commentBody(run, inputs) {
  const commitUrl = `${run.serverUrl}/${run.repository}/commit/${run.sha}`;
  const runUrl = `${run.serverUrl}/${run.repository}/actions/runs/${run.runId}`;
  const release = inputs.release?.trim() ? ` · ${inputs.release.trim()}` : "";
  const where = inputs.url ? ` — ${inputs.url}` : "";
  return `Deployed to **${inputs.environment}** at [\`${run.sha.slice(0, 7)}\`](${commitUrl})${release} · [run ${run.runNumber}](${runUrl})${where}`;
}
function runUrl(run) {
  return `${run.serverUrl}/${run.repository}/actions/runs/${run.runId}`;
}
function actor(run) {
  return { kind: "agent", name: `${run.repository} deploy`, via: "GitHub Actions" };
}
function moveTo(card, status) {
  if (!status || status === "done")
    return null;
  return card.status === "blocked" ? status : null;
}
function summaryMarkdown(o, inputs) {
  const lines = [`### witness · deployed to ${inputs.environment}`, "", o.range, ""];
  if (o.reached.length === 0 && o.unknown.length === 0) {
    lines.push("No card was cited by the commits, pull requests or text this deploy read.");
  }
  if (o.reached.length > 0) {
    lines.push("| Card | Title | Was | Now |", "|---|---|---|---|");
    for (const r of o.reached) {
      const now = r.note ? `${r.now} — ${r.note}` : r.now;
      lines.push(`| ${r.id} | ${escapeCell(r.title)} | ${r.was} | ${now} |`);
    }
  }
  if (o.unknown.length > 0) {
    lines.push("", `Named no card in this project: ${o.unknown.join(", ")}`);
  }
  for (const w of o.warnings)
    lines.push("", `⚠ ${w}`);
  return lines.join(`
`) + `
`;
}
function escapeCell(s) {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// src/witness.ts
class WitnessError extends Error {
  status;
  code;
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class Witness {
  link;
  actor;
  fetchImpl;
  constructor(link, actor, fetchImpl = (input, init) => fetch(input, init)) {
    this.link = link;
    this.actor = actor;
    this.fetchImpl = fetchImpl;
  }
  async prefixes() {
    const data = await this.call("GET", "/project.json");
    return data.project.areas.map((a) => a.prefix);
  }
  async card(id) {
    try {
      const data = await this.call("GET", `/cards/${id}.json`);
      const { id: cardId, title, status, version } = data.card;
      return { id: cardId, title, status, version };
    } catch (e) {
      if (e instanceof WitnessError && e.status === 404)
        return null;
      throw e;
    }
  }
  async comment(id, body) {
    await this.call("POST", `/cards/${id}/comments`, { body, actor: this.actor });
  }
  async recordDeploy(id, deploy) {
    try {
      await this.call("POST", `/cards/${id}/deploys`, { ...deploy, actor: this.actor });
      return true;
    } catch (e) {
      if (e instanceof WitnessError && e.status === 404)
        return false;
      throw e;
    }
  }
  async previousDeploy(repository, environment) {
    try {
      const data = await this.call("GET", "/deploys.json");
      return data.deploys.find((d) => d.repository === repository && d.environment === environment) ?? null;
    } catch (e) {
      if (e instanceof WitnessError && e.status === 404)
        return "unsupported";
      throw e;
    }
  }
  async recordProjectDeploy(deploy) {
    try {
      await this.call("POST", "/deploys", { ...deploy, actor: this.actor });
      return true;
    } catch (e) {
      if (e instanceof WitnessError && e.status === 404)
        return false;
      throw e;
    }
  }
  async setStatus(id, version, status) {
    await this.call("PATCH", `/cards/${id}`, { status, actor: this.actor }, { "If-Match": String(version) });
  }
  async call(method, path, body, headers = {}) {
    const res = await this.fetchImpl(this.link.replace(/\/+$/, "") + path, {
      method,
      headers: {
        Accept: "application/json",
        ...body !== undefined ? { "Content-Type": "application/json" } : {},
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = data ?? {};
      throw new WitnessError(res.status, err.error ?? "error", err.message ?? `${res.status} from witness`);
    }
    return data;
  }
}

// src/step.ts
function makeWitness(inputs, run, fetchImpl) {
  return new Witness(inputs.link, actor(run), fetchImpl);
}
async function step(inputs, run, clients) {
  const warnings = [];
  const prefixes = await clients.witness.prefixes();
  const found = await deployedCommits(inputs, run, clients, warnings);
  const declared = await shippedByPullRequests(found.commits, clients.github, prefixes, warnings);
  const ids = [...new Set([...idsOf(found.commits, inputs.text, prefixes), ...declared.ids])];
  let range = found.range;
  if (declared.pulls > 0)
    range += `, and the Ships lines of ${declared.pulls} pull request(s)`;
  if (inputs.text?.trim() && !found.textOnly)
    range += ", and the text given";
  if (inputs.status === "done") {
    warnings.push("`status: done` was ignored — done needs the name of a person who vouches, and a pipeline has none to give. The cards were commented on.");
  }
  const body = commentBody(run, inputs);
  let noRecord = false;
  const reached = [];
  const unknown = [];
  for (const id of ids) {
    const card = await clients.witness.card(id);
    if (!card) {
      unknown.push(id);
      continue;
    }
    const row = { id, title: card.title, was: card.status, now: card.status };
    try {
      await clients.witness.comment(id, body);
    } catch (e) {
      row.note = `comment refused: ${describe(e)}`;
      reached.push(row);
      continue;
    }
    try {
      const recorded = await clients.witness.recordDeploy(id, {
        environment: inputs.environment,
        sha: run.sha,
        release: inputs.release,
        url: inputs.url,
        run: runUrl(run)
      });
      if (!recorded && !noRecord) {
        noRecord = true;
        warnings.push("This witness keeps no deploy record yet (the comment landed; the list will not show the mark). Update witness to carry it.");
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
  try {
    await clients.witness.recordProjectDeploy({
      repository: run.repository,
      environment: inputs.environment,
      sha: run.sha,
      release: inputs.release,
      url: inputs.url,
      run: runUrl(run)
    });
  } catch (e) {
    warnings.push(`The deploy was not recorded on the project (${describe(e)}); the next run will compare from the one before.`);
  }
  return { range, reached, unknown, warnings };
}
async function shippedByPullRequests(commits, github, prefixes, warnings) {
  const bodies = new Map;
  const done = () => ({ ids: declaredIds([...bodies.values()], prefixes), pulls: bodies.size });
  const kept = () => bodies.size > 0 ? ` (the ${bodies.size} pull request(s) read before it count)` : "";
  const refused = () => warnings.push(`The token may not read pull requests (\`permissions: pull-requests: read\`), so their Ships lines were not read${kept()}; the commits were.`);
  if (commits.length === 0)
    return done();
  try {
    if (!await github.mayReadPullRequests()) {
      refused();
      return done();
    }
    for (let i = 0;i < commits.length; i += PULLS_PER_QUERY) {
      const pulls = await github.pullRequestsOf(commits.slice(i, i + PULLS_PER_QUERY).map((c) => c.sha));
      if (pulls === "forbidden") {
        refused();
        return done();
      }
      for (const p of pulls) {
        const key = `${p.repository}#${p.number}`;
        if (!bodies.has(key))
          bodies.set(key, p.body);
      }
    }
  } catch (e) {
    const why = e instanceof GitHubRateLimited ? e.message : `the pull requests could not be read (${describe(e)})`;
    warnings.push(`${capitalise(why)}, so the Ships lines of the pull requests not yet read were skipped${kept()}; the commits were read.`);
  }
  return done();
}
function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
async function deployedCommits(inputs, run, clients, warnings) {
  const { github, witness } = clients;
  const since = inputs.since?.trim();
  if (since) {
    const commits = await github.commitsSince(since);
    if (commits)
      return { commits, range: `${commits.length} commit(s) since \`${since.slice(0, 7)}\` (from \`since\`)` };
    warnings.push(`\`since: ${since.slice(0, 7)}\` is not a commit GitHub can compare from; ${nothingToCompareFrom(inputs)}.`);
    return fallback(inputs, github, "since could not be compared from");
  }
  const previous = await witness.previousDeploy(run.repository, inputs.environment);
  if (previous === "unsupported")
    return fromRuns(inputs, github, warnings, "older");
  if (previous === null)
    return fromRuns(inputs, github, warnings, "first");
  const commits = await github.commitsSince(previous.sha);
  if (commits === null) {
    warnings.push(`The previous deploy's commit \`${previous.sha.slice(0, 7)}\` is no longer in this repository; ${nothingToCompareFrom(inputs)}.`);
    return fallback(inputs, github, "the previous deploy is gone from the repository");
  }
  const named = previous.release ? ` (${previous.release})` : "";
  return { commits, range: `${commits.length} commit(s) since the previous deploy to ${inputs.environment}, \`${previous.sha.slice(0, 7)}\`${named}` };
}
async function fromRuns(inputs, github, warnings, why) {
  const first = `the first deploy to ${inputs.environment} recorded here`;
  const previous = await github.previousDeploySha();
  if (previous === "forbidden") {
    if (why === "first")
      return fallback(inputs, github, first);
    warnings.push(`The token may not read workflow runs (\`permissions: actions: read\`), so the previous deploy is unknown; ${nothingToCompareFrom(inputs)}. Pass \`since\`, grant the permission, or update witness, which then keeps the record itself.`);
    return fallback(inputs, github, "previous deploy unknown");
  }
  if (previous === null) {
    return fallback(inputs, github, why === "first" ? first : "no previous successful run of this workflow on this branch");
  }
  const commits = await github.commitsSince(previous.sha);
  if (commits === null) {
    warnings.push(`The previous deploy's commit \`${previous.sha.slice(0, 7)}\` is no longer in this branch's history; ${nothingToCompareFrom(inputs)}.`);
    return fallback(inputs, github, "the previous deploy is gone from the branch");
  }
  return { commits, range: `${commits.length} commit(s) since the previous deploy, \`${previous.sha.slice(0, 7)}\` (run ${previous.runNumber})` };
}
function nothingToCompareFrom(inputs) {
  return inputs.text?.trim() ? "the text alone was read" : "the head commit alone was read";
}
async function fallback(inputs, github, why) {
  if (inputs.text?.trim())
    return { commits: [], range: `the text given only — ${why}`, textOnly: true };
  const head = await github.headCommit();
  return { commits: [head], range: `the head commit only — ${why}: ${subject(head.message)}` };
}
function describe(e) {
  if (e instanceof WitnessError) {
    if (e.status === 403)
      return "this link cannot change cards (a view link comments only)";
    if (e.status === 409)
      return "the card changed while the step ran";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

// src/main.ts
function input(name) {
  const v = process.env[`INPUT_${name.toUpperCase()}`]?.trim();
  return v ? v : undefined;
}
function env(name) {
  return process.env[name] ?? "";
}
function mask(secret) {
  process.stdout.write(`::add-mask::${secret}
`);
}
function warning(message) {
  process.stdout.write(`::warning::witness-deployed: ${message.replace(/\r?\n/g, " ")}
`);
}
function summary(markdown) {
  const file = env("GITHUB_STEP_SUMMARY");
  if (file)
    import_node_fs.appendFileSync(file, markdown);
  else
    process.stdout.write(markdown);
}
function output(name, value) {
  const file = env("GITHUB_OUTPUT");
  if (!file)
    return;
  const delimiter = `wd_${Date.now()}`;
  import_node_fs.appendFileSync(file, `${name}<<${delimiter}
${value}
${delimiter}
`);
}
async function main() {
  const link = input("link");
  const environment = input("environment");
  if (!link || !environment) {
    warning("`link` and `environment` are required; nothing was written.");
    return;
  }
  mask(link);
  const token = input("token") ?? "";
  if (token)
    mask(token);
  const inputs = {
    link,
    environment,
    url: input("url"),
    status: input("status"),
    since: input("since"),
    text: input("text"),
    release: input("release")
  };
  const run = {
    repository: env("GITHUB_REPOSITORY"),
    sha: input("sha") ?? env("GITHUB_SHA"),
    runId: env("GITHUB_RUN_ID"),
    runNumber: env("GITHUB_RUN_NUMBER"),
    serverUrl: env("GITHUB_SERVER_URL") || "https://github.com"
  };
  const github = new GitHub({
    ...run,
    apiUrl: env("GITHUB_API_URL") || "https://api.github.com",
    graphqlUrl: env("GITHUB_GRAPHQL_URL") || undefined,
    workflowRef: env("GITHUB_WORKFLOW_REF"),
    refName: env("GITHUB_REF_NAME"),
    token
  });
  const outcome = await step(inputs, run, { witness: makeWitness(inputs, run), github });
  for (const w of outcome.warnings)
    warning(w);
  summary(summaryMarkdown(outcome, inputs));
  output("cards", JSON.stringify(outcome.reached));
}
main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  warning(`${message}. Nothing more was written; the deploy is unaffected.`);
});

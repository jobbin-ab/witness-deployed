# witness-deployed

A deploy step that tells the [witness](https://witness.nu) cards its commits cite that they
shipped. After a successful deploy it finds the card ids in the commits since the previous
deploy to that environment, comments on each card where and when it shipped, and, if your
workflow says so, moves the cards that were waiting on a deploy.

```yaml
- uses: jobbin-ab/witness-deployed@v1
  if: success()
  with:
    link: ${{ secrets.WITNESS_LINK }}
    environment: staging
    url: https://staging.example.com
    status: verify
```

What the card shows afterwards:

> Deployed to **staging** at `3f9c2a1` · run 4183 — https://staging.example.com
> — acme/shop deploy, via GitHub Actions

## What a deploy means is your project's rule

Witness does not know what a deploy to an environment means to your team. In one project a
deploy to staging means a person can verify now; in another nothing is verifiable before
production; in a third a deploy is a fact worth a line on the card and nothing more. Say
which in the project's working rules, so the agents know, and repeat it here, so the
pipeline does the same: one step per environment, each with the status that deploy earns,
or none.

## Inputs

| Input | Required | What it is |
|---|---|---|
| `link` | yes | A share link to the project, from **Share** on the project page. An edit link lets the step move cards; a view link lets it comment only. Keep it in a repository secret: the link is the whole access. |
| `environment` | yes | Where this deploy landed, as your team names it: `staging`, `production`, `preview`. |
| `url` | no | The address of that environment. Goes in the comment, so a person verifying can open it from the card. |
| `status` | no | A status to move cards to. Only cards now in **Blocked** move, the ones waiting on a deploy; a done card cited by a hotfix stays done. A status key from the project's document, usually `verify`. Never `done`: done needs the name of a person who vouches, and a pipeline has none to give. |
| `since` | no | The commit the previous deploy shipped. Left out, the step takes the previous successful run of this workflow on this branch. |
| `token` | no | Defaults to `github.token`. |

The status keys: `triage`, `investigating`, `decision`, `ready`, `blocked`, `verify`,
`byDesign`, `parked`, `cancelled`. A key the project does not have, or one that needs a
reason the step cannot give, is refused by the server and reported in the summary; the
card stays where it was.

## What it does, exactly

1. Reads the project's areas from the link. Their prefixes are the only ids a commit can
   cite here: `AL-04` counts when `AL` is one of your areas; a Jira key never does, and is
   never mentioned.
2. Finds the previous successful run of this workflow on this branch, and the commits
   between it and this one, from the GitHub API. No checkout, no history depth needed. On
   the first run, or when the token may not read runs, the head commit alone is read and
   the summary says so. `permissions: actions: read` on the job lets it read runs; or pass
   `since`.
3. For each cited card: one comment; the deploy record the card keeps per environment
   (what the list's mark and its filter read, and what an agent reads instead of the
   comment); and, when `status` is set and the card is in Blocked, one status change on
   the version it read. Every write carries the deploy's own name:
   `{"kind": "agent", "name": "<owner>/<repo> deploy", "via": "GitHub Actions"}`.
4. Writes the step summary: the cards reached with the status they had and have, and the
   ids that named no card. The link appears nowhere in the summary or the log.

It never fails the deploy. A project it cannot reach, a card it cannot change, a token
that cannot read runs: each is a warning on the step, and the job stays green.

## Any other CI

The step is a `git log` and three calls on the link. The link answers with its own
contract — fetch it with anything that is not a browser and read the calls under
*Working with cards*:

```bash
curl --fail-with-body -s "$WITNESS_LINK"
```

## Developing

```bash
bun install
bun run check          # typecheck, tests, build, and dist/ must be committed as built
```

The live tests run the whole step against a real witness project. Start a worker from the
witness repository (`bun run dev`), provision a project with two areas, and hand the tests
its links:

```bash
bun cli/witness.ts create --title "Deploy smoke" --areas "alerts:Alerts:AL,vx:VX:VX"
WITNESS_EDIT_LINK=… WITNESS_VIEW_LINK=… bun test
```

`dist/main.cjs` is what GitHub runs. Rebuild it with `bun run build` and commit it with the
change; the workflow refuses a commit that did not.

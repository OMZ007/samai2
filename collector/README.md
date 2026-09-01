# Survey collector

Responses from the course go to `responses/module-<n>/<timestamp>-<id>.json` on
the **`responses` branch** of this repository.

## There is no access token

The obvious design — a Worker that writes to GitHub — needs a personal access
token, and that token has to be scoped by hand, renewed before it expires, and
kept out of every file. Getting that wrong is silent: GitHub answers a token
that was never granted a repository with `404 Not Found`, which reads exactly
like a missing repository.

So the direction is reversed. Nothing pushes into the repository; **the
repository comes and takes**:

1. A learner submits. `worker.js` checks the shape and parks the JSON in a
   Cloudflare KV namespace. No GitHub involvement at all.
2. `.github/workflows/collect-responses.yml` wakes on a schedule, drains the
   Worker, and commits what it finds — signing with the `GITHUB_TOKEN` that
   GitHub hands every workflow run.

That built-in token is scoped to its own repository by definition. There is
nothing to select, tick, renew, or leak.

The only shared secret is `DRAIN_SECRET`, a random string that exists in two
places — a Worker secret and a repository secret — and guards the one endpoint
that can read the store. It is not a GitHub credential and grants nothing on
GitHub.

## Why the responses branch, not main

Pages builds from `main`. A response committed there would be fetchable straight
off the website (`omz007.github.io/samai2/responses/…`), and every submission
would rebuild the site — GitHub throttles at roughly ten builds an hour, so a
class submitting together would stall deploys. Nothing serves the `responses`
branch.

## Timing

The schedule is every ten minutes, but GitHub runs cron late under load and
stops scheduling entirely after 60 days with no push to the repository. Treat it
as *soon*, not *on time*. Nothing is lost while it waits — responses sit in KV
until a run collects them. To collect immediately:

```sh
gh workflow run "Collect survey responses" --repo OMZ007/samai2
```

## Losing nothing

The Worker forgets a batch only after the workflow reports that it pushed
(`/drain?ack=…`). A run that dies mid-commit leaves the batch in place and the
next round collects it again. Because the Worker chose each file's path when the
response arrived, collecting twice rewrites the same file rather than making a
second one.

If the collector is unreachable when a learner submits, the course keeps the
response in their browser and retries on later visits — see the survey section
of `index.html`.

## Reading the responses

```sh
git clone -b responses https://github.com/OMZ007/samai2.git responses-only
python collector/export_csv.py responses-only/responses > responses.csv
```

One row per response, one column per question, written with a BOM so Excel reads
the Arabic correctly.

## Redeploying the Worker

```sh
cd collector
npx wrangler deploy
```

Cloudflare account: the workers.dev subdomain is `omz007`, so the endpoint is
`https://samai-survey.omz007.workers.dev`. It is named in two places — the
`SURVEY_ENDPOINT` constant in `index.html` and the `ENDPOINT` env in the
workflow.

## Limits

- **Rejects** anything that is not JSON, is over 64 KB, comes from another
  origin, or is missing a name or answers.
- **Does not** stop a determined person from posting junk from a script — the
  origin check is a header, and headers can be set. For a public course that is
  usually fine. If it becomes a problem, put Cloudflare Turnstile in front and
  verify the token before the `RESPONSES.put` call.
- **No deduplication.** A learner who clears their browser storage and redoes a
  module submits again; both responses are kept.
- **Responses are public.** They carry learner names and this repository is
  public — the owner's explicit decision.

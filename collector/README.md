# Survey collector

The course site is static, so it cannot hold a credential — anything it carries
is handed to every learner who opens it. This Worker holds the credential
instead. The page posts a survey response to it; it checks the shape and writes
the response to a **private** repository as one JSON file.

## Why a separate private repository

Responses carry learner names, and the course repo is public — so they must not
go there. There is a second reason: every response is a commit, and a commit to
the course repo would rebuild GitHub Pages each time.

`wrangler.toml` therefore points at `OMZ007/samai2-responses`, not the course
repo. Create it private before deploying.

## Deploy

**1 · Create the responses repository**

```sh
gh repo create samai2-responses --private
```

**2 · Mint a token**

At <https://github.com/settings/personal-access-tokens/new>:

- Resource owner: your account
- Repository access: **Only select repositories** → `samai2-responses`
- Permissions → Repository permissions → **Contents: Read and write**
- Nothing else. No other repo, no other permission.

Set an expiry you will remember to renew — the Worker starts returning 502 the
day it lapses.

**3 · Deploy the Worker**

```sh
cd collector
npx wrangler login
npx wrangler secret put GITHUB_TOKEN   # paste the token; it is never in a file
npx wrangler deploy
```

Wrangler prints the URL, e.g. `https://samai-survey.<subdomain>.workers.dev`.

**4 · Point the course at it**

In `index.html`, find:

```js
const SURVEY_ENDPOINT = "";
```

and put the Worker URL in it. Commit and push; Pages redeploys in a minute or
two.

Until that line is filled in, the survey still runs and still gates the course —
responses are simply kept in the learner's browser instead of being sent.

## Check it works

```sh
curl -X POST https://samai-survey.<subdomain>.workers.dev \
  -H 'content-type: application/json' \
  -H 'Origin: https://omz007.github.io' \
  -d '{"module":1,"name":"اختبار","answers":[{"section":"س","question":"س","answer":"ج"}]}'
```

A `201` with `{"stored":"responses/module-1/…json"}` means the whole path is
live. Delete the test file from the responses repo afterwards.

## What gets stored

`responses/module-<n>/<timestamp>-<id>.json`:

```json
{
  "module": 3,
  "moduleTitle": "رفع الإنتاجية بالذكاء الاصطناعي",
  "name": "…",
  "submittedAt": "2026-09-01T10:02:11.402Z",
  "receivedAt": "2026-09-01T10:02:11.680Z",
  "country": "SA",
  "answers": [{ "section": "…", "question": "…", "answer": "…" }]
}
```

Each answer carries its own question text, so the data stays readable even after
the wording of a question changes.

## Reading the responses

```sh
gh repo clone OMZ007/samai2-responses
python collector/export_csv.py samai2-responses/responses > responses.csv
```

One row per response, one column per question.

## Limits

- **Rejects** anything that is not JSON, is over 64 KB, comes from another
  origin, or is missing a name or answers.
- **Does not** stop a determined person from posting junk from a script — the
  origin check is a header, and headers can be set. For a public course that is
  usually fine. If it becomes a problem, put Cloudflare Turnstile in front and
  verify the token in `fetch()` before the `commit()` call.
- **No deduplication.** A learner who clears their browser storage and redoes a
  module submits again; both responses are kept.

/**
 * The survey collector.
 *
 * The course is a static site, so it can hold no credential: anything it
 * carries is served to every learner. This Worker is the one party that
 * does. It takes a response from the page, checks its shape, and writes it
 * to a private repository as one JSON file.
 *
 * One file per response, named for the moment it arrived, so two learners
 * submitting at once cannot collide and nothing has to be read before it is
 * written.
 *
 * Configuration
 *   GITHUB_TOKEN     secret. Fine-grained PAT, "Contents: read and write" on
 *                    the responses repository and nothing else.
 *   GITHUB_REPO      var. "owner/name" of the repository responses go to.
 *   GITHUB_BRANCH    var. The branch inside it, and deliberately not the one
 *                    Pages builds from: a file on that branch would be served
 *                    by the website for anyone to fetch, and every response
 *                    would rebuild the site.
 *   ALLOWED_ORIGIN   var. The site allowed to post here. Comma-separated for
 *                    more than one.
 */

const MAX_BODY = 64 * 1024;
const MAX_ANSWERS = 60;
const MAX_NAME = 80;
const MAX_ANSWER = 2000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
    const ok = allowed.includes(origin) ? origin : allowed[0] || "*";

    const cors = {
      "Access-Control-Allow-Origin": ok,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin"
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (request.method !== "POST") return reply(405, "method not allowed", cors);

    // Only the course may post here.
    if (allowed.length && !allowed.includes(origin)) return reply(403, "origin not allowed", cors);

    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply(413, "too large", cors);

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, "not json", cors);
    }

    const clean = validate(body);
    if (!clean) return reply(400, "bad shape", cors);

    // What the page said, plus what only the edge can know.
    const record = {
      ...clean,
      receivedAt: new Date().toISOString(),
      country: request.headers.get("CF-IPCountry") || null
    };

    const stamp = record.receivedAt.replace(/[:.]/g, "-");
    const tag = crypto.randomUUID().slice(0, 8);
    const path = `responses/module-${record.module}/${stamp}-${tag}.json`;

    const written = await commit(env, path, record);
    if (!written.ok) {
      // GitHub's own words, not just the number: a bare 404 reads as a
      // missing repository when it usually means a token that was never
      // granted one.
      return reply(502, `store failed: ${written.status}${written.said ? ` (${written.said})` : ""}`, cors);
    }

    return new Response(JSON.stringify({ stored: path }), {
      status: 201,
      headers: { ...cors, "content-type": "application/json" }
    });
  }
};

function reply(status, message, cors) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...cors, "content-type": "application/json" }
  });
}

const text = (value, max) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max ? value.trim() : null;

/** Returns the response in the only shape that gets stored, or null. */
function validate(body) {
  if (!body || typeof body !== "object") return null;

  const module = Number(body.module);
  if (!Number.isInteger(module) || module < 1 || module > 50) return null;

  const name = text(body.name, MAX_NAME);
  if (!name) return null;

  if (!Array.isArray(body.answers) || !body.answers.length || body.answers.length > MAX_ANSWERS) return null;

  const answers = [];
  for (const item of body.answers) {
    if (!item || typeof item !== "object") return null;
    const question = text(item.question, MAX_ANSWER);
    const answer = text(item.answer, MAX_ANSWER);
    if (!question || !answer) return null;
    answers.push({
      section: text(item.section, MAX_ANSWER) || "",
      question,
      answer
    });
  }

  return {
    module,
    moduleTitle: text(body.moduleTitle, 200) || "",
    name,
    submittedAt: text(body.submittedAt, 40) || null,
    answers
  };
}

/** Writes one file to the responses repository. */
async function commit(env, path, record) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  const content = b64(JSON.stringify(record, null, 2));

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "samai-survey-collector",
      "content-type": "application/json"
    },
    // Only name a branch when one is configured. Naming one that does not
    // exist is a 404, so the unset case has to mean "the default branch"
    // rather than a guess.
    body: JSON.stringify({
      message: `survey: module ${record.module}`,
      content,
      ...(env.GITHUB_BRANCH ? { branch: env.GITHUB_BRANCH } : {})
    })
  });

  let said = null;
  if (!response.ok) {
    try {
      said = (await response.json())?.message || null;
    } catch {
      /* not json */
    }
  }

  return { ok: response.ok, status: response.status, said };
}

/** Base64 of a UTF-8 string. btoa alone mangles anything above Latin-1. */
function b64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

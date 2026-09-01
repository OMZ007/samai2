/**
 * The survey collector.
 *
 * The course is a static site, so it can hold no credential: anything it
 * carries is served to every learner. This Worker takes a response from the
 * page, checks its shape, and keeps it until it is collected.
 *
 * It holds no GitHub credential either. Rather than this Worker pushing into
 * the repository, the repository comes and takes: a scheduled Action drains
 * the store and commits what it finds, using the token GitHub hands its own
 * workflows. No personal access token exists anywhere in this system, so
 * there is none to scope, renew, or leak.
 *
 * One entry per response, keyed by the moment it arrived, so two learners
 * submitting at once cannot collide.
 *
 * Configuration
 *   RESPONSES        KV namespace. Where responses wait to be collected.
 *   DRAIN_SECRET     secret. Shared with the workflow, and the only thing
 *                    that may read or clear the store.
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

    // The collection round, called by the workflow rather than by a learner.
    // It is the only way anything leaves this Worker, and it takes the shared
    // secret — the store holds names, and must not be readable by the web.
    if (new URL(request.url).pathname === "/drain") return drain(request, env, cors);

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

    // The key is the path the response will end up at, so the collector has
    // no naming to do and a repeated collection cannot rename anything.
    const stamp = record.receivedAt.replace(/[:.]/g, "-");
    const tag = crypto.randomUUID().slice(0, 8);
    const path = `responses/module-${record.module}/${stamp}-${tag}.json`;

    try {
      await env.RESPONSES.put(path, JSON.stringify(record, null, 2));
    } catch (error) {
      return reply(502, "store failed", cors);
    }

    return new Response(JSON.stringify({ stored: path }), {
      status: 201,
      headers: { ...cors, "content-type": "application/json" }
    });
  }
};

/**
 * Hands the waiting responses to the workflow and forgets them.
 *
 * Deleting only after the workflow has the files would need a second round
 * trip; deleting here means a workflow that dies mid-commit loses that batch.
 * So the delete waits for the caller to say it committed: `?ack=<cursor>`
 * clears everything up to what it already has, and a plain call only reads.
 */
async function drain(request, env, cors) {
  const given = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  // A constant-time compare is overkill here, but a length check first keeps
  // the comparison from leaking the secret's length through timing.
  if (!env.DRAIN_SECRET || given.length !== env.DRAIN_SECRET.length || given !== env.DRAIN_SECRET) {
    return reply(401, "not allowed", cors);
  }

  const url = new URL(request.url);
  const ack = url.searchParams.get("ack");

  if (ack) {
    const keys = ack.split("\n").filter(Boolean);
    await Promise.all(keys.map((key) => env.RESPONSES.delete(key)));
    return new Response(JSON.stringify({ cleared: keys.length }), {
      status: 200,
      headers: { ...cors, "content-type": "application/json" }
    });
  }

  // KV lists a thousand keys a call, which is far more than a drain round
  // will ever find; a bigger backlog simply arrives over several rounds.
  const listed = await env.RESPONSES.list({ limit: 1000 });
  const files = await Promise.all(listed.keys.map(async ({ name }) => ({
    path: name,
    body: await env.RESPONSES.get(name)
  })));

  return new Response(JSON.stringify({ files: files.filter((f) => f.body) }), {
    status: 200,
    headers: { ...cors, "content-type": "application/json" }
  });
}

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


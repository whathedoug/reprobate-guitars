// Cloudflare Worker for reprobate-guitars.com
//
//   POST /contact           quote form: emails the request (with photos) to the shop
//   GET  /guestbook         public list of guestbook entries (newest first)
//   POST /guestbook         sign the guestbook (posts instantly, with filters + rate limit)
//   GET  /guestbook/delete  confirm page opened from the shop owner's email link
//   POST /guestbook/delete  actually deletes the entry (needs the secret token from the email)
//
// Email uses Cloudflare Email Routing's "send_email" binding, so no third-party service
// and no API keys are needed. The recipient must be a *verified destination address*
// in Cloudflare Email Routing (see worker/README.md). Guestbook entries live in a D1 database.

import { EmailMessage } from "cloudflare:email";

const ALLOWED_ORIGINS = [
  "https://reprobate-guitars.com",
  "https://www.reprobate-guitars.com",
  "https://whathedoug.github.io", // GitHub Pages address, handy for testing
];

const MAX_PHOTOS = 5;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024; // keep the whole email comfortably under limits

const GB_MAX_NAME = 40;
const GB_MAX_LOCATION = 60;
const GB_MAX_MESSAGE = 500;
const GB_LIST_LIMIT = 50;
const GB_PER_PERSON_PER_HOUR = 3;
const GB_ALL_PER_HOUR = 60; // flood brake for the whole guestbook

/* ---------- Small helpers ---------- */

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(origin) },
  });
}

function htmlPage(title, bodyHtml, status = 200) {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>body{font-family:Verdana,sans-serif;background:#0a0a0a;color:#f5efe0;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.5}
h1{color:#f4c430}blockquote{background:#1a1a1a;border-left:6px solid #c8203c;margin:16px 0;padding:10px 14px;white-space:pre-wrap;overflow-wrap:anywhere}
button{font:inherit;font-size:1.1rem;padding:12px 20px;background:#c8203c;color:#fff;border:3px outset #e65a70;cursor:pointer}a{color:#f4c430}</style>
</head><body>${bodyHtml}</body></html>`;
  return new Response(page, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Strip line breaks so nobody can inject extra email headers.
const oneLine = (s) => String(s || "").replace(/[\r\n]+/g, " ").trim();

// Remove control characters but keep normal newlines, then trim.
const cleanText = (s) => String(s || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Compare two strings without bailing out at the first difference.
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Encode a header value that may contain non-ASCII characters.
function encodeHeader(s) {
  const clean = oneLine(s);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const bytes = new TextEncoder().encode(clean);
  return "=?UTF-8?B?" + toBase64(bytes) + "?=";
}

function toBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Base64 broken into 76-character lines, as email requires.
const wrap76 = (b64) => b64.replace(/(.{76})/g, "$1\r\n");

function buildEmail({ from, to, replyTo, subject, text, attachments }) {
  const boundary = "rg-" + crypto.randomUUID();
  const lines = [
    `From: Reprobate Guitars Website <${from}>`,
    `To: ${to}`,
    `Reply-To: ${replyTo}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@reprobate-guitars.com>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(toBase64(new TextEncoder().encode(text))),
  ];

  for (const a of attachments) {
    const safeName = a.name.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "photo.jpg";
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.type}; name="${safeName}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${safeName}"`,
      "",
      wrap76(toBase64(a.bytes)),
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

/* ---------- Quote form ---------- */

async function handleContact(request, env, origin) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "Could not read the form." }, 400, origin);
  }

  // Honeypot: bots fill this in. Pretend it worked, send nothing.
  if (String(form.get("website") || "").trim() !== "") {
    return json({ ok: true }, 200, origin);
  }

  const name = oneLine(form.get("name")).slice(0, 100);
  const email = oneLine(form.get("email")).slice(0, 150);
  const phone = oneLine(form.get("phone")).slice(0, 30);
  const instrument = oneLine(form.get("instrument")).slice(0, 150);
  const service = oneLine(form.get("service")).slice(0, 60);
  const message = String(form.get("message") || "").trim().slice(0, 4000);

  if (!name || !email || !message) {
    return json({ ok: false, error: "Please fill in your name, email and message." }, 400, origin);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ ok: false, error: "That email address doesn't look right." }, 400, origin);
  }

  // Photos
  const attachments = [];
  let total = 0;
  for (const f of form.getAll("photos")) {
    if (typeof f === "string" || !f.size) continue;
    if (attachments.length >= MAX_PHOTOS) break;
    if (!f.type.startsWith("image/")) continue;
    total += f.size;
    if (total > MAX_TOTAL_BYTES) {
      return json({ ok: false, error: "Those photos are too big in total. Try fewer photos." }, 413, origin);
    }
    attachments.push({ name: f.name || "photo.jpg", type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
  }

  const text = [
    "New request from the Reprobate Guitars website",
    "-----------------------------------------------",
    `Name:       ${name}`,
    `Email:      ${email}`,
    `Phone:      ${phone || "(not given)"}`,
    `Instrument: ${instrument || "(not given)"}`,
    `Service:    ${service || "(not given)"}`,
    `Photos:     ${attachments.length}`,
    "",
    "Message:",
    message,
    "",
    "-----------------------------------------------",
    "Hit Reply to answer the customer directly.",
  ].join("\r\n");

  const raw = buildEmail({
    from: env.FROM_ADDRESS,
    to: env.TO_ADDRESS,
    replyTo: email,
    subject: `New quote request: ${name}${instrument ? " - " + instrument : ""}`,
    text,
    attachments,
  });

  try {
    await env.EMAIL.send(new EmailMessage(env.FROM_ADDRESS, env.TO_ADDRESS, raw));
  } catch (err) {
    console.error("send failed", err && err.message);
    return json({ ok: false, error: "We couldn't send that just now." }, 502, origin);
  }

  return json({ ok: true }, 200, origin);
}

/* ---------- Guestbook ---------- */

// Links and email addresses are not allowed in guestbook posts (keeps spam out).
const LINKISH = /(https?:|ftp:|www\.|@|\b[a-z0-9-]+\.(com|net|org|info|biz|xyz|top|site|online|shop|click|link|ru|cn|io|co|me|ly|app|dev|store|club|vip)\b)/i;

async function guestbookList(env, origin) {
  const rows = await env.DB.prepare(
    "SELECT id, name, location, message, created_at FROM entries ORDER BY created_at DESC, id DESC LIMIT ?",
  ).bind(GB_LIST_LIMIT).all();
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM entries").first();
  return json({ ok: true, total: count ? count.n : 0, entries: rows.results || [] }, 200, origin);
}

async function guestbookAdd(request, env, ctx, origin) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "Could not read the form." }, 400, origin);
  }

  // Honeypot: pretend it worked.
  if (String(form.get("website") || "").trim() !== "") {
    return json({ ok: true }, 200, origin);
  }

  const name = cleanText(oneLine(form.get("name")));
  const location = cleanText(oneLine(form.get("location")));
  const message = cleanText(form.get("message"));

  if (!name || !message) {
    return json({ ok: false, error: "Please fill in your name and a message." }, 400, origin);
  }
  if (name.length > GB_MAX_NAME || location.length > GB_MAX_LOCATION || message.length > GB_MAX_MESSAGE) {
    return json({ ok: false, error: `Too long! Keep your message under ${GB_MAX_MESSAGE} characters.` }, 400, origin);
  }
  if (message.length < 2) {
    return json({ ok: false, error: "Say a little more than that!" }, 400, origin);
  }
  if (LINKISH.test(name) || LINKISH.test(location) || LINKISH.test(message)) {
    return json({ ok: false, error: "No links or email addresses in the guestbook, please." }, 400, origin);
  }

  // Rate limits
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256Hex(ip + "|rg-guestbook");
  const hourAgo = Math.floor(Date.now() / 1000) - 3600;

  const mine = await env.DB.prepare("SELECT COUNT(*) AS n FROM entries WHERE ip_hash = ? AND created_at > ?")
    .bind(ipHash, hourAgo).first();
  if (mine && mine.n >= GB_PER_PERSON_PER_HOUR) {
    return json({ ok: false, error: "You've signed a few times already. Come back in a little while!" }, 429, origin);
  }
  const all = await env.DB.prepare("SELECT COUNT(*) AS n FROM entries WHERE created_at > ?").bind(hourAgo).first();
  if (all && all.n >= GB_ALL_PER_HOUR) {
    return json({ ok: false, error: "The guestbook is getting a lot of traffic. Try again in a bit!" }, 429, origin);
  }

  const now = Math.floor(Date.now() / 1000);
  const token = randomHex(24);
  const result = await env.DB.prepare(
    "INSERT INTO entries (name, location, message, created_at, ip_hash, del_token) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(name, location, message, now, ipHash, token).run();
  const id = result.meta.last_row_id;

  // Tell the shop owner, with a delete link. If email fails the entry still stands.
  const deleteUrl = `${new URL(request.url).origin}/guestbook/delete?id=${id}&t=${token}`;
  const text = [
    "Someone signed the Reprobate Guitars guestbook (it is already live on the site).",
    "-----------------------------------------------",
    `Name:     ${name}`,
    `From:     ${location || "(not given)"}`,
    "",
    message,
    "",
    "-----------------------------------------------",
    "Don't like it? Open this link and press the delete button:",
    deleteUrl,
  ].join("\r\n");

  const raw = buildEmail({
    from: env.FROM_ADDRESS,
    to: env.TO_ADDRESS,
    replyTo: env.TO_ADDRESS,
    subject: `Guestbook: new entry from ${name}`,
    text,
    attachments: [],
  });
  ctx.waitUntil(
    env.EMAIL.send(new EmailMessage(env.FROM_ADDRESS, env.TO_ADDRESS, raw)).catch((err) =>
      console.error("guestbook notify failed", err && err.message),
    ),
  );

  return json({ ok: true }, 200, origin);
}

// Page opened from the email link. Shows the entry and a button. A scanner that merely
// opens the link cannot delete anything, because deleting needs a button press (POST).
async function guestbookDeletePage(url, env) {
  const id = Number(url.searchParams.get("id"));
  const t = url.searchParams.get("t") || "";
  const row = Number.isInteger(id) ? await env.DB.prepare("SELECT name, location, message, del_token FROM entries WHERE id = ?").bind(id).first() : null;
  if (!row || !safeEqual(row.del_token, t)) {
    return htmlPage("Not found", "<h1>Not found</h1><p>That entry doesn't exist any more, or the link is wrong.</p>", 404);
  }
  return htmlPage(
    "Delete guestbook entry",
    `<h1>Delete this entry?</h1>
<blockquote><b>${escapeHtml(row.name)}</b>${row.location ? " from " + escapeHtml(row.location) : ""}\n\n${escapeHtml(row.message)}</blockquote>
<form method="POST" action="/guestbook/delete">
<input type="hidden" name="id" value="${id}"><input type="hidden" name="t" value="${escapeHtml(t)}">
<button type="submit">Yes, delete it</button></form>`,
  );
}

async function guestbookDelete(request, env) {
  const form = await request.formData();
  const id = Number(form.get("id"));
  const t = String(form.get("t") || "");
  const row = Number.isInteger(id) ? await env.DB.prepare("SELECT del_token FROM entries WHERE id = ?").bind(id).first() : null;
  if (!row || !safeEqual(row.del_token, t)) {
    return htmlPage("Not found", "<h1>Not found</h1><p>That entry doesn't exist any more, or the link is wrong.</p>", 404);
  }
  await env.DB.prepare("DELETE FROM entries WHERE id = ?").bind(id).run();
  return htmlPage("Deleted", '<h1>Deleted.</h1><p>The entry is gone from the guestbook.</p><p><a href="https://reprobate-guitars.com/#guestbook">Back to the site</a></p>');
}

/* ---------- Router ---------- */

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    try {
      // Pages opened straight from the owner's email (no Origin header, secured by the token)
      if (path === "/guestbook/delete") {
        if (request.method === "GET") return await guestbookDeletePage(url, env);
        if (request.method === "POST") return await guestbookDelete(request, env);
      }

      // Public guestbook list (read only)
      if (path === "/guestbook" && request.method === "GET") {
        return await guestbookList(env, origin);
      }

      // Everything below only accepts posts from our own website
      if (request.method === "POST" && (path === "/contact" || path === "/guestbook")) {
        if (!ALLOWED_ORIGINS.includes(origin)) {
          return json({ ok: false, error: "Not allowed." }, 403, origin);
        }
        if (path === "/contact") return await handleContact(request, env, origin);
        return await guestbookAdd(request, env, ctx, origin);
      }
    } catch (err) {
      console.error("unhandled", err && err.message);
      return json({ ok: false, error: "Something went wrong on our end." }, 500, origin);
    }

    return json({ ok: false, error: "Not found." }, 404, origin);
  },
};

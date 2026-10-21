// Cloudflare Worker: receives the quote form and emails it to the shop.
//
// Uses Cloudflare Email Routing's "send_email" binding, so no third-party service
// and no API keys are needed. The recipient must be a *verified destination address*
// in Cloudflare Email Routing (see worker/README.md).

import { EmailMessage } from "cloudflare:email";

const ALLOWED_ORIGINS = [
  "https://reprobate-guitars.com",
  "https://www.reprobate-guitars.com",
  "https://whathedoug.github.io", // GitHub Pages address, handy for testing
];

const MAX_PHOTOS = 5;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024; // keep the whole email comfortably under limits

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

// Strip line breaks so nobody can inject extra email headers.
const oneLine = (s) => String(s || "").replace(/[\r\n]+/g, " ").trim();

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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (request.method !== "POST" || url.pathname !== "/contact") {
      return json({ ok: false, error: "Not found." }, 404, origin);
    }
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ ok: false, error: "Not allowed." }, 403, origin);
    }

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
  },
};

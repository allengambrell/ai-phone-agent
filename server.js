// server.js
const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

const OPENAI_KEY = process.env.OPENAI_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // https://...railway.app
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

const OWNER_NAME = process.env.OWNER_NAME || "Allen";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "AI Phone Agent";

// Use the model you already confirmed works for voice.
// If you changed it, update here.
const VOICE_MODEL =
  process.env.VOICE_MODEL || "gpt-4o-realtime-preview-2024-12-17";

const RECORDING_WEBHOOK_SECRET = process.env.RECORDING_WEBHOOK_SECRET;

// --------- in-memory recording store for "listen" links ---------
const recordingStore = new Map(); // token -> { mp3: Buffer, createdAt, meta }
const RECORDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

setInterval(() => {
  const now = Date.now();
  for (const [token, item] of recordingStore.entries()) {
    if (now - item.createdAt > RECORDING_TTL_MS) recordingStore.delete(token);
  }
}, 60 * 60 * 1000).unref();

// --------- nodemailer transport ---------
function getMailer() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM || !EMAIL_TO) {
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

app.get("/", (req, res) => res.send("OK"));

// Listen link (MP3)
app.get("/listen/:token", (req, res) => {
  const item = recordingStore.get(req.params.token);
  if (!item) return res.status(404).send("Not found (expired or invalid).");

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Disposition", 'inline; filename="call.mp3"');
  res.send(item.mp3);
});

// --------------------
// Twilio Voice webhook
// --------------------
// Starts call recording + media stream
app.post("/voice", (req, res) => {
  if (!PUBLIC_BASE_URL) {
    return res
      .status(500)
      .type("text/plain")
      .send("Missing PUBLIC_BASE_URL env var.");
  }
  if (!RECORDING_WEBHOOK_SECRET) {
    return res
      .status(500)
      .type("text/plain")
      .send("Missing RECORDING_WEBHOOK_SECRET env var.");
  }

  // Twilio <Start><Recording> begins recording immediately, before other TwiML :contentReference[oaicite:1]{index=1}
  const callbackUrl = `${PUBLIC_BASE_URL}/recording-status?secret=${encodeURIComponent(
    RECORDING_WEBHOOK_SECRET
  )}`;

  const twiml = `
<Response>
  <Start>
    <Recording
      channels="dual"
      recordingStatusCallback="${callbackUrl}"
      recordingStatusCallbackEvent="completed"
    />
  </Start>
  <Connect>
    <Stream url="wss://${req.headers.host}/media"/>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// -------------------------------
// Twilio recording status callback
// -------------------------------
// Twilio POSTs params like RecordingSid, RecordingUrl, RecordingDuration, CallSid, etc. :contentReference[oaicite:2]{index=2}
app.post("/recording-status", async (req, res) => {
  try {
    const secret = req.query.secret;
    if (!RECORDING_WEBHOOK_SECRET || secret !== RECORDING_WEBHOOK_SECRET) {
      return res.status(403).send("Forbidden");
    }

    const {
      CallSid,
      RecordingSid,
      RecordingUrl,
      RecordingStatus,
      RecordingDuration,
    } = req.body;

    // Acknowledge quickly so Twilio is happy
    res.status(200).send("OK");

    if (RecordingStatus !== "completed") return;
    if (!RecordingSid || !RecordingUrl) return;

    console.log(
      "Recording completed:",
      RecordingSid,
      "duration:",
      RecordingDuration
    );

    // RecordingUrl from Twilio can be fetched as an MP3 by appending .mp3 :contentReference[oaicite:3]{index=3}
    const mp3Url = `${RecordingUrl}.mp3`;

    if (!TWILIO_AUTH_TOKEN) {
      console.log("Missing TWILIO_AUTH_TOKEN; cannot download recording.");
      return;
    }

    // Download recording (Twilio uses HTTP Basic auth: AccountSid:AuthToken.
    // For the media file, providing AuthToken as the password is sufficient when using the RecordingUrl.)
    const mp3 = await downloadWithTwilioAuth(mp3Url, TWILIO_AUTH_TOKEN);

    // Transcribe via OpenAI Audio Transcriptions endpoint :contentReference[oaicite:4]{index=4}
    const transcript = await transcribeMp3WithOpenAI(mp3);

    // Summarize transcript (actions + summary)
    const summary = await summarizeTranscript(transcript);

    // Create a private listen link
    const token = crypto.randomBytes(24).toString("hex");
    recordingStore.set(token, {
      mp3,
      createdAt: Date.now(),
      meta: { CallSid, RecordingSid, RecordingDuration },
    });

    const listenLink = `${PUBLIC_BASE_URL}/listen/${token}`;

    // Email it
    await emailResults({
      subject: `Call Recording + Transcript (${RecordingDuration || "?"}s)`,
      transcript,
      summary,
      listenLink,
      meta: { CallSid, RecordingSid, RecordingDuration },
    });

    console.log("Email sent for RecordingSid:", RecordingSid);
  } catch (err) {
    console.log("recording-status handler error:", err?.message || err);
  }
});

async function downloadWithTwilioAuth(url, authToken) {
  // Twilio recording media download supports .mp3 :contentReference[oaicite:5]{index=5}
  // Use Basic auth with AuthToken as password; username can be blank in many environments.
  // If your environment requires AccountSid as username, we can add it later.
  const basic = Buffer.from(`:${authToken}`).toString("base64");

  const resp = await fetch(url, {
    headers: { Authorization: `Basic ${basic}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Twilio download failed ${resp.status}: ${text}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function transcribeMp3WithOpenAI(mp3Buffer) {
  if (!OPENAI_KEY) throw new Error("Missing OPENAI_KEY");

  // Node 22 has Blob/FormData globally
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([mp3Buffer], { type: "audio/mpeg" }),
    "call.mp3"
  );
  fd.append("model", "gpt-4o-mini-transcribe"); // supported by /v1/audio/transcriptions :contentReference[oaicite:6]{index=6}

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: fd,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI transcription failed ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  // API returns { text: "..." } for simple transcriptions
  return (data.text || "").trim();
}

async function summarizeTranscript(transcript) {
  if (!OPENAI_KEY) throw new Error("Missing OPENAI_KEY");

  const prompt = `Summarize this phone call transcript.
Return:
1) A short summary (3-6 bullets)
2) Action items (bullets)
3) Key details (Caller name/number if present, reason, requested follow-up)

Transcript:
${transcript}`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 500,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI summarize failed ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function emailResults({ subject, transcript, summary, listenLink, meta }) {
  const mailer = getMailer();
  if (!mailer) {
    console.log(
      "Email not configured (SMTP_* / EMAIL_* missing). Skipping email."
    );
    return;
  }

  const body = `
${BUSINESS_NAME} — Call processed

Listen:
${listenLink}

Recording meta:
- RecordingSid: ${meta.RecordingSid || ""}
- CallSid: ${meta.CallSid || ""}
- Duration: ${meta.RecordingDuration || ""} seconds

Summary:
${summary}

Transcript:
${transcript}
`.trim();

  await mailer.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    text: body,
  });
}

// --------------------
// Realtime voice bridge
// --------------------
const server = app.listen(PORT, () => console.log("Server running on port", PORT));
const wss = new WebSocket.Server({ server, path: "/media" });

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
}

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");

  let streamSid = null;

  // Queue audio until Twilio start arrives
  const audioQueue = [];
  const MAX_AUDIO_QUEUE = 300;

  function sendAudioToTwilio(base64Mulaw) {
    if (!base64Mulaw) return;

    if (!streamSid) {
      audioQueue.push(base64Mulaw);
      if (audioQueue.length > MAX_AUDIO_QUEUE) audioQueue.shift();
      return;
    }

    safeSend(twilioWs, {
      event: "media",
      streamSid,
      media: { payload: base64Mulaw },
    });
  }

  if (!OPENAI_KEY) {
    console.log("Missing OPENAI_KEY; closing stream.");
    try { twilioWs.close(); } catch {}
    return;
  }

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(VOICE_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let responseInProgress = false;

  openaiWs.on("open", () => {
    console.log("OpenAI realtime connected");

    safeSend(openaiWs, {
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "alloy",
        turn_detection: { type: "server_vad" },
        instructions: `
You are a friendly, professional phone answering assistant for ${OWNER_NAME}.
- Greet the caller and ask how you can help.
- Keep answers concise.
- If asked to speak to ${OWNER_NAME}, say you’ll take a message and pass it along.
`,
      },
    });

    // Speak first
    safeSend(openaiWs, {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: "Greet the caller warmly and ask how you can help.",
      },
    });
    responseInProgress = true;
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "error") {
      console.log("OpenAI ERROR:", JSON.stringify(msg, null, 2));
      return;
    }

    const audioDelta =
      (msg.type === "response.audio.delta" && msg.delta) ||
      (msg.type === "response.output_audio.delta" && msg.delta);

    if (audioDelta) sendAudioToTwilio(audioDelta);

    if (msg.type === "response.created") responseInProgress = true;
    if (msg.type === "response.done") responseInProgress = false;

    // When user stops talking, commit and respond (if not already responding)
    if (msg.type === "input_audio_buffer.speech_stopped") {
      if (!responseInProgress) {
        safeSend(openaiWs, { type: "input_audio_buffer.commit" });
        safeSend(openaiWs, {
          type: "response.create",
          response: { modalities: ["audio", "text"] },
        });
        responseInProgress = true;
      }
    }
  });

  openaiWs.on("close", () => console.log("OpenAI WS closed"));
  openaiWs.on("error", (e) => console.log("OpenAI WS error:", e?.message || e));

  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      console.log("Stream started:", streamSid);

      // Flush queued audio
      while (audioQueue.length) {
        const b64 = audioQueue.shift();
        safeSend(twilioWs, { event: "media", streamSid, media: { payload: b64 } });
      }
      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload) return;
      safeSend(openaiWs, { type: "input_audio_buffer.append", audio: payload });
      return;
    }

    if (msg.event === "stop") {
      console.log("Twilio stream stop");
      try { openaiWs.close(); } catch {}
      try { twilioWs.close(); } catch {}
    }
  });

  const cleanup = () => {
    try { openaiWs.close(); } catch {}
    try { twilioWs.close(); } catch {}
  };

  twilioWs.on("close", cleanup);
  twilioWs.on("error", cleanup);
});

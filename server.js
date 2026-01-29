// server.js
const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const app = express();

// Twilio callbacks are application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

const OPENAI_KEY = process.env.OPENAI_KEY;

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // https://...railway.app
const RECORDING_WEBHOOK_SECRET = process.env.RECORDING_WEBHOOK_SECRET;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID; // AC...
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

const OWNER_NAME = process.env.OWNER_NAME || "Allen";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "AI Phone Agent";
const VOICE_MODEL =
  process.env.VOICE_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// In-memory storage for listen links (MP3 bytes)
const recordingStore = new Map(); // token -> { mp3: Buffer, createdAt, meta }
const RECORDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

setInterval(() => {
  const now = Date.now();
  for (const [token, item] of recordingStore.entries()) {
    if (now - item.createdAt > RECORDING_TTL_MS) recordingStore.delete(token);
  }
}, 60 * 60 * 1000).unref();

// ------------ Email transport ------------
function getMailer() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM || !EMAIL_TO) return null;
return nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false, // STARTTLS
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  tls: {
    rejectUnauthorized: false,
  },
});

}

app.get("/", (req, res) => res.send("OK"));

// Private listen link
app.get("/listen/:token", (req, res) => {
  const item = recordingStore.get(req.params.token);
  if (!item) return res.status(404).send("Not found (expired or invalid).");
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Disposition", 'inline; filename="call.mp3"');
  res.send(item.mp3);
});

// Twilio Voice webhook: starts recording + media stream
app.post("/voice", (req, res) => {
  if (!PUBLIC_BASE_URL) return res.status(500).send("Missing PUBLIC_BASE_URL");
  if (!RECORDING_WEBHOOK_SECRET) return res.status(500).send("Missing RECORDING_WEBHOOK_SECRET");

  const callbackUrl =
    `${PUBLIC_BASE_URL}/recording-status?secret=${encodeURIComponent(RECORDING_WEBHOOK_SECRET)}`;

  const twiml = `
<Response>
  <Start>
    <Recording
      channels="dual"
      recordingStatusCallback="${callbackUrl}"
      recordingStatusCallbackMethod="POST"
      recordingStatusCallbackEvent="completed"
    />
  </Start>
  <Connect>
    <Stream url="wss://${req.headers.host}/media"/>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// Twilio recording callback (fires after call ends and recording is ready)
app.post("/recording-status", async (req, res) => {
  // Always ACK quickly
  res.status(200).send("OK");

  try {
    const secret = req.query.secret;
    if (!RECORDING_WEBHOOK_SECRET || secret !== RECORDING_WEBHOOK_SECRET) {
      console.log("recording-status: forbidden (bad secret)");
      return;
    }

    // Log EVERYTHING so we can see if callback is firing
    console.log("recording-status payload:", JSON.stringify(req.body, null, 2));

    const {
      CallSid,
      RecordingSid,
      RecordingUrl,
      RecordingStatus,
      RecordingDuration,
    } = req.body;

    if (RecordingStatus !== "completed") {
      console.log("recording-status: not completed:", RecordingStatus);
      return;
    }
    if (!RecordingSid || !RecordingUrl) {
      console.log("recording-status: missing RecordingSid/RecordingUrl");
      return;
    }
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      console.log("recording-status: missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN");
      return;
    }
    if (!OPENAI_KEY) {
      console.log("recording-status: missing OPENAI_KEY");
      return;
    }

    // Twilio lets you fetch as mp3 by appending .mp3
    const mp3Url = `${RecordingUrl}.mp3`;
    const mp3 = await downloadWithTwilioAuth(mp3Url, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    const transcript = await transcribeMp3WithOpenAI(mp3);
    const summary = await summarizeTranscript(transcript);

    const token = crypto.randomBytes(24).toString("hex");
    recordingStore.set(token, {
      mp3,
      createdAt: Date.now(),
      meta: { CallSid, RecordingSid, RecordingDuration },
    });

    const listenLink = `${PUBLIC_BASE_URL}/listen/${token}`;

    await emailResults({
      subject: `Call: transcript + recording (${RecordingDuration || "?"}s)`,
      transcript,
      summary,
      listenLink,
      meta: { CallSid, RecordingSid, RecordingDuration },
    });

    console.log("recording-status: email sent for RecordingSid:", RecordingSid);
  } catch (err) {
    console.log("recording-status ERROR:", err?.stack || err?.message || err);
  }
});

async function downloadWithTwilioAuth(url, accountSid, authToken) {
  const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const resp = await fetch(url, { headers: { Authorization: `Basic ${basic}` } });
  if (!resp.ok) throw new Error(`Twilio download failed ${resp.status}: ${await resp.text()}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function transcribeMp3WithOpenAI(mp3Buffer) {
  const fd = new FormData();
  fd.append("file", new Blob([mp3Buffer], { type: "audio/mpeg" }), "call.mp3");
  fd.append("model", "gpt-4o-mini-transcribe");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: fd,
  });

  if (!resp.ok) throw new Error(`OpenAI transcribe failed ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return (data.text || "").trim();
}

async function summarizeTranscript(transcript) {
  const prompt = `Summarize this phone call transcript.
Return:
1) Summary (3-6 bullets)
2) Action items (bullets)
3) Key details (caller name/number if present, reason, requested follow-up)

Transcript:
${transcript}`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 600,
    }),
  });

  if (!resp.ok) throw new Error(`OpenAI summarize failed ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function emailResults({ subject, transcript, summary, listenLink, meta }) {
  const mailer = getMailer();
  if (!mailer) {
    console.log("Email not configured. Missing SMTP_* or EMAIL_* env vars.");
    return;
  }

  const body = `
${BUSINESS_NAME} — call processed

Listen:
${listenLink}

Meta:
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

// -------------------- Realtime Voice Bridge --------------------
const server = app.listen(PORT, () => console.log("Server running on port", PORT));
const wss = new WebSocket.Server({ server, path: "/media" });

function wsSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");

  let streamSid = null;

  // Track how much audio we’ve appended since last commit
  // Twilio Media Streams commonly sends 20ms frames; we’ll assume 20ms per media event.
  let bufferedMs = 0;

  // Prevent rapid repeat triggers
  let lastSpeechStoppedAt = 0;

  // Track whether OpenAI is currently speaking/responding
  let responseInProgress = false;

  // Queue audio output until streamSid exists
  const outQueue = [];
  const MAX_OUT_QUEUE = 300;

  function sendAudioToTwilio(base64Mulaw) {
    if (!base64Mulaw) return;

    if (!streamSid) {
      outQueue.push(base64Mulaw);
      if (outQueue.length > MAX_OUT_QUEUE) outQueue.shift();
      return;
    }

    wsSend(twilioWs, {
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

  openaiWs.on("open", () => {
    console.log("OpenAI realtime connected");

    wsSend(openaiWs, {
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "alloy",
        turn_detection: { type: "server_vad" },
        instructions: `
You are a friendly, professional phone answering assistant for ${OWNER_NAME}.
- Greet the caller and ask how you can help.
- Be concise.
- If asked to speak to ${OWNER_NAME}, say you’ll take a message and pass it along.
`,
      },
    });

    // Speak first (greeting)
    wsSend(openaiWs, {
      type: "response.create",
      response: { modalities: ["audio", "text"] },
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

    // Output audio
    const audioDelta =
      (msg.type === "response.audio.delta" && msg.delta) ||
      (msg.type === "response.output_audio.delta" && msg.delta);

    if (audioDelta) sendAudioToTwilio(audioDelta);

    if (msg.type === "response.created") responseInProgress = true;
    if (msg.type === "response.done") responseInProgress = false;

    // When caller stops talking, commit and ask for a response
    if (msg.type === "input_audio_buffer.speech_stopped") {
      const now = Date.now();

      // throttle repeated triggers
      if (now - lastSpeechStoppedAt < 400) return;
      lastSpeechStoppedAt = now;

      // Don't do anything while model is still responding
      if (responseInProgress) return;

      // Only commit if we have enough audio (>=100ms) to avoid commit_empty
      if (bufferedMs < 100) {
        // Not enough audio; just ignore this stop event.
        return;
      }

      // Commit and request response
      wsSend(openaiWs, { type: "input_audio_buffer.commit" });
      wsSend(openaiWs, { type: "response.create", response: { modalities: ["audio", "text"] } });
      responseInProgress = true;

      // Reset buffer counter after commit
      bufferedMs = 0;
    }
  });

  openaiWs.on("close", () => console.log("OpenAI WS closed"));
  openaiWs.on("error", (e) => console.log("OpenAI WS error:", e?.message || e));

  // Twilio -> OpenAI
  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      console.log("Stream started:", streamSid);

      while (outQueue.length) {
        const b64 = outQueue.shift();
        wsSend(twilioWs, { event: "media", streamSid, media: { payload: b64 } });
      }
      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload) return;

      // Append audio to OpenAI input buffer
      wsSend(openaiWs, { type: "input_audio_buffer.append", audio: payload });

      // Estimate buffered duration
      bufferedMs += 20; // typical Twilio Media Stream frame
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

// server.js
const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();

// Twilio callbacks are application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ====== Required env vars ======
// OPENAI_KEY
// PUBLIC_BASE_URL               (https://your-app.up.railway.app)
// RECORDING_WEBHOOK_SECRET      (random string)
// TWILIO_ACCOUNT_SID            (AC...)
// TWILIO_AUTH_TOKEN
// RESEND_API_KEY
// EMAIL_FROM                    (must be verified in Resend; use onboarding sender until verified)
// EMAIL_TO
//
// Option 2 routing (Twilio rings your landline first, then AI):
// LANDLINE_NUMBER               (e.g. +14045551234)
// LANDLINE_RING_SECONDS         (e.g. 15)
//
// Optional:
// OWNER_NAME
// BUSINESS_NAME
// VOICE_MODEL

const OPENAI_KEY = process.env.OPENAI_KEY;

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const RECORDING_WEBHOOK_SECRET = process.env.RECORDING_WEBHOOK_SECRET;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM;

const OWNER_NAME = process.env.OWNER_NAME || "Allen";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Gambrell Photography";

// Option 2 vars
const LANDLINE_NUMBER = process.env.LANDLINE_NUMBER || ""; // must be E.164, e.g. +1404...
const LANDLINE_RING_SECONDS = Number(process.env.LANDLINE_RING_SECONDS || "15");

// Use the model you confirmed is speaking
const VOICE_MODEL =
  process.env.VOICE_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// Fixed greeting you requested (must be consistent)
const FIXED_GREETING =
  "Thank you for calling Gambrell Photography, We are not able to come answer the phone at the moment.";

// In-memory storage for listen links (MP3 bytes)
const recordingStore = new Map(); // token -> { mp3: Buffer, createdAt, meta }
const RECORDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

setInterval(() => {
  const now = Date.now();
  for (const [token, item] of recordingStore.entries()) {
    if (now - item.createdAt > RECORDING_TTL_MS) recordingStore.delete(token);
  }
}, 60 * 60 * 1000).unref();

app.get("/", (req, res) => res.send("OK"));

// Private listen link
app.get("/listen/:token", (req, res) => {
  const item = recordingStore.get(req.params.token);
  if (!item) return res.status(404).send("Not found (expired or invalid).");
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Disposition", 'inline; filename="call.mp3"');
  res.send(item.mp3);
});

// Twilio Voice webhook: starts recording + rings landline first + AI fallback
app.post("/voice", (req, res) => {
  if (!PUBLIC_BASE_URL) return res.status(500).send("Missing PUBLIC_BASE_URL");
  if (!RECORDING_WEBHOOK_SECRET)
    return res.status(500).send("Missing RECORDING_WEBHOOK_SECRET");
  if (!LANDLINE_NUMBER)
    return res
      .status(500)
      .send("Missing LANDLINE_NUMBER (must be +1... E.164 format)");

  const callbackUrl = `${PUBLIC_BASE_URL}/recording-status?secret=${encodeURIComponent(
    RECORDING_WEBHOOK_SECRET
  )}`;

  // Validate timeout (Twilio expects integer seconds)
  const timeout = Number.isFinite(LANDLINE_RING_SECONDS) && LANDLINE_RING_SECONDS > 0
    ? Math.floor(LANDLINE_RING_SECONDS)
    : 15;

  // Option 2: Ring landline first. If not answered (or busy/failed), TwiML continues to AI stream.
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

  <Dial timeout="${timeout}">${LANDLINE_NUMBER}</Dial>

  <!-- If no answer, run the AI agent -->
  <Connect>
    <Stream url="wss://${req.headers.host}/media"/>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// Twilio recording callback (fires after call ends and recording is ready)
app.post("/recording-status", async (req, res) => {
  // ACK immediately
  res.status(200).send("OK");

  try {
    const secret = req.query.secret;
    if (!RECORDING_WEBHOOK_SECRET || secret !== RECORDING_WEBHOOK_SECRET) {
      console.log("recording-status: forbidden (bad secret)");
      return;
    }

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
      console.log(
        "recording-status: missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN"
      );
      return;
    }
    if (!OPENAI_KEY) {
      console.log("recording-status: missing OPENAI_KEY");
      return;
    }

    console.log(
      "recording-status: starting download/transcribe/summarize/email..."
    );

    // Twilio recording download: append .mp3
    const mp3Url = `${RecordingUrl}.mp3`;
    const mp3 = await downloadWithTwilioAuth(
      mp3Url,
      TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN
    );

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

    console.log(
      "recording-status: Resend email sent for RecordingSid:",
      RecordingSid
    );
  } catch (err) {
    console.log("recording-status ERROR:", err?.stack || err?.message || err);
  }
});

async function downloadWithTwilioAuth(url, accountSid, authToken) {
  const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const resp = await fetch(url, {
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!resp.ok)
    throw new Error(
      `Twilio download failed ${resp.status}: ${await resp.text()}`
    );
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

  if (!resp.ok)
    throw new Error(
      `OpenAI transcribe failed ${resp.status}: ${await resp.text()}`
    );
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
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 650,
    }),
  });

  if (!resp.ok)
    throw new Error(
      `OpenAI summarize failed ${resp.status}: ${await resp.text()}`
    );
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function emailResults({ subject, transcript, summary, listenLink, meta }) {
  if (!RESEND_API_KEY || !EMAIL_TO || !EMAIL_FROM) {
    console.log(
      "Email not configured. Missing RESEND_API_KEY / EMAIL_TO / EMAIL_FROM."
    );
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

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [EMAIL_TO],
      subject,
      text: body,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Resend email failed ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  console.log("Resend email sent:", data?.id || data);
}

// -------------------- Realtime Voice Bridge --------------------
const server = app.listen(PORT, () =>
  console.log("Server running on port", PORT)
);
const wss = new WebSocket.Server({ server, path: "/media" });

function wsSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");

  let streamSid = null;

  // Track appended audio since last commit
  let bufferedMs = 0;

  // Throttle repeated triggers
  let lastSpeechStoppedAt = 0;

  // Track whether OpenAI is responding (speaking)
  let responseInProgress = false;

  // Queue output audio until streamSid exists
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

  // Barge-in support: cancel assistant if caller starts talking
  function clearTwilioAudioQueue() {
    outQueue.length = 0;
  }

  function interruptAssistant(openaiWs) {
    clearTwilioAudioQueue();
    // Cancel current response so it stops generating audio
    wsSend(openaiWs, { type: "response.cancel" });
    responseInProgress = false;
  }

  if (!OPENAI_KEY) {
    console.log("Missing OPENAI_KEY; closing stream.");
    try {
      twilioWs.close();
    } catch {}
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
You are the phone answering assistant for Gambrell Photography.

Rules:
- After the fixed greeting, WAIT for the caller to speak.
- Never speak over the caller. If the caller starts speaking, stop immediately.
- Keep responses concise (1–2 sentences).
- Ask one question at a time if you need details.
- If asked to speak to ${OWNER_NAME}, say you can take a message and pass it along.
`,
      },
    });

    // Speak a FIXED greeting (exact wording) and then wait.
    wsSend(openaiWs, {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Say exactly: '${FIXED_GREETING}' Then stop and wait for the caller.`,
      },
    });

    responseInProgress = true;
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "error") {
      console.log("OpenAI ERROR:", JSON.stringify(msg, null, 2));
      return;
    }

    // If OpenAI detects the caller started speaking, barge-in cancel
    if (msg.type === "input_audio_buffer.speech_started") {
      if (responseInProgress) {
        console.log(
          "Barge-in: caller started speaking; cancelling assistant response"
        );
        interruptAssistant(openaiWs);
      }
    }

    // Output audio deltas (support both names)
    const audioDelta =
      (msg.type === "response.audio.delta" && msg.delta) ||
      (msg.type === "response.output_audio.delta" && msg.delta);

    if (audioDelta) sendAudioToTwilio(audioDelta);

    if (msg.type === "response.created") responseInProgress = true;
    if (msg.type === "response.done") responseInProgress = false;

    // When caller stops talking, commit and respond (if safe)
    if (msg.type === "input_audio_buffer.speech_stopped") {
      const now = Date.now();

      // Throttle repeated triggers
      if (now - lastSpeechStoppedAt < 400) return;
      lastSpeechStoppedAt = now;

      // Don't trigger if model is still responding
      if (responseInProgress) return;

      // Only commit if we buffered at least 100ms
      if (bufferedMs < 100) return;

      wsSend(openaiWs, { type: "input_audio_buffer.commit" });
      wsSend(openaiWs, {
        type: "response.create",
        response: { modalities: ["audio", "text"] },
      });
      responseInProgress = true;

      bufferedMs = 0;
    }
  });

  openaiWs.on("close", () => console.log("OpenAI WS closed"));
  openaiWs.on("error", (e) => console.log("OpenAI WS error:", e?.message || e));

  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

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

      // If caller audio arrives while assistant is talking, barge-in immediately
      if (responseInProgress) {
        console.log(
          "Barge-in: media received while assistant speaking; cancelling response"
        );
        interruptAssistant(openaiWs);
      }

      wsSend(openaiWs, { type: "input_audio_buffer.append", audio: payload });

      // Estimate buffered duration (Twilio typically sends ~20ms frames)
      bufferedMs += 20;
      return;
    }

    if (msg.event === "stop") {
      console.log("Twilio stream stop");
      try {
        openaiWs.close();
      } catch {}
      try {
        twilioWs.close();
      } catch {}
    }
  });

  const cleanup = () => {
    try {
      openaiWs.close();
    } catch {}
    try {
      twilioWs.close();
    } catch {}
  };

  twilioWs.on("close", cleanup);
  twilioWs.on("error", cleanup);
});

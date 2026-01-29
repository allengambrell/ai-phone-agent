// server.js
const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ====== Env Vars ======
const OPENAI_KEY = process.env.OPENAI_KEY;

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // https://...railway.app
const RECORDING_WEBHOOK_SECRET = process.env.RECORDING_WEBHOOK_SECRET;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID; // AC...
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM;

const OWNER_NAME = process.env.OWNER_NAME || "Allen";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Gambrell Photography";

// Option 2 vars
const LANDLINE_NUMBER = process.env.LANDLINE_NUMBER || ""; // +1...
const LANDLINE_RING_SECONDS = Number(process.env.LANDLINE_RING_SECONDS || "15");

// Realtime model
const VOICE_MODEL =
  process.env.VOICE_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// Fixed greeting
const FIXED_GREETING =
  "Thank you for calling Gambrell Photography, We are not able to come answer the phone at the moment.";

// ====== Recording storage for listen links (MP3 bytes) ======
const recordingStore = new Map(); // token -> { mp3: Buffer, createdAt, meta }
const RECORDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [token, item] of recordingStore.entries()) {
    if (now - item.createdAt > RECORDING_TTL_MS) recordingStore.delete(token);
  }
}, 60 * 60 * 1000).unref();

// ====== Routes ======

app.get("/", (req, res) => res.send("OK"));

app.get("/listen/:token", (req, res) => {
  const item = recordingStore.get(req.params.token);
  if (!item) return res.status(404).send("Not found (expired or invalid).");
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Disposition", 'inline; filename="call.mp3"');
  res.send(item.mp3);
});

/**
 * /voice: Twilio hits this on incoming call.
 * We start recording, ring your landline first, and POST dial outcome to /dial-result.
 */
app.post("/voice", (req, res) => {
  if (!PUBLIC_BASE_URL) return res.status(500).send("Missing PUBLIC_BASE_URL");
  if (!RECORDING_WEBHOOK_SECRET)
    return res.status(500).send("Missing RECORDING_WEBHOOK_SECRET");
  if (!LANDLINE_NUMBER)
    return res.status(500).send("Missing LANDLINE_NUMBER (+1... E.164)");

  const timeout =
    Number.isFinite(LANDLINE_RING_SECONDS) && LANDLINE_RING_SECONDS > 0
      ? Math.floor(LANDLINE_RING_SECONDS)
      : 15;

  const recordingCallbackUrl = `${PUBLIC_BASE_URL}/recording-status?secret=${encodeURIComponent(
    RECORDING_WEBHOOK_SECRET
  )}`;

  const dialAction = `${PUBLIC_BASE_URL}/dial-result`;

  const twiml = `
<Response>
  <Start>
    <Recording
      channels="dual"
      recordingStatusCallback="${recordingCallbackUrl}"
      recordingStatusCallbackMethod="POST"
      recordingStatusCallbackEvent="completed"
    />
  </Start>

  <Dial timeout="${timeout}" action="${dialAction}" method="POST">
    ${LANDLINE_NUMBER}
  </Dial>
</Response>`;

  res.type("text/xml").send(twiml);
});

/**
 * /dial-result: Twilio posts dial outcome.
 * If landline answered -> hang up TwiML (call already handled).
 * If not answered/busy/failed -> route to AI stream.
 */
app.post("/dial-result", (req, res) => {
  const callSid = req.body?.CallSid;
  const dialStatus = req.body?.DialCallStatus; // completed | no-answer | busy | failed | canceled
  console.log("Dial result:", { callSid, dialStatus });

  if (dialStatus === "completed") {
    return res.type("text/xml").send(`<Response><Hangup/></Response>`);
  }

  const twiml = `
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media"/>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

/**
 * /recording-status: Twilio posts when recording is ready.
 * We fetch caller number + landline-answered status from Twilio API (reliable),
 * then download recording, transcribe, summarize, email with subject format.
 */
app.post("/recording-status", async (req, res) => {
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
      RecordingStartTime,
    } = req.body;

    if (RecordingStatus !== "completed") return;
    if (!RecordingSid || !RecordingUrl || !CallSid) return;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      console.log("recording-status: missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN");
      return;
    }
    if (!OPENAI_KEY) {
      console.log("recording-status: missing OPENAI_KEY");
      return;
    }
    if (!PUBLIC_BASE_URL) {
      console.log("recording-status: missing PUBLIC_BASE_URL");
      return;
    }

    // --- Fetch call details from Twilio (this fixes blank phone number) ---
    const call = await twilioGetCall(CallSid);
    const phoneNumber = (call?.from || "").trim();
    const callerIdName = (call?.caller_name || "").trim(); // may be empty; depends on Twilio/CNAM

    // Use Twilio call start time when available, else recording start time
    const startUtc = call?.start_time
      ? new Date(call.start_time)
      : (RecordingStartTime ? new Date(RecordingStartTime) : new Date());
    const { date: easternDate, time: easternTime } = formatEasternFromUtcDate(startUtc);

    // --- Determine if landline answered (Answered) ---
    // If Twilio created an outbound child call to LANDLINE_NUMBER and it completed => Answered
    const landlineAnswered = await twilioDidLandlineAnswer(CallSid, LANDLINE_NUMBER);

    // Download recording
    const mp3Url = `${RecordingUrl}.mp3`;
    const mp3 = await downloadWithTwilioAuth(mp3Url, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    // Transcribe
    const transcript = await transcribeMp3WithOpenAI(mp3);

    // Summarize + classify outcome for AI calls
    const summaryObj = await summarizeAndClassifyTranscript(transcript);
    const summaryText = summaryObj.summary || "";
    const outcome = summaryObj.outcome || "AI"; // AI | Message

    // Extract name from transcript (if caller said it)
    const extractedName = await extractCallerNameFromTranscript(transcript);
    const extractedFullName = [extractedName.firstName, extractedName.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();

    // ANSWEREDTYPE
    const answeredType = landlineAnswered ? "Answered" : (outcome === "Message" ? "Message" : "AI");

    // NAME in subject: transcript name if present, else caller ID name if available, else "Unknown"
    const nameForSubject = extractedFullName || callerIdName || "Unknown";

    // Save listen link token
    const token = crypto.randomBytes(24).toString("hex");
    recordingStore.set(token, {
      mp3,
      createdAt: Date.now(),
      meta: { CallSid, RecordingSid, RecordingDuration },
    });
    const listenLink = `${PUBLIC_BASE_URL}/listen/${token}`;

    // Subject format requested
    const subject = `Call: ${phoneNumber || "Unknown"} - ${nameForSubject} - ${answeredType}`;

    await emailResults({
      subject,
      transcript,
      summary: summaryText,
      listenLink,
      meta: { CallSid, RecordingSid, RecordingDuration },
      callInfo: {
        easternDate,
        easternTime,
        phoneNumber,
        callerFullName: extractedFullName,
        callerIdInfo: callerIdName,
        answeredType,
      },
    });

    console.log("recording-status: email sent for RecordingSid:", RecordingSid);
  } catch (err) {
    console.log("recording-status ERROR:", err?.stack || err?.message || err);
  }
});

// ====== Twilio API Helpers (reliable caller + answered detection) ======

async function twilioFetchJson(pathWithQuery) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/${pathWithQuery}`;
  const basic = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const resp = await fetch(url, { headers: { Authorization: `Basic ${basic}` } });
  if (!resp.ok) throw new Error(`Twilio API ${resp.status}: ${await resp.text()}`);
  return await resp.json();
}

async function twilioGetCall(callSid) {
  // Returns call object with .from, .start_time, etc.
  return await twilioFetchJson(`Calls/${callSid}.json`);
}

function normalizePhone(p) {
  // Keep digits only; compare last 10 for US numbers
  const digits = String(p || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length > 10 ? digits.slice(-10) : digits; // last 10 digits
}

async function twilioDidLandlineAnswer(parentCallSid, landlineE164) {
  try {
    const qs = new URLSearchParams({
      ParentCallSid: parentCallSid,
      PageSize: "50",
    }).toString();

    const data = await twilioFetchJson(`Calls.json?${qs}`);
    const calls = Array.isArray(data?.calls) ? data.calls : [];

    const landlineNorm = normalizePhone(landlineE164);

    // DEBUG: log what Twilio is returning so we can confirm
    console.log(
      "Child calls for ParentCallSid:",
      parentCallSid,
      calls.map((c) => ({
        sid: c.sid,
        to: c.to,
        from: c.from,
        status: c.status,
        duration: c.duration,
        direction: c.direction,
      }))
    );

    // If ANY child call to your landline completed, treat as Answered.
    // (No duration requirement; short calls can show 0.)
    return calls.some((c) => {
      const toNorm = normalizePhone(c?.to);
      const status = String(c?.status || "").toLowerCase();
      return landlineNorm && toNorm === landlineNorm && status === "completed";
    });
  } catch (e) {
    console.log("Landline answer check failed:", e?.message || e);
    return false;
  }
}


// ====== OpenAI + Recording helpers ======

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

function formatEasternFromUtcDate(dateObj) {
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  const date = d.toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const time = d.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });
  return { date, time };
}

// Summarize + classify AI vs Message (only used for AI-routed calls)
async function summarizeAndClassifyTranscript(transcript) {
  if (!OPENAI_KEY || !transcript) return { summary: "", outcome: "AI" };

  const prompt = `
You are summarizing a business phone call for ${BUSINESS_NAME}.

Return ONLY JSON with this shape:
{
  "outcome": "AI" | "Message",
  "summary": "3-6 bullet points (as plain text, not an array)",
  "action_items": ["..."],
  "key_details": ["..."]
}

Outcome rules:
- "Message" if the caller is primarily leaving a message / requesting a callback.
- "AI" if the caller's questions were answered/handled without being mainly a message.

Transcript:
${transcript}
`.trim();

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 700,
    }),
  });

  if (!resp.ok) {
    console.log("Summarize/classify failed:", await resp.text());
    return { summary: "", outcome: "AI" };
  }

  const data = await resp.json();
  const text = (data.choices?.[0]?.message?.content || "").trim();

  try {
    const obj = JSON.parse(text);
    return {
      outcome: obj.outcome === "Message" ? "Message" : "AI",
      summary: (obj.summary || "").trim(),
      action_items: Array.isArray(obj.action_items) ? obj.action_items : [],
      key_details: Array.isArray(obj.key_details) ? obj.key_details : [],
    };
  } catch {
    // fallback: treat as AI
    return { summary: text, outcome: "AI" };
  }
}

async function extractCallerNameFromTranscript(transcript) {
  if (!OPENAI_KEY || !transcript) return { firstName: "", lastName: "" };

  const prompt = `
Extract the caller's first and last name from this phone call transcript.
If unknown, return empty strings.
Respond ONLY with JSON like:
{"firstName":"...","lastName":"..."}

Transcript:
${transcript}
`.trim();

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 60,
    }),
  });

  if (!resp.ok) return { firstName: "", lastName: "" };

  const data = await resp.json();
  const text = (data.choices?.[0]?.message?.content || "").trim();

  try {
    const obj = JSON.parse(text);
    return {
      firstName: (obj.firstName || "").trim(),
      lastName: (obj.lastName || "").trim(),
    };
  } catch {
    return { firstName: "", lastName: "" };
  }
}

// Email via Resend
async function emailResults({ subject, transcript, summary, listenLink, meta, callInfo }) {
  if (!RESEND_API_KEY || !EMAIL_TO || !EMAIL_FROM) {
    console.log("Email not configured. Missing RESEND_API_KEY / EMAIL_TO / EMAIL_FROM.");
    return;
  }

  const header = `
Phone Call
Date: ${callInfo?.easternDate || ""}
Time: ${callInfo?.easternTime || ""}
Phone Number: ${callInfo?.phoneNumber || ""}
Name: ${callInfo?.callerFullName || ""}
CallerID: ${callInfo?.callerIdInfo || ""}
AnsweredType: ${callInfo?.answeredType || ""}
`.trim();

  const body = `
${header}

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

  if (!resp.ok) throw new Error(`Resend email failed ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  console.log("Resend email sent:", data?.id || data);
}

// ==================== Realtime Voice Bridge (AI fallback) ====================
const server = app.listen(PORT, () => console.log("Server running on port", PORT));
const wss = new WebSocket.Server({ server, path: "/media" });

function wsSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected (AI stream)");

  let streamSid = null;
  let bufferedMs = 0;
  let lastSpeechStoppedAt = 0;
  let responseInProgress = false;

  const outQueue = [];
  const MAX_OUT_QUEUE = 300;

  function sendAudioToTwilio(base64Mulaw) {
    if (!base64Mulaw) return;
    if (!streamSid) {
      outQueue.push(base64Mulaw);
      if (outQueue.length > MAX_OUT_QUEUE) outQueue.shift();
      return;
    }
    wsSend(twilioWs, { event: "media", streamSid, media: { payload: base64Mulaw } });
  }

  function clearTwilioAudioQueue() {
    outQueue.length = 0;
  }

  function interruptAssistant(openaiWs) {
    clearTwilioAudioQueue();
    wsSend(openaiWs, { type: "response.cancel" });
    responseInProgress = false;
  }

  if (!OPENAI_KEY) {
    console.log("Missing OPENAI_KEY; closing stream.");
    try { twilioWs.close(); } catch {}
    return;
  }

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(VOICE_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_KEY}`, "OpenAI-Beta": "realtime=v1" } }
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
You are the phone answering assistant for ${BUSINESS_NAME}.

Rules:
- After the fixed greeting, WAIT for the caller to speak.
- Never speak over the caller. If the caller starts speaking, stop immediately.
- Keep responses concise (1–2 sentences).
- Ask one question at a time if you need details.
- If asked to speak to ${OWNER_NAME}, say you can take a message and pass it along.
`,
      },
    });

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
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "error") {
      console.log("OpenAI ERROR:", JSON.stringify(msg, null, 2));
      return;
    }

    if (msg.type === "input_audio_buffer.speech_started") {
      if (responseInProgress) {
        console.log("Barge-in: caller started speaking; cancelling assistant response");
        interruptAssistant(openaiWs);
      }
    }

    const audioDelta =
      (msg.type === "response.audio.delta" && msg.delta) ||
      (msg.type === "response.output_audio.delta" && msg.delta);

    if (audioDelta) sendAudioToTwilio(audioDelta);

    if (msg.type === "response.created") responseInProgress = true;
    if (msg.type === "response.done") responseInProgress = false;

    if (msg.type === "input_audio_buffer.speech_stopped") {
      const now = Date.now();
      if (now - lastSpeechStoppedAt < 400) return;
      lastSpeechStoppedAt = now;

      if (responseInProgress) return;
      if (bufferedMs < 100) return;

      wsSend(openaiWs, { type: "input_audio_buffer.commit" });
      wsSend(openaiWs, { type: "response.create", response: { modalities: ["audio", "text"] } });
      responseInProgress = true;
      bufferedMs = 0;
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
      while (outQueue.length) {
        const b64 = outQueue.shift();
        wsSend(twilioWs, { event: "media", streamSid, media: { payload: b64 } });
      }
      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload) return;

      if (responseInProgress) {
        console.log("Barge-in: media received while assistant speaking; cancelling response");
        interruptAssistant(openaiWs);
      }

      wsSend(openaiWs, { type: "input_audio_buffer.append", audio: payload });
      bufferedMs += 20;
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

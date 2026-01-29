const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

const OPENAI_KEY = process.env.OPENAI_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // e.g. https://ai-phone-agent-production-b8a9.up.railway.app
const VOICE_NAME = process.env.VOICE_NAME || "alloy";

const OWNER_NAME = process.env.OWNER_NAME || "Allen";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "our office";
const FORWARD_TO = process.env.FORWARD_TO || "";

// In-memory storage for generated audio (mp3 bytes)
const audioStore = new Map(); // id -> { buf, contentType, createdAt }
const AUDIO_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cleanupAudioStore() {
  const now = Date.now();
  for (const [id, item] of audioStore.entries()) {
    if (now - item.createdAt > AUDIO_TTL_MS) audioStore.delete(id);
  }
}
setInterval(cleanupAudioStore, 60 * 1000).unref();

const callState = new Map(); // CallSid -> { history: [{role, content}] }

app.get("/", (req, res) => res.send("OK"));

// Serve generated audio to Twilio <Play>
app.get("/audio/:id", (req, res) => {
  const item = audioStore.get(req.params.id);
  if (!item) return res.status(404).send("Not found");
  res.setHeader("Content-Type", item.contentType);
  res.send(item.buf);
});

// Twilio entry
app.post("/voice", async (req, res) => {
  const callSid = req.body.CallSid;
  if (callSid && !callState.has(callSid)) callState.set(callSid, { history: [] });

  const greetingText = `Thanks for calling ${BUSINESS_NAME}. How can I help you today?`;

  const greetingUrl = await ttsToUrl(greetingText);

  const twiml = `
<Response>
  <Play>${greetingUrl}</Play>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto">
    <Say>Please tell me how I can help.</Say>
  </Gather>
  <Say>Sorry, I didn't catch that.</Say>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
  res.type("text/xml").send(twiml);
});

app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();

  const state = callState.get(callSid) || { history: [] };
  callState.set(callSid, state);

  if (!speech) {
    return res.type("text/xml").send(`
<Response>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto">
    <Say>Please tell me how I can help.</Say>
  </Gather>
  <Redirect method="POST">/voice</Redirect>
</Response>`);
  }

  // Transfer intent (optional)
  const wantsTransfer =
    new RegExp(`\\b(${OWNER_NAME}|owner|transfer|forward|speak to|talk to)\\b`, "i").test(speech);

  if (wantsTransfer && FORWARD_TO) {
    const twiml = `
<Response>
  <Say>One moment please. I'll connect you.</Say>
  <Dial>${FORWARD_TO}</Dial>
  <Say>I couldn't connect you. I can take a message.</Say>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto"/>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  state.history.push({ role: "user", content: speech });

  let reply = "";
  try {
    reply = await chatReply(state.history);
  } catch (e) {
    reply = "I'm having trouble right now. Please leave your name, number, and reason for calling.";
  }

  state.history.push({ role: "assistant", content: reply });

  const replyUrl = await ttsToUrl(reply);

  const twiml = `
<Response>
  <Play>${replyUrl}</Play>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto">
    <Say>Anything else?</Say>
  </Gather>
  <Say>Okay. Goodbye.</Say>
  <Hangup/>
</Response>`;
  res.type("text/xml").send(twiml);
});

async function chatReply(history) {
  if (!OPENAI_KEY) throw new Error("Missing OPENAI_KEY");

  const system = {
    role: "system",
    content: `You are a professional phone answering assistant for ${OWNER_NAME} at ${BUSINESS_NAME}.
Be friendly and concise (1–3 sentences). If unsure, take a message.
Always try to collect caller name, callback number, and reason for calling.
Never invent prices or policies.`,
  };

  const messages = [system, ...history.slice(-12)];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.4,
      max_tokens: 180,
    }),
  });

  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || "").trim() || "How can I help?";
}

async function ttsToUrl(text) {
  if (!OPENAI_KEY) throw new Error("Missing OPENAI_KEY");
  if (!PUBLIC_BASE_URL) throw new Error("Missing PUBLIC_BASE_URL");

  const id = crypto.randomBytes(16).toString("hex");

  // OpenAI TTS: returns audio bytes (mp3)
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: VOICE_NAME,
      format: "mp3",
      input: text,
    }),
  });

  if (!resp.ok) throw new Error(await resp.text());

  const buf = Buffer.from(await resp.arrayBuffer());
  audioStore.set(id, { buf, contentType: "audio/mpeg", createdAt: Date.now() });

  return `${PUBLIC_BASE_URL}/audio/${id}`;
}

app.listen(PORT, () => console.log("Server running on port", PORT));

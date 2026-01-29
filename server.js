// server.js
const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ====== CONFIG YOU SET IN RAILWAY VARIABLES ======
// OPENAI_KEY      = sk-...
// FORWARD_TO      = +1YourCellNumber (optional; for call transfer)
// BUSINESS_NAME   = Allen's Office   (optional)
// OWNER_NAME      = Allen           (optional)

const BUSINESS_NAME = process.env.BUSINESS_NAME || "our office";
const OWNER_NAME = process.env.OWNER_NAME || "Allen";
const FORWARD_TO = process.env.FORWARD_TO || ""; // e.g. +15551234567

// In-memory call context (good enough to start; later we can persist)
const callState = new Map(); // CallSid -> { history: [{role,content}], startedAt }

app.get("/", (req, res) => res.send("OK"));

// ---------- Twilio entrypoint ----------
app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid;

  if (callSid && !callState.has(callSid)) {
    callState.set(callSid, { history: [], startedAt: Date.now() });
  }

  const twiml = `
<Response>
  <Say>Thanks for calling ${BUSINESS_NAME}. This call may be recorded.</Say>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto">
    <Say>How can I help you today?</Say>
  </Gather>
  <Say>Sorry, I didn't catch that.</Say>
  <Redirect method="POST">/voice</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- Handle speech input ----------
app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();

  const state = callState.get(callSid) || { history: [], startedAt: Date.now() };
  callState.set(callSid, state);

  // If Twilio didn't capture speech, reprompt
  if (!speech) {
    const twiml = `
<Response>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto">
    <Say>I didn’t hear anything. Please tell me how I can help.</Say>
  </Gather>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
    res.type("text/xml").send(twiml);
    return;
  }

  // Simple “transfer” intent (we can refine later)
  const wantsOwner =
    /\b(owner|${OWNER_NAME.toLowerCase()}|talk to|speak to|transfer|forward)\b/i.test(speech);

  if (wantsOwner && FORWARD_TO) {
    const twiml = `
<Response>
  <Say>One moment please. I’ll connect you.</Say>
  <Dial callerId="${req.body.To || ""}">${FORWARD_TO}</Dial>
  <Say>Sorry, I couldn’t connect you. I can take a message.</Say>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto">
    <Say>Please leave your name, number, and reason for calling.</Say>
  </Gather>
</Response>`;
    res.type("text/xml").send(twiml);
    return;
  }

  // Add caller message to state
  state.history.push({ role: "user", content: speech });

  // Ask OpenAI for the next reply
  let replyText = "";
  try {
    replyText = await callOpenAI(state.history);
  } catch (e) {
    replyText = "Sorry — I’m having trouble right now. Please leave your name, number, and a short message.";
  }

  // Add assistant reply to state
  state.history.push({ role: "assistant", content: replyText });

  // Respond to caller + continue the conversation loop
  const twiml = `
<Response>
  <Say>${escapeXmlForTwiml(replyText)}</Say>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto">
    <Say>Anything else I can help with?</Say>
  </Gather>
  <Say>Okay. Goodbye.</Say>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- OpenAI call (text) ----------
async function callOpenAI(history) {
  const OPENAI_KEY = process.env.OPENAI_KEY;
  if (!OPENAI_KEY) throw new Error("Missing OPENAI_KEY");

  // Build a compact prompt: system + recent history
  const system = {
    role: "system",
    content:
      `You are a professional phone answering assistant for ${OWNER_NAME} at ${BUSINESS_NAME}.
Rules:
- Be concise and friendly (1–3 short sentences).
- If you don’t know, say you will take a message.
- Always try to collect: caller name, callback number, and reason for calling.
- If asked to speak to ${OWNER_NAME}, say you'll connect them if possible; otherwise offer to take a message.
- Do NOT invent business policies or prices.`,
  };

  const messages = [system, ...history.slice(-12)];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.4,
      max_tokens: 160,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || "").trim() || "How can I help?";
}

function escapeXmlForTwiml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

app.listen(PORT, () => console.log("Server running on port", PORT));

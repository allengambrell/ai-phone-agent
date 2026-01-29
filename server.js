// server.js
const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ==============================
// Railway Environment Variables
// ==============================
// OPENAI_KEY   = sk-xxxxxxxxxxxxxxxx
// OWNER_NAME  = Allen
// BUSINESS_NAME = Allen's Office
// FORWARD_TO  = +15551234567   (optional)

const OWNER_NAME = process.env.OWNER_NAME || "Allen";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "our office";
const FORWARD_TO = process.env.FORWARD_TO || "";

// Simple in-memory conversation memory per call
const callState = new Map();

// ------------------------------
app.get("/", (req, res) => res.send("OK"));
// ------------------------------


// ============
// ENTRY POINT
// ============
app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid;

  if (!callState.has(callSid)) {
    callState.set(callSid, { history: [] });
  }

  const twiml = `
<Response>
  <Say voice="alice">
    Thank you for calling ${BUSINESS_NAME}. How can I help you today?
  </Say>

  <Gather input="speech"
          action="/gather"
          method="POST"
          speechTimeout="auto">

    <Say voice="alice">Please tell me how I can help.</Say>
  </Gather>

  <Say voice="alice">Sorry, I didn't catch that.</Say>
  <Redirect>/voice</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});


// =====================
// HANDLE SPEECH RESULT
// =====================
app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();

  const state = callState.get(callSid) || { history: [] };
  callState.set(callSid, state);

  if (!speech) {
    return reprompt(res);
  }

  // Detect transfer request
  const wantsTransfer =
    new RegExp(`\\b(${OWNER_NAME}|owner|transfer|forward|speak to|talk to)\\b`, "i")
      .test(speech);

  if (wantsTransfer && FORWARD_TO) {
    const twiml = `
<Response>
  <Say voice="alice">One moment please. I'll connect you.</Say>
  <Dial>${FORWARD_TO}</Dial>

  <Say voice="alice">
    I couldn't connect you. Please leave your name, number, and reason for calling.
  </Say>

  <Gather input="speech"
          action="/gather"
          method="POST"
          speechTimeout="auto"/>
</Response>`;

    return res.type("text/xml").send(twiml);
  }

  state.history.push({ role: "user", content: speech });

  let reply;
  try {
    reply = await askOpenAI(state.history);
  } catch {
    reply = "I'm having trouble right now. Please leave your name, number, and reason for calling.";
  }

  state.history.push({ role: "assistant", content: reply });

  const twiml = `
<Response>
  <Say voice="alice">${escapeXml(reply)}</Say>

  <Gather input="speech"
          action="/gather"
          method="POST"
          speechTimeout="auto">

    <Say voice="alice">Anything else I can help with?</Say>
  </Gather>

  <Say voice="alice">Okay. Goodbye.</Say>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});


// =================
// OPENAI TEXT CALL
// =================
async function askOpenAI(history) {
  const systemPrompt = {
    role: "system",
    content: `
You are a professional phone answering assistant for ${OWNER_NAME}.

Rules:
- Be friendly and concise (1–3 sentences).
- If unsure, take a message.
- Always try to collect:
  caller name,
  callback number,
  reason for calling.
- Never invent prices or policies.
`
  };

  const messages = [systemPrompt, ...history.slice(-12)];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.4,
      max_tokens: 160,
    }),
  });

  if (!response.ok) {
    throw new Error("OpenAI API error");
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}


// =================
function reprompt(res) {
  const twiml = `
<Response>
  <Gather input="speech"
          action="/gather"
          method="POST"
          speechTimeout="auto">
    <Say voice="alice">Please tell me how I can help.</Say>
  </Gather>
  <Redirect>/voice</Redirect>
</Response>`;
  res.type("text/xml").send(twiml);
}


// ===============
// XML ESCAPING
// ===============
function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}


// ============
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

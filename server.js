const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("OK"));

app.post("/voice", (req, res) => {
  const twiml = `
<Response>
  <Say>This call may be recorded.</Say>
  <Connect>
    <Stream url="wss://${req.headers.host}/media"/>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

const server = app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

const wss = new WebSocket.Server({ server, path: "/media" });

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
}

wss.on("connection", (twilioWs) => {
  console.log("Twilio WS connected");

  let streamSid = null;
  let openaiReady = false;
  const pending = [];
  const MAX_PENDING = 200;

  const openaiWs = new WebSocket(
    // Realtime conversations guide recommends gpt-realtime for speech-to-speech
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("OpenAI WS open");
    openaiReady = true;

    // IMPORTANT: Updated session.update shape (audio.format is an object)
    safeSend(openaiWs, {
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime",
        output_modalities: ["audio"],
        instructions: `
You are a professional phone answering assistant for Allen.

- Greet the caller and ask how you can help.
- Answer questions if you know; otherwise take a message.
- Always capture: caller name, callback number, reason for calling.
- If asked to speak to Allen, say: "One moment please—I'll take a message and pass it along."
Be concise and friendly.
`,
        audio: {
          input: {
            // Twilio Media Streams audio is G.711 u-law (PCMU) at 8kHz
            format: { type: "audio/pcmu", rate: 8000 },
            turn_detection: { type: "semantic_vad" }
          },
          output: {
            // Send PCMU back so Twilio can play it
            format: { type: "audio/pcmu" },
            voice: "marin"
          }
        }
      },
    });

    // Flush any buffered audio frames
    while (pending.length) safeSend(openaiWs, pending.shift());

    // Ask the model to speak first (greeting)
    safeSend(openaiWs, {
      type: "response.create",
      response: { modalities: ["audio"] }
    });
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Log key events so Railway logs show what’s happening
    if (msg.type && (msg.type.includes("error") || msg.type.includes("session") || msg.type.includes("response"))) {
      if (msg.type === "response.output_audio.delta") {
        // don’t spam logs for every chunk
      } else {
        console.log("OpenAI event:", msg.type);
        if (msg.error) console.log("OpenAI error detail:", msg.error);
      }
    }

    // IMPORTANT: current docs say output audio bytes come via response.output_audio.delta
    if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
      safeSend(twilioWs, {
        event: "media",
        streamSid,
        media: { payload: msg.delta },
      });
    }
  });

  openaiWs.on("close", () => console.log("OpenAI WS closed"));
  openaiWs.on("error", (e) => console.log("OpenAI WS error:", e?.message || e));

  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      console.log("Twilio stream start:", streamSid);
      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload) return;

      const evt = { type: "input_aud
::contentReference[oaicite:2]{index=2}

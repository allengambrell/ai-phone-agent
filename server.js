const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("OK"));

// Twilio Voice webhook -> starts Media Stream
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
  let streamSid = null;
  let openaiReady = false;

  const pending = [];
  const MAX_PENDING = 200;

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    openaiReady = true;

    safeSend(openaiWs, {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "alloy",
        turn_detection: { type: "server_vad" },
        instructions: `
You are a professional phone answering assistant for Allen.

Goals:
- Greet the caller and ask how you can help.
- Answer questions if you know; otherwise take a message.
- Always capture: caller name, callback number, reason for calling.
- If asked to speak to Allen, say: "One moment please—I'll take a message and pass it along."

Be concise and friendly.
`,
      },
    });

    while (pending.length) safeSend(openaiWs, pending.shift());

    // Make the assistant greet first
    safeSend(openaiWs, { type: "response.create" });
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "response.audio.delta" && msg.delta && streamSid) {
      safeSend(twilioWs, {
        event: "media",
        streamSid,
        media: { payload: msg.delta },
      });
    }
  });

  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload) return;

      const evt = { type: "input_audio_buffer.append", audio: payload };

      if (!openaiReady) {
        pending.push(evt);
        if (pending.length > MAX_PENDING) pending.shift();
      } else {
        safeSend(openaiWs, evt);
      }
      return;
    }

    if (msg.event === "stop") {
      try { openaiWs.close(); } catch {}
      try { twilioWs.close(); } catch {}
    }
  });

  const cleanup = () => {
    try { openaiWs.close(); } catch {}
    try { twilioWs.close(); } catch {}
  };
  twilioWs.on("close", cleanup);
  openaiWs.on("close", cleanup);
  twilioWs.on("error", cleanup);
  openaiWs.on("error", cleanup);
});

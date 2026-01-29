// server.js
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
  let gotAnyAudioDelta = false;

  const pending = [];
  const MAX_PENDING = 200;

  const openaiWs = new WebSocket(
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

    // Keep session.update minimal for compatibility
    safeSend(openaiWs, {
      type: "session.update",
      session: {
        instructions: `
You are a professional phone answering assistant for Allen.

- Greet the caller and ask how you can help.
- Answer questions if you know; otherwise take a message.
- Always capture: caller name, callback number, reason for calling.
- If asked to speak to Allen, say: "One moment please—I'll take a message and pass it along."
Be concise and friendly.
`,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
      },
    });

    while (pending.length) safeSend(openaiWs, pending.shift());

    // FIX: your account expects response.modalities (not response.output_modalities)
    // And it must be ["audio","text"] (audio-only is rejected).
    safeSend(openaiWs, {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
      },
    });
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "error") {
      console.log("OpenAI ERROR FULL:", JSON.stringify(msg, null, 2));
      return;
    }

    if (
      msg.type &&
      msg.type !== "response.output_audio.delta" &&
      msg.type !== "response.audio.delta" &&
      msg.type !== "response.output_text.delta"
    ) {
      if (msg.type.includes("session") || msg.type.includes("response")) {
        console.log("OpenAI event:", msg.type);
      }
    }

    // Handle either event name
    const audioDelta =
      (msg.type === "response.output_audio.delta" && msg.delta) ||
      (msg.type === "response.audio.delta" && msg.delta);

    if (audioDelta && streamSid) {
      gotAnyAudioDelta = true;
      safeSend(twilioWs, {
        event: "media",
        streamSid,
        media: { payload: audioDelta },
      });
    }

    if (msg.type === "response.done") {
      console.log("OpenAI response.done. gotAnyAudioDelta =", gotAnyAudioDelta);
    }

    if (msg.type === "response.output_text.delta" && msg.delta) {
      console.log("OpenAI text delta:", msg.delta);
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

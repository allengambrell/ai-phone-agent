// server.js
const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// Must be set in Railway Variables
// OPENAI_KEY = sk-...
const OPENAI_KEY = process.env.OPENAI_KEY;

app.get("/", (req, res) => res.send("OK"));

// Twilio Voice webhook: start Media Stream
app.post("/voice", (req, res) => {
  const twiml = `
<Response>
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
  console.log("Twilio connected");

  let streamSid = null;

  // Queue OpenAI audio until streamSid is known
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
    console.log("Missing OPENAI_KEY. Closing call.");
    try { twilioWs.close(); } catch {}
    return;
  }

  // Realtime voice model (this is the one we want to test again now that billing is fixed)
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("OpenAI realtime connected");

    // Configure session for Twilio PSTN audio (G.711 u-law)
    safeSend(openaiWs, {
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "alloy",
        turn_detection: { type: "server_vad" },
        instructions: `
You are a friendly, professional phone answering assistant for Allen.
- Greet the caller and ask how you can help.
- Be concise.
- If asked to speak to Allen, say you’ll take a message and pass it along.
`,
      },
    });

    // Force assistant to speak first (greeting)
    safeSend(openaiWs, {
      type: "response.create",
      response: {
        // Some accounts require both
        modalities: ["audio", "text"],
        instructions: "Start with a warm greeting and ask how you can help.",
      },
    });
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

    // Log important lifecycle events (avoid spamming deltas)
    if (
      msg.type &&
      ![
        "response.audio.delta",
        "response.output_audio.delta",
        "response.audio",
        "response.output_audio",
        "response.output_text.delta",
        "response.output_audio_transcript.delta",
      ].includes(msg.type)
    ) {
      if (msg.type.includes("session") || msg.type.includes("response")) {
        console.log("OpenAI event:", msg.type);
      }
    }

    // Support multiple possible audio event names
    let audioDelta = null;

    if (msg.type === "response.audio.delta" && msg.delta) audioDelta = msg.delta;
    if (msg.type === "response.output_audio.delta" && msg.delta) audioDelta = msg.delta;

    // Some variants may send a whole chunk as "audio"
    if (msg.type === "response.audio" && msg.audio) audioDelta = msg.audio;
    if (msg.type === "response.output_audio" && msg.audio) audioDelta = msg.audio;

    if (audioDelta) {
      sendAudioToTwilio(audioDelta);
    }

    if (msg.type === "response.done") {
      console.log("OpenAI response.done");
    }
  });

  openaiWs.on("close", () => console.log("OpenAI WS closed"));
  openaiWs.on("error", (e) => console.log("OpenAI WS error:", e?.message || e));

  // From Twilio -> OpenAI
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

      // Flush any queued audio
      while (audioQueue.length) {
        const b64 = audioQueue.shift();
        safeSend(twilioWs, {
          event: "media",
          streamSid,
          media: { payload: b64 },
        });
      }
      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload) return;

      // Send caller audio into OpenAI input buffer
      safeSend(openaiWs, {
        type: "input_audio_buffer.append",
        audio: payload,
      });
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

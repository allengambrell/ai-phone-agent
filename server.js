// server.js
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

  // Buffer OpenAI audio until we have streamSid
  const twilioOutbox = [];
  const MAX_TWILIO_OUTBOX = 200;

  function sendToTwilioMedia(base64Mulaw) {
    if (!base64Mulaw) return;
    if (!streamSid) {
      twilioOutbox.push(base64Mulaw);
      if (twilioOutbox.length > MAX_TWILIO_OUTBOX) twilioOutbox.shift();
      return;
    }
    safeSend(twilioWs, {
      event: "media",
      streamSid,
      media: { payload: base64Mulaw },
    });
  }

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("OpenAI realtime connected");

    // Keep session.update minimal + correct for Twilio PSTN audio (mulaw/8k)
    safeSend(openaiWs, {
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "alloy",
        instructions:
          "You are a friendly phone answering assistant for Allen. Speak clearly and be brief.",
      },
    });

    // Force a greeting. Some realtime variants won’t speak unless instructions are on response.create.
    safeSend(openaiWs, {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions:
          "Start the call with a friendly greeting and ask how you can help.",
      },
    });
  });

  openaiWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.log("OpenAI non-JSON message");
      return;
    }

    // Log errors fully (this is critical)
    if (msg.type === "error") {
      console.log("OpenAI ERROR:", JSON.stringify(msg, null, 2));
      return;
    }

    // Helpful: log important lifecycle events
    if (
      msg.type &&
      ![
        "response.audio.delta",
        "response.output_audio.delta",
        "response.audio",
        "response.output_audio",
        "response.output_text.delta",
      ].includes(msg.type)
    ) {
      if (msg.type.includes("session") || msg.type.includes("response")) {
        console.log("OpenAI event:", msg.type);
      }
    }

    // Different accounts/models emit different event names for audio deltas.
    // Support multiple possibilities.
    let audioDelta = null;

    if (msg.type === "response.audio.delta" && msg.delta) audioDelta = msg.delta;
    if (msg.type === "response.output_audio.delta" && msg.delta) audioDelta = msg.delta;
    if (msg.type === "response.audio" && msg.audio) audioDelta = msg.audio;
    if (msg.type === "response.output_audio" && msg.audio) audioDelta = msg.audio;

    if (audioDelta) {
      sendToTwilioMedia(audioDelta);
    }

    // If OpenAI finishes but never sent audio, we’ll know.
    if (msg.type === "response.done") {
      console.log("OpenAI response.done");
    }
  });

  openaiWs.on("close", () => console.log("OpenAI WS closed"));
  openaiWs.on("error", (e) => console.log("OpenAI WS error:", e?.message || e));

  // From Twilio -> to OpenAI
  twilioWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      console.log("Stream started:", streamSid);

      // Flush any buffered OpenAI audio that arrived before streamSid
      while (twilioOutbox.length) {
        const b64 = twilioOutbox.shift();
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

  twilioWs.on("close", () => {
    try { openaiWs.close(); } catch {}
  });
  twilioWs.on("error", () => {
    try { openaiWs.close(); } catch {}
  });
});

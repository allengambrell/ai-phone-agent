// server.js
const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// --------------------
// Twilio Voice Webhook
// --------------------
app.post("/voice", (req, res) => {
  const twiml = `
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media"/>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

app.get("/", (req, res) => res.send("OK"));

const server = app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

// --------------------
// WebSocket Server
// --------------------
const wss = new WebSocket.Server({ server, path: "/media" });

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");

  let streamSid = null;

  // IMPORTANT MODEL CHANGE
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // ---------- OpenAI Connected ----------
  openaiWs.on("open", () => {
    console.log("OpenAI realtime connected");

    send(openaiWs, {
      type: "session.update",
      session: {
        instructions:
          "You are a friendly phone answering assistant for Allen. Greet the caller and ask how you can help.",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "alloy"
      }
    });

    // Make it speak first
    send(openaiWs, {
      type: "response.create",
      response: {
        modalities: ["audio","text"]
      }
    });
  });

  // ---------- From OpenAI ----------
  openaiWs.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.type === "response.audio.delta") {
      send(twilioWs, {
        event: "media",
        streamSid,
        media: { payload: msg.delta }
      });
    }

    if (msg.type === "error") {
      console.log("OpenAI error:", msg);
    }
  });

  // ---------- From Twilio ----------
  twilioWs.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("Stream started:", streamSid);
    }

    if (msg.event === "media") {
      send(openaiWs, {
        type: "input_audio_buffer.append",
        audio: msg.media.payload
      });
    }
  });

  twilioWs.on("close", () => {
    try { openaiWs.close(); } catch {}
  });
});

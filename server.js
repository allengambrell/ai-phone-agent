// server.js
const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_KEY;

app.get("/", (req, res) => res.send("OK"));

// Twilio Voice webhook -> Media Stream to /media
app.post("/voice", (req, res) => {
  const twiml = `
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media"/>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

const server = app.listen(PORT, () => console.log("Server running on port", PORT));
const wss = new WebSocket.Server({ server, path: "/media" });

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
}

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");

  let streamSid = null;

  // Queue audio until we know streamSid
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
    console.log("Missing OPENAI_KEY; closing stream.");
    try { twilioWs.close(); } catch {}
    return;
  }

  // Use the same model you have working now. If you changed it, swap it here.
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let receivedAnyAudio = false;
  let responseInProgress = false;

  openaiWs.on("open", () => {
    console.log("OpenAI realtime connected");

    // Session config for Twilio (G.711 u-law)
    safeSend(openaiWs, {
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "alloy",
        // Let OpenAI detect caller turns
        turn_detection: { type: "server_vad" },
        instructions: `
You are a friendly, professional phone answering assistant for Allen.

Rules:
- Start by greeting and asking how you can help.
- Be concise.
- Ask for caller name, callback number, and reason if needed.
- If asked to speak to Allen, say you'll take a message and pass it along.
`,
      },
    });

    // Assistant greets first
    safeSend(openaiWs, {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: "Greet the caller warmly and ask how you can help.",
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

    // Audio delta events (support both names)
    const audioDelta =
      (msg.type === "response.audio.delta" && msg.delta) ||
      (msg.type === "response.output_audio.delta" && msg.delta);

    if (audioDelta) {
      receivedAnyAudio = true;
      sendAudioToTwilio(audioDelta);
    }

    if (msg.type === "response.created") responseInProgress = true;

    if (msg.type === "response.done") {
      console.log("OpenAI response.done; audio=", receivedAnyAudio);
      responseInProgress = false;
      receivedAnyAudio = false;
    }

    // When server_vad detects end of user speech, OpenAI may emit these events.
    // If your account emits them, we can auto-trigger response. If not, we still work.
    if (msg.type === "input_audio_buffer.speech_stopped") {
      // Commit what user said and ask for a reply (only if not already replying)
      if (!responseInProgress) {
        safeSend(openaiWs, { type: "input_audio_buffer.commit" });
        safeSend(openaiWs, {
          type: "response.create",
          response: { modalities: ["audio", "text"] },
        });
        responseInProgress = true;
      }
    }
  });

  openaiWs.on("close", () => console.log("OpenAI WS closed"));
  openaiWs.on("error", (e) => console.log("OpenAI WS error:", e?.message || e));

  // Twilio -> OpenAI
  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      console.log("Stream started:", streamSid);

      // Flush queued audio
      while (audioQueue.length) {
        const b64 = audioQueue.shift();
        safeSend(twilioWs, { event: "media", streamSid, media: { payload: b64 } });
      }
      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload) return;

      safeSend(openaiWs, { type: "input_audio_buffer.append", audio: payload });
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

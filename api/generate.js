import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const IMAGE_MODEL_ID =
  "prunaai/flux.1-dev:b0306d92aa025bb747dc74162f3c27d6ed83798e08e5f8977adf3d859d0536a3";
const VIDEO_MODEL_ID = "wan-video/wan-2.2-i2v-fast";

const WEBHOOK_URL = process.env.VERCEL_URL 
  ? `https://${process.env.VERCEL_URL}/api/generate`
  : process.env.WEBHOOK_URL;

const ALLOWED_IMAGE_KEYS = new Set([
  "seed",
  "prompt",
  "guidance",
  "image_size",
  "speed_mode",
  "aspect_ratio",
  "output_format",
  "output_quality",
  "num_inference_steps",
]);

const ALLOWED_VIDEO_KEYS = new Set([
  "seed",
  "prompt",
  "image",
  "go_fast",
  "num_frames",
  "resolution",
  "sample_shift",
  "frames_per_second",
  "disable_safety_checker",
  "lora_scale_transformer",
  "lora_scale_transformer_2",
  "lora_weights_transformer",
  "lora_weights_transformer_2",
]);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body || {};

    if (body.status && body.output && body.input) {
      return await handleWebhook(req, res);
    }

    const { type = "image", prompt, image, userId, characterId, input: clientInput } = body;

    if (type === "video") {
      return await handleVideoGeneration(req, res, {
        prompt,
        image,
        userId,
        characterId,
        clientInput,
      });
    } else {
      return await handleImageGeneration(req, res, {
        prompt,
        userId,
        characterId,
        clientInput,
      });
    }
  } catch (err) {
    console.error("[/generate] error:", err);
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
}

async function handleImageGeneration(req, res, { prompt, userId, characterId, clientInput }) {
  if (!prompt || !userId || !characterId) {
    return res.status(400).json({ error: "prompt, userId, characterId required" });
  }

  const sanitized = {};
  if (clientInput && typeof clientInput === "object") {
    for (const [k, v] of Object.entries(clientInput)) {
      if (ALLOWED_IMAGE_KEYS.has(k) && v !== undefined && v !== null) sanitized[k] = v;
    }
  }

  const input = {
    prompt,
    ...sanitized,
  };

  const t0 = Date.now();
  const output = await replicate.run(IMAGE_MODEL_ID, { input });
  const generationTime = Date.now() - t0;

  let imageUrl = null;
  if (output && typeof output.url === "function") {
    imageUrl = await output.url();
  } else if (typeof output === "string") {
    imageUrl = output;
  }

  if (!imageUrl) {
    return res.status(500).json({
      error: "Unexpected model output",
      debug: { typeofOutput: typeof output, hasUrlFn: !!(output && output.url) },
    });
  }

  const r = await fetch(imageUrl);
  if (!r.ok) {
    return res
      .status(r.status || 502)
      .json({ error: `Failed to download image: ${r.status} ${r.statusText}` });
  }

  const arrayBuf = await r.arrayBuffer();
  const fileBuffer = Buffer.from(arrayBuf);
  const contentType = r.headers.get("content-type") || "image/jpeg";
  const preferredFormat = typeof sanitized.output_format === "string" ? sanitized.output_format : null;
  const ext = preferredFormat
    ? preferredFormat
    : contentType.includes("png")
    ? "png"
    : contentType.includes("webp")
    ? "webp"
    : "jpg";
  const filename = `${uuidv4()}.${ext}`;
  const path = `${userId}/${characterId}/${filename}`;

  const { error: uploadError } = await supabase.storage
    .from("characters")
    .upload(path, fileBuffer, {
      cacheControl: "3600",
      upsert: false,
      contentType,
    });

  if (uploadError) {
    return res.status(500).json({ error: uploadError.message || String(uploadError) });
  }

  const { data: urlData } = supabase.storage.from("characters").getPublicUrl(path);

  return res.status(200).json({
    type: "image",
    path,
    url: urlData.publicUrl,
    generationTime,
    model: IMAGE_MODEL_ID,
    used: {
      speed_mode: sanitized.speed_mode,
      aspect_ratio: sanitized.aspect_ratio,
      image_size: sanitized.image_size,
      output_format: preferredFormat,
      guidance: sanitized.guidance,
      num_inference_steps: sanitized.num_inference_steps,
      seed: sanitized.seed,
    },
  });
}

async function handleVideoGeneration(req, res, { prompt, image, userId, characterId, clientInput }) {
  if (!prompt || !image || !userId || !characterId) {
    return res.status(400).json({
      error: "prompt, image, userId, characterId required for video generation",
    });
  }

  if (!WEBHOOK_URL) {
    console.error("WEBHOOK_URL not configured:", { 
      VERCEL_URL: process.env.VERCEL_URL,
      WEBHOOK_URL: process.env.WEBHOOK_URL 
    });
    return res.status(500).json({
      error: "Webhook URL not configured. Set WEBHOOK_URL or deploy to Vercel.",
    });
  }

  const sanitized = {};
  if (clientInput && typeof clientInput === "object") {
    for (const [k, v] of Object.entries(clientInput)) {
      if (ALLOWED_VIDEO_KEYS.has(k) && v !== undefined && v !== null) {
        sanitized[k] = v;
      }
    }
  }

  const input = {
    prompt,
    image,
    go_fast: true,
    num_frames: 81,
    resolution: "480p",
    frames_per_second: 16,
    sample_shift: 12,
    disable_safety_checker: false,
    ...sanitized,
  };

  input._meta = {
    userId,
    characterId,
  };

  const prediction = await replicate.predictions.create({
    model: VIDEO_MODEL_ID,
    input,
    webhook: WEBHOOK_URL,
    webhook_events_filter: ["completed"],
  });

  console.log(`Video generation started: ${prediction.id} for user ${userId}, character ${characterId}`);

  return res.status(202).json({
    type: "video",
    status: "processing",
    message: "Video generation started",
    predictionId: prediction.id,
  });
}

async function handleWebhook(req, res) {
  const prediction = req.body;

  if (prediction?.status !== "succeeded") {
    console.error("Webhook received for non-successful prediction:", prediction);
    return res
      .status(200)
      .json({ message: "Ignoring non-successful prediction." });
  }

  const videoUrl = prediction.output;
  if (!videoUrl) {
    console.error("Webhook payload missing output URL:", prediction);
    return res.status(400).json({ error: "Webhook payload missing output URL" });
  }

  const { userId, characterId } = prediction.input._meta || {};
  if (!userId || !characterId) {
    console.error("Webhook payload missing metadata:", prediction.input);
    return res.status(400).json({ error: "Webhook payload missing metadata" });
  }

  try {
    const r = await fetch(videoUrl);
    if (!r.ok) throw new Error(`Failed to download video: ${r.status}`);

    const fileBuffer = Buffer.from(await r.arrayBuffer());
    const contentType = r.headers.get("content-type") || "video/mp4";
    const filename = `${uuidv4()}.mp4`;
    const path = `${userId}/${characterId}/videos/${filename}`;

    const { error: uploadError } = await supabase.storage
      .from("characters")
      .upload(path, fileBuffer, {
        cacheControl: "3600",
        upsert: false,
        contentType,
      });

    if (uploadError) throw uploadError;

    const { error: insertError } = await supabase.from("messages").insert({
      character_id: characterId,
      user_id: userId,
      role: "assistant",
      content: null,
      video_url: path,
    });

    if (insertError) throw insertError;

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(
      `Webhook processing failed for user ${userId}, character ${characterId}:`,
      err,
    );
    return res
      .status(500)
      .json({ error: `Webhook processing failed: ${err.message}` });
  }
}


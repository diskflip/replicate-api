import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const IMAGE_MODEL_ID =
  "prunaai/flux.1-dev:b0306d92aa025bb747dc74162f3c27d6ed83798e08e5f8977adf3d859d0536a3";
const VIDEO_MODEL_ID = "wan-video/wan-2.2-i2v-fast";

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
    const { type = "image", prompt, image, userId, characterId, input: clientInput } = req.body || {};

    // Route to appropriate handler based on type
    if (type === "video") {
      return await handleVideoGeneration(req, res, { prompt, image, userId, characterId, clientInput });
    } else {
      return await handleImageGeneration(req, res, { prompt, userId, characterId, clientInput });
    }
  } catch (err) {
    console.error("[/generate] error:", err);
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
}

// Image generation handler
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

// Video generation handler
async function handleVideoGeneration(req, res, { prompt, image, userId, characterId, clientInput }) {
  if (!prompt || !image || !userId || !characterId) {
    return res.status(400).json({ error: "prompt, image, userId, characterId required for video generation" });
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

  const t0 = Date.now();
  const output = await replicate.run(VIDEO_MODEL_ID, { input });
  const generationTime = Date.now() - t0;

  let videoUrl = null;
  if (output && typeof output.url === "function") {
    videoUrl = await output.url();
  } else if (typeof output === "string") {
    videoUrl = output;
  }

  if (!videoUrl) {
    return res.status(500).json({
      error: "Unexpected model output",
      debug: { typeofOutput: typeof output, hasUrlFn: !!(output && output.url) },
    });
  }

  const r = await fetch(videoUrl);
  if (!r.ok) {
    return res
      .status(r.status || 502)
      .json({ error: `Failed to download video: ${r.status} ${r.statusText}` });
  }

  const arrayBuf = await r.arrayBuffer();
  const fileBuffer = Buffer.from(arrayBuf);
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

  if (uploadError) {
    return res.status(500).json({ error: uploadError.message || String(uploadError) });
  }

  const { data: urlData } = supabase.storage.from("characters").getPublicUrl(path);

  return res.status(200).json({
    type: "video",
    path,
    url: urlData.publicUrl,
    generationTime,
    model: VIDEO_MODEL_ID,
    duration: (input.num_frames / input.frames_per_second).toFixed(2) + "s",
    used: {
      resolution: input.resolution,
      num_frames: input.num_frames,
      frames_per_second: input.frames_per_second,
      go_fast: input.go_fast,
      sample_shift: input.sample_shift,
      seed: sanitized.seed,
    },
  });
}

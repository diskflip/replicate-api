import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Replicate model IDs
const IMAGE_MODEL_ID = "google/imagen-4";
const VIDEO_MODEL_ID = "kwaivgi/kling-v2.1";

// Allowed inputs (legacy + new)
const ALLOWED_IMAGE_KEYS = new Set([
  "seed","prompt","guidance","image_size","speed_mode","aspect_ratio",
  "output_format","output_quality","num_inference_steps",
  "safety_filter_level",
]);

const ALLOWED_VIDEO_KEYS = new Set([
  "seed","prompt","image","go_fast","num_frames","resolution",
  "sample_shift","frames_per_second","disable_safety_checker",
  "lora_scale_transformer","lora_scale_transformer_2",
  "lora_weights_transformer","lora_weights_transformer_2",
  "text",
  "mode","duration","start_image","negative_prompt",
]);

function extractUrl(output) {
  if (!output) return null;
  if (Array.isArray(output)) return output[0] ?? null;
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    if (typeof output.url === "function") return output.url();
    if (typeof output.url === "string") return output.url;
    if (typeof output.output === "string") return output.output;
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runWithRetry(model, input, tries = 2) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await replicate.run(model, { input });
    } catch (err) {
      lastErr = err;
      const name = err?.name || "Error";
      const msg = err?.message || String(err);
      const status = err?.status;
      const logs = err?.prediction?.logs;
      const detail = err?.prediction?.error || err?.error;
      console.error(`[replicate.run] ${name} status=${status} msg=${msg}`);
      if (logs) console.error(`[replicate.run] logs: ${logs}`);
      if (detail) console.error(`[replicate.run] detail: ${JSON.stringify(detail)}`);
      if (i < tries - 1) {
        const jitter = 300 + Math.floor(Math.random() * 500);
        console.log(`[replicate.run] retrying in ${jitter}ms...`);
        await sleep(jitter);
      }
    }
  }
  throw lastErr;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { type = "image", prompt, image, userId, characterId, input: clientInput } = req.body || {};
    if (type === "video") {
      return await handleVideoGeneration(res, { prompt, image, userId, characterId, clientInput });
    } else {
      return await handleImageGeneration(res, { prompt, userId, characterId, clientInput });
    }
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Unknown error in handler" });
  }
}

async function handleImageGeneration(res, { prompt, userId, characterId, clientInput }) {
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
    aspect_ratio: sanitized.aspect_ratio || "4:3",
    safety_filter_level: sanitized.safety_filter_level || "block_medium_and_above",
  };

  let output;
  try {
    console.log("[handleImageGeneration] replicate.run -> imagen-4");
    output = await runWithRetry(IMAGE_MODEL_ID, input, 2);
  } catch (err) {
    const msg = err?.message || "Image generation failed";
    return res.status(err?.status || 500).json({ error: msg });
  }

  const imageUrl = extractUrl(output);
  if (!imageUrl) {
    return res.status(500).json({ error: "Image generation failed (no URL)" });
  }

  const r = await fetch(imageUrl);
  if (!r.ok) {
    return res.status(502).json({ error: `Failed to download image: ${r.status} ${r.statusText}` });
  }

  const fileBuffer = Buffer.from(await r.arrayBuffer());
  const contentType = r.headers.get("content-type") || "image/jpeg";
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const filename = `${uuidv4()}.${ext}`;
  const path = `${userId}/${characterId}/${filename}`;

  const { error: uploadError } = await supabase.storage.from("characters").upload(path, fileBuffer, { contentType });
  if (uploadError) {
    return res.status(500).json({ error: uploadError.message || String(uploadError) });
  }

  const { data: urlData } = supabase.storage.from("characters").getPublicUrl(path);
  return res.status(200).json({ type: "image", path, url: urlData.publicUrl });
}

async function handleVideoGeneration(res, { prompt, image, userId, characterId, clientInput }) {
  if (!prompt || !userId || !characterId) {
    return res.status(400).json({ error: "prompt, userId, characterId required" });
  }

  const sanitized = {};
  if (clientInput && typeof clientInput === "object") {
    for (const [k, v] of Object.entries(clientInput)) {
      if (ALLOWED_VIDEO_KEYS.has(k) && v !== undefined && v !== null) sanitized[k] = v;
    }
  }

  const start_image = sanitized.start_image ?? image;
  if (!start_image) {
    return res.status(400).json({ error: "image or start_image required for video" });
  }

  const input = {
    prompt,
    start_image,
    ...(sanitized.mode ? { mode: sanitized.mode } : {}),
    ...(sanitized.duration ? { duration: sanitized.duration } : {}),
    ...(typeof sanitized.negative_prompt === "string" ? { negative_prompt: sanitized.negative_prompt } : {}),
  };

  let output;
  try {
    console.log("[handleVideoGeneration] replicate.run -> kling-v2.1");
    output = await runWithRetry(VIDEO_MODEL_ID, input, 2);
  } catch (err) {
    const msg = err?.message || "Video generation failed";
    return res.status(err?.status || 500).json({ error: msg });
  }

  const videoUrl = extractUrl(output);
  if (!videoUrl) {
    return res.status(500).json({ error: "Video generation failed (no URL)" });
  }

  const r = await fetch(videoUrl);
  if (!r.ok) {
    return res.status(502).json({ error: `Failed to download video: ${r.status} ${r.statusText}` });
  }

  const fileBuffer = Buffer.from(await r.arrayBuffer());
  const contentType = r.headers.get("content-type") || "video/mp4";
  const filename = `${uuidv4()}.mp4`;
  const path = `${userId}/${characterId}/videos/${filename}`;

  const { error: uploadError } = await supabase.storage.from("characters").upload(path, fileBuffer, { contentType });
  if (uploadError) {
    return res.status(500).json({ error: uploadError.message || String(uploadError) });
  }

  if (clientInput && typeof clientInput.text === "string") {
    try {
      await supabase.from("messages").insert({
        user_id: userId,
        character_id: characterId,
        role: "assistant",
        content: clientInput.text || null,
        video_url: path,
      });
    } catch {}
  }

  const { data: urlData } = supabase.storage.from("characters").getPublicUrl(path);
  return res.status(200).json({ type: "video", path, url: urlData.publicUrl });
}




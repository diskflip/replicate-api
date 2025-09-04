import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_KEY as string);

// New model IDs (Replicate)
const IMAGE_MODEL_ID = "google/imagen-4";
const VIDEO_MODEL_ID = "kwaivgi/kling-v2.1";

// Allow both legacy and new model keys (non-breaking)
const ALLOWED_IMAGE_KEYS = new Set([
  // legacy
  "seed", "prompt", "guidance", "image_size", "speed_mode", "aspect_ratio",
  "output_format", "output_quality", "num_inference_steps",
  // imagen-4 specific
  "safety_filter_level"
]);

const ALLOWED_VIDEO_KEYS = new Set([
  // legacy wan-video keys
  "seed", "prompt", "image", "go_fast", "num_frames", "resolution",
  "sample_shift", "frames_per_second", "disable_safety_checker",
  "lora_scale_transformer", "lora_scale_transformer_2",
  "lora_weights_transformer", "lora_weights_transformer_2",
  "text",
  // kling v2.1 inputs
  "mode", "duration", "start_image", "negative_prompt"
]);

function extractUrl(output: any): string | null {
  if (!output) return null;
  if (Array.isArray(output)) return output[0] ?? null;
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    if (typeof (output as any).url === "function") return (output as any).url();
    if (typeof (output as any).url === "string") return (output as any).url;
    if (typeof (output as any).output === "string") return (output as any).output;
  }
  return null;
}

export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { type = "image", prompt, image, userId, characterId, input: clientInput } = req.body || {};

    if (type === "video") {
      return await handleVideoGeneration(res, { prompt, image, userId, characterId, clientInput });
    } else {
      return await handleImageGeneration(res, { prompt, userId, characterId, clientInput });
    }
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Unknown error in handler" });
  }
}

async function handleImageGeneration(
  res: any,
  { prompt, userId, characterId, clientInput }: { prompt: string; userId: string; characterId: string; clientInput?: Record<string, any> }
) {
  if (!prompt || !userId || !characterId) {
    return res.status(400).json({ error: "prompt, userId, characterId required" });
  }

  const sanitized: Record<string, any> = {};
  if (clientInput && typeof clientInput === "object") {
    for (const [k, v] of Object.entries(clientInput)) {
      if (ALLOWED_IMAGE_KEYS.has(k) && v !== undefined && v !== null) sanitized[k] = v;
    }
  }

  // Imagen-4 expects: prompt, aspect_ratio?, safety_filter_level?
  const input = {
    prompt,
    ...(sanitized.aspect_ratio ? { aspect_ratio: sanitized.aspect_ratio } : {}),
    ...(sanitized.safety_filter_level ? { safety_filter_level: sanitized.safety_filter_level } : {})
  };

  const output = await replicate.run(IMAGE_MODEL_ID, { input });
  const imageUrl = extractUrl(output);
  if (!imageUrl) {
    return res.status(500).json({ error: "Image generation failed" });
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

async function handleVideoGeneration(
  res: any,
  { prompt, image, userId, characterId, clientInput }: { prompt: string; image?: string; userId: string; characterId: string; clientInput?: Record<string, any> }
) {
  if (!prompt || !userId || !characterId) {
    return res.status(400).json({ error: "prompt, userId, characterId required" });
  }

  const sanitized: Record<string, any> = {};
  if (clientInput && typeof clientInput === "object") {
    for (const [k, v] of Object.entries(clientInput)) {
      if (ALLOWED_VIDEO_KEYS.has(k) && v !== undefined && v !== null) sanitized[k] = v;
    }
  }

  // kling expects: prompt, start_image (optional but we use it), mode?, duration?, negative_prompt?
  // Preserve your API: accept legacy `image` and map to `start_image` if caller didn't pass start_image.
  const start_image = (sanitized.start_image as string) ?? image;
  if (!start_image) {
    return res.status(400).json({ error: "image or start_image required for video" });
  }

  const input: Record<string, any> = {
    prompt,
    start_image,
    ...(sanitized.mode ? { mode: sanitized.mode } : {}),
    ...(sanitized.duration ? { duration: sanitized.duration } : {}),
    ...(typeof sanitized.negative_prompt === "string" ? { negative_prompt: sanitized.negative_prompt } : {})
  };

  const output = await replicate.run(VIDEO_MODEL_ID, { input });
  const videoUrl = extractUrl(output);
  if (!videoUrl) {
    return res.status(500).json({ error: "Video generation failed to produce a URL." });
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

  // Preserve your existing DB insert of a video message with optional text
  if (clientInput && typeof clientInput.text === "string") {
    await supabase.from("messages").insert({
      user_id: userId,
      character_id: characterId,
      role: "assistant",
      content: clientInput.text || null,
      video_url: path
    }).catch(() => {});
  }

  const { data: urlData } = supabase.storage.from("characters").getPublicUrl(path);
  return res.status(200).json({ type: "video", path, url: urlData.publicUrl });
}


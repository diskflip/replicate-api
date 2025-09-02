
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const IMAGE_MODEL_ID =
  "prunaai/flux.1-dev:b0306d92aa025bb747dc74162f3c27d6ed83798e08e5f8977adf3d859d0536a3";
const VIDEO_MODEL_ID = "wan-video/wan-2.2-i2v-fast";

const ALLOWED_IMAGE_KEYS = new Set([
  "seed", "prompt", "guidance", "image_size", "speed_mode", "aspect_ratio",
  "output_format", "output_quality", "num_inference_steps",
]);

const ALLOWED_VIDEO_KEYS = new Set([
  "seed", "prompt", "image", "go_fast", "num_frames", "resolution",
  "sample_shift", "frames_per_second", "disable_safety_checker",
  "lora_scale_transformer", "lora_scale_transformer_2",
  "lora_weights_transformer", "lora_weights_transformer_2",
]);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    console.log("[handler] Responding to OPTIONS request.");
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    console.log(`[handler] Denying non-POST request. Method: ${req.method}`);
    return res.status(405).json({ error: "Method not allowed" });
  }

  console.log("[handler] Received POST request.");

  try {
    const { type = "image", prompt, image, userId, characterId, input: clientInput } = req.body || {};
    console.log(`[handler] Request type: ${type}, UserID: ${userId}, CharacterID: ${characterId}`);

    if (type === "video") {
      return await handleVideoGeneration(res, { prompt, image, userId, characterId, clientInput });
    } else {
      return await handleImageGeneration(res, { prompt, userId, characterId, clientInput });
    }
  } catch (err) {
    console.error("[handler] Uncaught error in main handler:", err);
    return res.status(500).json({ error: err?.message || "Unknown error in handler" });
  }
}

async function handleImageGeneration(res, { prompt, userId, characterId, clientInput }) {
  console.log(`[handleImageGeneration] Starting for user: ${userId}`);
  if (!prompt || !userId || !characterId) {
    console.error("[handleImageGeneration] Missing required parameters.");
    return res.status(400).json({ error: "prompt, userId, characterId required" });
  }

  const sanitized = {};
  if (clientInput && typeof clientInput === "object") {
    for (const [k, v] of Object.entries(clientInput)) {
      if (ALLOWED_IMAGE_KEYS.has(k) && v !== undefined && v !== null) sanitized[k] = v;
    }
  }

  const input = { prompt, ...sanitized };
  console.log("[handleImageGeneration] Starting image generation with Replicate...");
  const output = await replicate.run(IMAGE_MODEL_ID, { input });

  const imageUrl = Array.isArray(output) ? output[0] : output;
  if (!imageUrl) {
    console.error("[handleImageGeneration] Replicate failed to return an image URL.");
    return res.status(500).json({ error: "Image generation failed" });
  }
  console.log(`[handleImageGeneration] Replicate finished. Image URL: ${imageUrl}`);

  const r = await fetch(imageUrl);
  if (!r.ok) {
    console.error(`[handleImageGeneration] Failed to download image. Status: ${r.status}`);
    return res.status(502).json({ error: `Failed to download image: ${r.status} ${r.statusText}` });
  }
  console.log("[handleImageGeneration] Successfully downloaded image from Replicate.");

  const fileBuffer = Buffer.from(await r.arrayBuffer());
  const contentType = r.headers.get("content-type") || "image/jpeg";
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const filename = `${uuidv4()}.${ext}`;
  const path = `${userId}/${characterId}/${filename}`;

  console.log(`[handleImageGeneration] Attempting to upload to Supabase at path: ${path}`);
  const { error: uploadError } = await supabase.storage.from("characters").upload(path, fileBuffer, { contentType });
  if (uploadError) {
    console.error("[handleImageGeneration] Supabase upload failed:", JSON.stringify(uploadError, null, 2));
    return res.status(500).json({ error: uploadError.message || String(uploadError) });
  }
  console.log("[handleImageGeneration] Supabase upload successful.");

  const { data: urlData } = supabase.storage.from("characters").getPublicUrl(path);
  console.log(`[handleImageGeneration] Retrieved public URL: ${urlData.publicUrl}`);

  return res.status(200).json({ type: "image", path, url: urlData.publicUrl });
}

async function handleVideoGeneration(res, { prompt, image, userId, characterId, clientInput }) {
  console.log(`[handleVideoGeneration] Starting for user: ${userId}`);
  if (!prompt || !image || !userId || !characterId) {
    console.error("[handleVideoGeneration] Missing required parameters.");
    return res.status(400).json({ error: "prompt, image, userId, characterId required" });
  }

  const sanitized = {};
  if (clientInput && typeof clientInput === "object") {
    for (const [k, v] of Object.entries(clientInput)) {
      if (ALLOWED_VIDEO_KEYS.has(k) && v !== undefined && v !== null) sanitized[k] = v;
    }
  }

  const input = {
    prompt, image, go_fast: true, num_frames: 81, resolution: "480p",
    frames_per_second: 16, ...sanitized,
  };

  try {
    console.log("[handleVideoGeneration] Starting video generation with Replicate...");
    const output = await replicate.run(VIDEO_MODEL_ID, { input });

    const videoUrl = Array.isArray(output) ? output[0] : output;
    if (!videoUrl) {
      console.error("[handleVideoGeneration] Replicate failed to return a video URL.");
      throw new Error("Video generation failed to produce a URL.");
    }
    console.log(`[handleVideoGeneration] Replicate finished. Video URL: ${videoUrl}`);

    const r = await fetch(videoUrl);
    if (!r.ok) {
      throw new Error(`Failed to download video from Replicate: ${r.statusText}`);
    }
    console.log("[handleVideoGeneration] Successfully downloaded video from Replicate.");

    const fileBuffer = Buffer.from(await r.arrayBuffer());
    const contentType = r.headers.get("content-type") || "video/mp4";
    const filename = `${uuidv4()}.mp4`;
    const path = `${userId}/${characterId}/videos/${filename}`;

    console.log(`[handleVideoGeneration] Attempting to upload to Supabase at path: ${path}`);
    const { error: uploadError } = await supabase.storage
      .from("characters")
      .upload(path, fileBuffer, { contentType });

    if (uploadError) {
      console.error("[handleVideoGeneration] Supabase upload failed:", JSON.stringify(uploadError, null, 2));
      throw uploadError;
    }

    console.log("[handleVideoGeneration] Supabase upload successful. Retrieving public URL...");

    const { data: urlData } = supabase.storage.from("characters").getPublicUrl(path);

    if (!urlData || !urlData.publicUrl) {
      console.error("[handleVideoGeneration] Upload succeeded, but failed to get public URL. URL data:", urlData);
      throw new Error("Could not retrieve public URL for the video.");
    }

    console.log(`[handleVideoGeneration] Successfully retrieved public URL: ${urlData.publicUrl}`);
    return res.status(200).json({ type: "video", path, url: urlData.publicUrl });
  } catch (err) {
    console.error("[handleVideoGeneration] Final error caught:", err);
    return res.status(500).json({ error: err.message || "An unknown error occurred." });
  }
}

// api/generate.js - Update with the correct speed mode option
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// Pruna AI's optimized Flux.1-dev
const MODEL_ID = "prunaai/flux.1-dev:b0306d92aa025bb747dc74162f3c27d6ed83798e08e5f8977adf3d859d0536a3";

const DISABLE_SAFETY =
  (process.env.DISABLE_SAFETY ?? "").toLowerCase() === "true" ||
  process.env.NODE_ENV !== "production";

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { prompt, userId, characterId, input: clientInput } = req.body;

    if (!prompt || !userId || !characterId) {
      return res
        .status(400)
        .json({ error: "prompt, userId, characterId required" });
    }

    // FIXED: Use the correct speed_mode option
    const input = {
      prompt,
      aspect_ratio: "9:16",
      speed_mode: "Lightly Juiced 🍊 (more consistent)",  // Fixed: correct emoji and text
      guidance: 3.5,
      image_size: 1024,
      num_inference_steps: 28,
      output_format: "webp",
      output_quality: 80,
      seed: -1,
      ...(clientInput || {}),
    };

    console.log(`[Pruna Flux] Generating for character ${characterId}`);

    const startTime = Date.now();
    const output = await replicate.run(MODEL_ID, { input });
    const generationTime = Date.now() - startTime;

    console.log(`[Pruna Flux] Generation completed in ${generationTime}ms`);

    // Handle the output
    let imageUrl = null;

    if (output) {
      if (typeof output === "string") {
        imageUrl = output;
      } else if (typeof output.url === "function") {
        imageUrl = await output.url();
      } else if (typeof output.url === "string") {
        imageUrl = output.url;
      } else if (output && typeof output === "object") {
        imageUrl = output.toString();
      }
    }

    if (!imageUrl) {
      throw new Error("No image URL returned by Pruna Flux model");
    }

    // Download the image
    const r = await fetch(imageUrl);
    if (!r.ok) {
      throw new Error(`Failed to download image: ${r.status} ${r.statusText}`);
    }

    const ab = await r.arrayBuffer();
    const buf = Buffer.from(ab);
    const contentType = r.headers.get("content-type") || "image/webp";

    const ext = contentType.includes("png")
      ? "png"
      : contentType.includes("jpeg") || contentType.includes("jpg")
        ? "jpg"
        : "webp";

    const filename = `${uuidv4()}.${ext}`;
    const path = `${userId}/${characterId}/${filename}`;

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from("characters")
      .upload(path, buf, {
        cacheControl: "3600",
        upsert: false,
        contentType
      });

    if (uploadError) {
      throw uploadError;
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("characters")
      .getPublicUrl(path);

    res.status(200).json({
      path,
      url: urlData.publicUrl,
      generationTime
    });

  } catch (err) {
    console.error("[/generate] error:", err);
    res.status(500).json({
      error: err?.message || "Unknown error"
    });
  }
}

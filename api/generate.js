// api/generate.js
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const MODEL_ID = "black-forest-labs/flux-dev";
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

    const input = {
      prompt,
      aspect_ratio: "9:16",
      go_fast: false,
      guidance: 2.5,
      megapixels: "1", // flux-dev only allows "1" or "0.25"
      num_outputs: 1,
      output_format: "webp",
      output_quality: 100,
      num_inference_steps: 50,
      disable_safety_checker: DISABLE_SAFETY,
      ...(clientInput || {}),
    };

    if (input.megapixels !== "1" && input.megapixels !== "0.25") {
      input.megapixels = "1";
    }

    console.log(`Generating image for character ${characterId} with prompt:`, prompt.substring(0, 100));

    const output = await replicate.run(MODEL_ID, { input });

    // Replicate returns an array of file-like items with .url()
    const first = Array.isArray(output) ? output[0] : output;
    let imageUrl = null;

    if (first) {
      if (typeof first === "string") {
        imageUrl = first;
      } else if (typeof first.url === "function") {
        imageUrl = String(await first.url());
      } else if (typeof first.url === "string") {
        imageUrl = first.url;
      }
    }

    if (!imageUrl) {
      throw new Error("No image URL returned by model");
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
      url: urlData.publicUrl
    });

  } catch (err) {
    console.error("[/generate] error:", err);
    res.status(500).json({
      error: err?.message || "Unknown error"
    });
  }
}

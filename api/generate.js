// api/generate.js — Seedream-3, schema-faithful, JSON-only responses
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MODEL_ID = "bytedance/seedream-3";

export default async function handler(req, res) {
  // CORS + force JSON output so clients can always parse
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
    const { prompt, userId, characterId, input: clientInput } = req.body || {};
    if (!prompt || !userId || !characterId) {
      return res.status(400).json({ error: "prompt, userId, characterId required" });
    }

    // Allow only Seedream-3 schema keys; map guidance -> guidance_scale
    const allowedKeys = new Set([
      "seed",
      "size",
      "width",
      "height",
      "aspect_ratio",
      "guidance_scale"
    ]);
    const sanitized = {};
    if (clientInput && typeof clientInput === "object") {
      if (
        typeof clientInput.guidance === "number" &&
        typeof clientInput.guidance_scale !== "number"
      ) {
        sanitized.guidance_scale = clientInput.guidance;
      }
      for (const [k, v] of Object.entries(clientInput)) {
        if (allowedKeys.has(k)) sanitized[k] = v;
      }
    }

    // Defaults aligned with model docs; override with sanitized values
    const input = {
      prompt,
      aspect_ratio: sanitized.aspect_ratio ?? "9:16",
      size: sanitized.size ?? "regular",
      guidance_scale:
        typeof sanitized.guidance_scale === "number" ? sanitized.guidance_scale : 3.5,
      ...(typeof sanitized.seed === "number" ? { seed: sanitized.seed } : {}),
      ...(typeof sanitized.width === "number" ? { width: sanitized.width } : {}),
      ...(typeof sanitized.height === "number" ? { height: sanitized.height } : {})
    };

    console.log("[Seedream 3] Generating", { characterId, input });

    const t0 = Date.now();
    const output = await replicate.run(MODEL_ID, { input });
    const generationTime = Date.now() - t0;

    if (!output || typeof output.url !== "function") {
      return res.status(502).json({ error: "Model did not return a url() accessor" });
    }

    const imageUrl = await output.url();
    if (!imageUrl || typeof imageUrl !== "string") {
      return res.status(502).json({ error: "Model returned an invalid image URL" });
    }

    // Download image, then upload to Supabase
    const r = await fetch(imageUrl);
    if (!r.ok) {
      return res
        .status(r.status || 502)
        .json({ error: `Failed to download image: ${r.status} ${r.statusText}` });
    }
    const arrayBuf = await r.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuf);
    const contentType = r.headers.get("content-type") || "image/jpeg";

    const ext = contentType.includes("png")
      ? "png"
      : contentType.includes("jpeg") || contentType.includes("jpg")
      ? "jpg"
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
        contentType
      });

    if (uploadError) {
      return res
        .status(500)
        .json({ error: uploadError.message || String(uploadError) });
    }

    const { data: urlData } = supabase.storage.from("characters").getPublicUrl(path);

    return res.status(200).json({
      path,
      url: urlData.publicUrl,
      generationTime
    });
  } catch (err) {
    console.error("[/generate] error:", err);
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
}


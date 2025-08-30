import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MODEL_ID =
  "prunaai/flux.1-dev:b0306d92aa025bb747dc74162f3c27d6ed83798e08e5f8977adf3d859d0536a3";

const ALLOWED_KEYS = new Set([
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { prompt, userId, characterId, input: clientInput } = req.body || {};
    if (!prompt || !userId || !characterId) {
      return res.status(400).json({ error: "prompt, userId, characterId required" });
    }
    const sanitized = {};
    if (clientInput && typeof clientInput === "object") {
      for (const [k, v] of Object.entries(clientInput)) {
        if (ALLOWED_KEYS.has(k) && v !== undefined && v !== null) sanitized[k] = v;
      }
    }

    const input = {
      prompt,
      ...sanitized,
    };

    const t0 = Date.now();
    const output = await replicate.run(MODEL_ID, { input });
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
      path,
      url: urlData.publicUrl,
      generationTime,
      model: MODEL_ID,
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
  } catch (err) {
    console.error("[/generate] error:", err);
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
}

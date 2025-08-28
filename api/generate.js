// api/generate.js — aisha-ai-official/nsfw-flux-dev, schema-faithful, JSON-only responses
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Aisha NSFW Flux Dev (hash from your example)
const MODEL_ID =
  "aisha-ai-official/nsfw-flux-dev:8789ec8279c4b1614014feb714fef69fea839d446b76c36f9f20e92ae7f8a952";

// ---- Simple in-memory queue: serialize requests per instance ----
let __queue = Promise.resolve();
const enqueue = (task) => {
  const run = () => task().catch((e) => { throw e; });
  const p = __queue.then(run, run);
  __queue = p.catch(() => {}); // keep chain alive
  return p;
};

export default async function handler(req, res) {
  // CORS + JSON
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 🚦 Ensure we handle one request at a time (per server instance)
  return enqueue(async () => {
    try {
      const { prompt, userId, characterId, input: clientInput } = req.body || {};
      if (!prompt || !userId || !characterId) {
        return res
          .status(400)
          .json({ error: "prompt, userId, characterId required" });
      }

      // nsfw-flux-dev input schema: seed, steps, width, height, prompt, guidance_scale
      const allowedKeys = new Set([
        "seed",
        "steps",
        "width",
        "height",
        "guidance_scale",
      ]);
      const sanitized = {};
      if (clientInput && typeof clientInput === "object") {
        // back-compat: guidance -> guidance_scale
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

      // Defaults: high quality photos with 8 steps
      const input = {
        prompt,
        steps: typeof sanitized.steps === "number" ? sanitized.steps : 8,
        width: typeof sanitized.width === "number" ? sanitized.width : 1024,
        height: typeof sanitized.height === "number" ? sanitized.height : 1024,
        guidance_scale:
          typeof sanitized.guidance_scale === "number"
            ? sanitized.guidance_scale
            : 3.5,
        seed: typeof sanitized.seed === "number" ? sanitized.seed : -1, // -1 → random
      };

      console.log("[NSFW Flux Dev] Generating", { characterId, input });

      const t0 = Date.now();
      const output = await replicate.run(MODEL_ID, { input });
      const generationTime = Date.now() - t0;

      // Model returns an ARRAY; first element has url()
      let first = output;
      if (Array.isArray(output)) {
        first = output[0];
      }

      let fileBuffer = null;
      let contentType = "image/jpeg";

      if (first && typeof first === "object" && typeof first.url === "function") {
        const imageUrl = await first.url();
        const r = await fetch(imageUrl);
        if (!r.ok) {
          return res
            .status(r.status || 502)
            .json({
              error: `Failed to download image: ${r.status} ${r.statusText}`,
            });
        }
        const arrayBuf = await r.arrayBuffer();
        fileBuffer = Buffer.from(arrayBuf);
        contentType = r.headers.get("content-type") || contentType;
      } else if (typeof first === "string" && /^https?:\/\//.test(first)) {
        const r = await fetch(first);
        if (!r.ok) {
          return res
            .status(r.status || 502)
            .json({
              error: `Failed to download image: ${r.status} ${r.statusText}`,
            });
        }
        const arrayBuf = await r.arrayBuffer();
        fileBuffer = Buffer.from(arrayBuf);
        contentType = r.headers.get("content-type") || contentType;
      } else if (
        (typeof Blob !== "undefined" && first instanceof Blob) ||
        first instanceof Uint8Array
      ) {
        const arrayBuf =
          first instanceof Uint8Array ? first.buffer : await first.arrayBuffer();
        fileBuffer = Buffer.from(arrayBuf);
        if (typeof first.type === "string" && first.type) {
          contentType = first.type;
        }
      } else {
        return res.status(500).json({
          error: "Unrecognized model output shape",
          debug: {
            isArray: Array.isArray(output),
            type: typeof first,
            hasUrlFn:
              !!(first && typeof first === "object" && typeof first.url === "function"),
            isUint8Array: first instanceof Uint8Array,
            isBlob: typeof Blob !== "undefined" && first instanceof Blob,
          },
        });
      }

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
          contentType,
        });

      if (uploadError) {
        return res
          .status(500)
          .json({ error: uploadError.message || String(uploadError) });
      }

      const { data: urlData } = supabase.storage
        .from("characters")
        .getPublicUrl(path);

      return res.status(200).json({
        path,
        url: urlData.publicUrl,
        generationTime,
      });
    } catch (err) {
      console.error("[/generate] error:", err);
      return res.status(500).json({ error: err?.message || "Unknown error" });
    }
  });
}

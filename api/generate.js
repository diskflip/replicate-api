// api/generate.js — Seedream-3, simple + schema-faithful
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const MODEL_ID = "bytedance/seedream-3";

export default async function handler(req, res) {
  // CORS + ensure JSON output
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt, userId, characterId, input: clientInput } = req.body || {};
    if (!prompt || !userId || !characterId) {
      return res.status(400).json({ error: "prompt, userId, characterId required" });
    }

    // Seedream-3 schema keys only:
    // seed (int), size ("small"|"regular"|"big"), width (512-2048), height (512-2048),
    // prompt (string), aspect_ratio (enum incl. "custom"), guidance_scale (1..10)
    const allowedKeys = new Set([
      "seed",
      "size",
      "width",
      "height",
      "aspect_ratio",
      "guidance_scale",
    ]);

    const sanitized = {};
    if (clientInput && typeof clientInput === "object") {
      // back-compat: allow 'guidance' -> 'guidance_scale'
      if (typeof clientInput.guidance === "number" && typeof clientInput.guidance_scale !== "number") {
        sanitized.guidance_scale = clientInput.guidance;
      }
      for (const [k, v] of Object.entries(clientInput)) {
        if (allowedKeys.has(k)) sanitized[k] = v;
      }
    }

    // sensible defaults; override by sanitized values if provided
    const input = {
      prompt,
      aspect_ratio: sanitized.aspect_ratio ?? "9:16",
      size: sanitized.size ?? "regular",
      guidance_scale: typeof sanitized.guidance_scale === "number" ? sanitized.guidance_scale : 3.5,
      ...(typeof sanitized.seed === "number" ? { seed: sanitized.seed } : {}),
      ...(typeof sanitized.width === "number" ? { width: sanitized.width } : {}),
      ...(typeof sanitized.height === "number" ? { height: sanitized.height } : {}),
    };

    console.log(`[Seedream 3] Generating for ${characterId}`, input);

    const t0 = Date.now();
    const output = await replicate.run(MODEL_ID, { input });
    const generationTime = Date.now() - t0;

    // Official usage: get a URL from the output
    if (!output || typeof output.url !== "function") {
      return res.status(502).json({ error: "Model did not return a url() accessor" });
    }
    const imageUrl = await output.url();
    if (!imageUrl || typeof imageUrl !== "string") {
      return res.status(502).json({ error: "Model returned an invalid image URL" });
    }

    // Download the image so we can upload to Supabase
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

    // Upload to Supabase Storage
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

    // Public URL
    const { data: urlData } = supabase.storage.from("characters").getPublicUrl(path);

    return res.status(200).json({
      path,
      url: urlData.publicUrl,
      generationTime,
    });
  } catch (err) {
    console.error("[/generate] error:", err);
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
}
      }
    }

    const input = {
      prompt,
      aspect_ratio:
        normalized.aspect_ratio !== undefined
          ? normalized.aspect_ratio
          : "9:16",
      size: normalized.size !== undefined ? normalized.size : "regular",
      guidance_scale:
        typeof normalized.guidance_scale === "number"
          ? normalized.guidance_scale
          : 3.5,
      ...(normalized.aspect_ratio === "custom" ||
      normalized.width !== undefined ||
      normalized.height !== undefined
        ? {
            ...(normalized.width !== undefined && { width: normalized.width }),
            ...(normalized.height !== undefined && { height: normalized.height }),
          }
        : {}),
      ...(typeof normalized.seed === "number" && { seed: normalized.seed }),
    };

    console.log(`[Seedream 3] Generating for character ${characterId}`, {
      aspect_ratio: input.aspect_ratio,
      size: input.size,
      guidance_scale: input.guidance_scale,
      hasWH: "width" in input || "height" in input,
    });

    const startTime = Date.now();
    const output = await replicate.run(MODEL_ID, { input });
    const generationTime = Date.now() - startTime;

    console.log(`[Seedream 3] Generation completed in ${generationTime}ms`);

    // --- Get image bytes either via URL or directly from blob-like output ---
    let fileBuffer = null;
    let contentType = "image/jpeg"; // model outputs jpeg by default

    // Prefer URL if provided
    let imageUrl = null;
    try {
      if (output && typeof output === "object") {
        const maybeUrl =
          typeof output.url === "function" ? output.url() : output.url;
        imageUrl =
          typeof maybeUrl === "string"
            ? maybeUrl
            : (await Promise.resolve(maybeUrl));
      }
    } catch (_) {
      // fall through to blob path
    }

    if (imageUrl && typeof imageUrl === "string" && imageUrl.startsWith("http")) {
      const r = await fetch(imageUrl);
      if (!r.ok) {
        throw new Error(`Failed to download image: ${r.status} ${r.statusText}`);
      }
      const ab = await r.arrayBuffer();
      fileBuffer = Buffer.from(ab);
      contentType = r.headers.get("content-type") || contentType;
    } else if (output && typeof output === "object") {
      // Some SDKs return a blob-like object directly
      if (typeof output.arrayBuffer === "function") {
        const ab = await output.arrayBuffer();
        fileBuffer = Buffer.from(ab);
      } else if (typeof output.toString === "function") {
        // Last resort: not ideal, but keeps parity with prior behavior
        const str = output.toString();
        if (str.startsWith("http")) {
          const r = await fetch(str);
          if (!r.ok) {
            throw new Error(
              `Failed to download image (toString URL): ${r.status} ${r.statusText}`,
            );
          }
          const ab = await r.arrayBuffer();
          fileBuffer = Buffer.from(ab);
          contentType = r.headers.get("content-type") || contentType;
        }
      }
    }

    if (!fileBuffer) {
      throw new Error("Could not resolve image bytes from model output");
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

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from("characters")
      .upload(path, fileBuffer, {
        cacheControl: "3600",
        upsert: false,
        contentType,
      });

    if (uploadError) {
      throw uploadError;
    }

    // Public URL
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
    // Always return JSON (prevents client parse errors)
    return res.status(500).json({
      error: err?.message || "Unknown error",
    });
  }
}
      for (const [k, v] of Object.entries(clientInput)) {
        if (allowedKeys.has(k)) normalizedClient[k] = v;
      }
    }

    // Build model input
    // Note: aspect_ratio may be "9:16" etc. If "custom", width/height should be provided.
    const input = {
      prompt,
      aspect_ratio:
        normalizedClient.aspect_ratio !== undefined
          ? normalizedClient.aspect_ratio
          : "9:16",
      size:
        normalizedClient.size !== undefined ? normalizedClient.size : "regular", // "regular" ~1MP. Use "big" for 2K long edge.
      guidance_scale:
        typeof normalizedClient.guidance_scale === "number"
          ? normalizedClient.guidance_scale
          : 3.5,
      // Only include width/height if aspect_ratio is 'custom' or caller explicitly provided them
      ...(normalizedClient.aspect_ratio === "custom" ||
      normalizedClient.width !== undefined ||
      normalizedClient.height !== undefined
        ? {
            ...(normalizedClient.width !== undefined && {
              width: normalizedClient.width,
            }),
            ...(normalizedClient.height !== undefined && {
              height: normalizedClient.height,
            }),
          }
        : {}),
      ...(typeof normalizedClient.seed === "number" && {
        seed: normalizedClient.seed,
      }),
    };

    console.log(`[Seedream 3] Generating for character ${characterId}`, {
      aspect_ratio: input.aspect_ratio,
      size: input.size,
      guidance_scale: input.guidance_scale,
      hasWH: "width" in input || "height" in input,
    });

    const startTime = Date.now();
    const output = await replicate.run(MODEL_ID, { input });
    const generationTime = Date.now() - startTime;

    console.log(`[Seedream 3] Generation completed in ${generationTime}ms`);

    // Resolve output URL from Replicate response
    let imageUrl = null;

    if (output) {
      if (typeof output === "string") {
        imageUrl = output;
      } else if (output && typeof output.url === "function") {
        imageUrl = await output.url();
      } else if (output && typeof output.url === "string") {
        imageUrl = output.url;
      } else if (typeof output === "object") {
        // Fallback: try toString in case the SDK returns a file-like object
        try {
          const str = output.toString();
          if (typeof str === "string" && str.startsWith("http")) {
            imageUrl = str;
          }
        } catch {
          /* ignore */
        }
      }
    }

    if (!imageUrl) {
      throw new Error("No image URL returned by bytedance/seedream-3");
    }

    // Download the image
    const r = await fetch(imageUrl);
    if (!r.ok) {
      throw new Error(`Failed to download image: ${r.status} ${r.statusText}`);
    }

    const ab = await r.arrayBuffer();
    const buf = Buffer.from(ab);
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

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from("characters")
      .upload(path, buf, {
        cacheControl: "3600",
        upsert: false,
        contentType,
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
      generationTime,
    });
  } catch (err) {
    console.error("[/generate] error:", err);
    res.status(500).json({
      error: err?.message || "Unknown error",
    });
  }
}
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

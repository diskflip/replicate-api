// server.js
import express from "express";
import cors from "cors";
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const MODEL_ID = "black-forest-labs/flux-dev";
const DISABLE_SAFETY =
  (process.env.DISABLE_SAFETY ?? "").toLowerCase() === "true" ||
  process.env.NODE_ENV !== "production";

app.get("/", (_req, res) => {
  res.json({ ok: true, model: MODEL_ID, safety_disabled: DISABLE_SAFETY });
});

app.post("/generate", async (req, res) => {
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
    if (input.megapixels !== "1" && input.megapixels !== "0.25")
      input.megapixels = "1";

    const output = await replicate.run(MODEL_ID, { input });

    // Replicate returns an array of file-like items with .url()
    const first = Array.isArray(output) ? output[0] : output;
    let imageUrl = null;
    if (first) {
      if (typeof first === "string") imageUrl = first;
      else if (typeof first.url === "function")
        imageUrl = String(await first.url());
      else if (typeof first.url === "string") imageUrl = first.url;
    }
    if (!imageUrl) throw new Error("No image URL returned by model");

    const r = await fetch(imageUrl);
    if (!r.ok)
      throw new Error(`Failed to download image: ${r.status} ${r.statusText}`);
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

    const { error: uploadError } = await supabase.storage
      .from("characters")
      .upload(path, buf, { cacheControl: "3600", upsert: false, contentType });
    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from("characters")
      .getPublicUrl(path);
    res.json({ path, url: urlData.publicUrl });
  } catch (err) {
    console.error("[/generate] error:", err);
    res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

app.listen(PORT, () => {
  console.log(`replicate-api listening on :${PORT}`);
  console.log(
    "- REPLICATE_API_TOKEN:",
    process.env.REPLICATE_API_TOKEN ? "✓" : "✗",
  );
  console.log("- SUPABASE_URL:", process.env.SUPABASE_URL ? "✓" : "✗");
  console.log(
    "- SUPABASE_SERVICE_KEY:",
    process.env.SUPABASE_SERVICE_KEY ? "✓" : "✗",
  );
  console.log(
    "- DISABLE_SAFETY:",
    DISABLE_SAFETY ? "✓ (disabled)" : "✗ (enabled)",
  );
});

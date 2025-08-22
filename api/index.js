// api/index.js
const MODEL_ID = "black-forest-labs/flux-dev";
const DISABLE_SAFETY =
  (process.env.DISABLE_SAFETY ?? "").toLowerCase() === "true" ||
  process.env.NODE_ENV !== "production";

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  res.json({
    ok: true,
    model: MODEL_ID,
    safety_disabled: DISABLE_SAFETY,
    endpoints: {
      generate: "/api/generate"
    }
  });
}

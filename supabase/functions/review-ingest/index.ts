const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const BUCKET = "review-photos";
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function respond(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function isValidImage(type: string, bytes: Uint8Array) {
  const jpeg = type === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = type === "image/png" && bytes.length >= 8 && bytes[0] === 0x89
    && String.fromCharCode(...bytes.slice(1, 4)) === "PNG";
  const webp = type === "image/webp" && bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return jpeg || png || webp;
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return respond({ ok: false, error: "method-not-allowed" }, 405);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
    return respond({ ok: false, error: "expected-review-form" }, 415);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const secretKeysValue = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!url || !secretKeysValue) return respond({ ok: false, error: "server-not-configured" }, 503);

  let secretKey: string;
  try {
    secretKey = JSON.parse(secretKeysValue).default;
  } catch {
    return respond({ ok: false, error: "server-not-configured" }, 503);
  }
  if (!secretKey) return respond({ ok: false, error: "server-not-configured" }, 503);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return respond({ ok: false, error: "invalid-review-form" }, 400);
  }

  const id = String(form.get("id") ?? "");
  const name = String(form.get("name") ?? "").trim().slice(0, 60);
  const text = String(form.get("text") ?? "").trim().slice(0, 1000);
  const rating = Number(form.get("rating"));
  if (!/^RV-\d{8}-[A-F0-9]{5}$/.test(id) || !name || !text || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return respond({ ok: false, error: "invalid-review" }, 400);
  }

  const photoValue = form.get("photo");
  const photo = photoValue instanceof File && photoValue.size > 0 ? photoValue : null;
  if (photo && (photo.size > MAX_PHOTO_BYTES || !ALLOWED_TYPES.has(photo.type))) {
    return respond({ ok: false, error: "invalid-review-photo" }, 415);
  }

  const base = url.replace(/\/$/, "");
  const headers = { apikey: secretKey };
  let photoPath: string | null = null;
  if (photo) {
    const bytes = new Uint8Array(await photo.arrayBuffer());
    if (!isValidImage(photo.type, bytes)) return respond({ ok: false, error: "invalid-review-photo" }, 415);
    const extension = photo.type === "image/jpeg" ? "jpg" : photo.type === "image/png" ? "png" : "webp";
    photoPath = `${id}.${extension}`;
    const upload = await fetch(`${base}/storage/v1/object/${BUCKET}/${photoPath}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": photo.type, "x-upsert": "false" },
      body: bytes,
    });
    if (!upload.ok) return respond({ ok: false, error: "photo-upload-failed" }, 502);
  }

  const insert = await fetch(`${base}/rest/v1/customer_reviews`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ id, name, rating, body: text, photo_path: photoPath, published: false }),
  });
  if (!insert.ok) {
    if (photoPath) {
      await fetch(`${base}/storage/v1/object/${BUCKET}/${photoPath}`, { method: "DELETE", headers }).catch(() => undefined);
    }
    return respond({ ok: false, error: "review-save-failed" }, 502);
  }

  return respond({ ok: true, id, pending: true });
});

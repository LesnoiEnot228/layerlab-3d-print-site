const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_REVIEW_PHOTO_BYTES = 8 * 1024 * 1024;
const ALLOWED_REVIEW_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SUPABASE_REVIEW_BUCKET = "review-photos";
const reviewRateWindow = new Map();
const ALLOWED_EXTENSIONS = new Set(["stl", "3mf", "obj"]);
const ALLOWED_MATERIALS = new Set(["PLA", "PETG"]);
const ALLOWED_QUANTITIES = new Set(["1", "2", "3", "5", "10+"]);
const ALLOWED_DELIVERY = new Set(["Самовывоз в Минске", "Почта по Беларуси"]);

function getAllowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type, Accept, X-Order-Meta, X-File-Name, X-File-Size",
    "Access-Control-Expose-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function clean(value, maxLength = 500) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

function compactLines(values) {
  return values.filter((value) => value !== null && value !== undefined && String(value).trim() !== "").join("\n");
}

async function telegramJsonCall(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("telegram-invalid-response");
  }
  if (!response.ok || !result?.ok) throw new Error(`telegram-${method}-failed`);
  return result;
}

async function telegramSendDocumentStream(token, chatId, fileStream, fileName, caption) {
  // Build multipart/form-data as a stream so larger STL/3MF/OBJ files are not buffered or base64-encoded by the Worker.
  const boundary = `----LayerLab${crypto.randomUUID().replace(/-/g, "")}`;
  const encoder = new TextEncoder();
  const part = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const header = [
    part("chat_id", chatId),
    part("caption", caption),
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ].join("");
  const closing = `\r\n--${boundary}--\r\n`;
  let fileReader;
  const body = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(header));
        fileReader = fileStream.getReader();
        let total = 0;
        while (true) {
          const { value, done } = await fileReader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_FILE_BYTES) throw new Error("file-too-large");
          controller.enqueue(value);
        }
        controller.enqueue(encoder.encode(closing));
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        try { fileReader?.releaseLock(); } catch {}
      }
    },
    async cancel(reason) {
      try { await fileReader?.cancel(reason); } catch {}
    },
  });

  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    duplex: "half",
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("telegram-invalid-response");
  }
  if (!response.ok || !result?.ok) throw new Error("telegram-sendDocument-failed");
  return result;
}

function makeOrderId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase();
  return `LL-${date}-${suffix}`;
}

async function telegramSendReview(token, chatId, review, photo) {
  const details = compactLines([
    `⭐ Новый отзыв · ${review.id}`,
    `Имя: ${review.name}`,
    `Оценка: ${review.rating}/5`,
    `Текст: ${review.text}`,
    "Статус: ожидает ручной проверки перед публикацией",
  ]);
  if (!photo) {
    await telegramJsonCall(token, "sendMessage", { chat_id: chatId, text: details });
    return;
  }

  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("caption", `${review.id} · ${review.name} · ${review.rating}/5`);
  form.set("photo", photo, clean(photo.name || "review-photo", 100));
  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
  let result;
  try { result = await response.json(); } catch { throw new Error("telegram-invalid-response"); }
  if (!response.ok || !result?.ok) throw new Error("telegram-sendPhoto-failed");
  await telegramJsonCall(token, "sendMessage", { chat_id: chatId, text: details });
}

function isReviewRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const record = reviewRateWindow.get(ip);
  if (!record || now - record.startedAt >= windowMs) {
    reviewRateWindow.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  if (record.count >= 3) return true;
  record.count += 1;
  if (reviewRateWindow.size > 500) {
    for (const [key, value] of reviewRateWindow) if (now - value.startedAt >= windowMs) reviewRateWindow.delete(key);
  }
  return false;
}

async function handleReviewRequest(request, env, headers) {
  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  if (isReviewRateLimited(clientIp)) return json({ ok: false, error: "rate-limited" }, 429, headers);
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_REVIEW_PHOTO_BYTES + 512 * 1024) return json({ ok: false, error: "request-too-large" }, 413, headers);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("multipart/form-data;")) return json({ ok: false, error: "expected-review-form" }, 415, headers);

  let form;
  try { form = await request.formData(); } catch { return json({ ok: false, error: "invalid-review-form" }, 400, headers); }
  if (clean(form.get("website"), 200)) return json({ ok: true, ignored: true }, 200, headers);
  const review = {
    id: `RV-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    name: clean(form.get("name"), 60),
    rating: Number(form.get("rating")),
    text: clean(form.get("text"), 1000),
  };
  if (!review.name || !review.text || !Number.isInteger(review.rating) || review.rating < 1 || review.rating > 5) {
    return json({ ok: false, error: "invalid-review" }, 400, headers);
  }

  let photo = form.get("photo");
  if (!photo || typeof photo.arrayBuffer !== "function" || photo.size === 0) photo = null;
  if (photo) {
    if (photo.size > MAX_REVIEW_PHOTO_BYTES) return json({ ok: false, error: "review-photo-too-large" }, 413, headers);
    if (!ALLOWED_REVIEW_PHOTO_TYPES.has(photo.type)) return json({ ok: false, error: "unsupported-review-photo" }, 415, headers);
    const header = new Uint8Array(await photo.slice(0, 12).arrayBuffer());
    const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    const isPng = header.length >= 8 && header[0] === 0x89 && String.fromCharCode(...header.slice(1, 4)) === "PNG";
    const isWebp = header.length >= 12 && String.fromCharCode(...header.slice(0, 4)) === "RIFF" && String.fromCharCode(...header.slice(8, 12)) === "WEBP";
    if (!(isJpeg || isPng || isWebp)) return json({ ok: false, error: "invalid-review-photo" }, 415, headers);
  }

  try {
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ ok: false, error: "reviews-not-configured" }, 503, headers);
    const reviewForm = new FormData();
    reviewForm.set("id", review.id);
    reviewForm.set("name", review.name);
    reviewForm.set("rating", String(review.rating));
    reviewForm.set("text", review.text);
    if (photo) reviewForm.set("photo", photo, clean(photo.name || "review-photo", 100));
    const saveResponse = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/functions/v1/review-ingest`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
      body: reviewForm,
    });
    let saved = {};
    try { saved = await saveResponse.json(); } catch {}
    if (!saveResponse.ok || !saved?.ok) {
      console.error("Supabase review save failed", saveResponse.status);
      return json({ ok: false, error: "review-save-failed" }, 502, headers);
    }
    try {
      await telegramSendReview(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, review, photo);
      return json({ ok: true, reviewId: review.id, pending: true }, 200, headers);
    } catch {
      return json({ ok: true, reviewId: review.id, pending: true, notificationFailed: true }, 202, headers);
    }
  } catch {
    return json({ ok: false, error: "review-save-failed" }, 502, headers);
  }
}

async function handlePublishedReviews(env, headers) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ ok: false, error: "reviews-not-configured" }, 503, headers);
  const endpoint = new URL(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/customer_reviews`);
  endpoint.search = new URLSearchParams({
    select: "id,name,rating,body,photo_path,created_at",
    published: "eq.true",
    order: "created_at.desc",
    limit: "12",
  }).toString();
  try {
    const response = await fetch(endpoint, {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      console.error("Supabase published reviews request failed", response.status);
      return json({ ok: false, error: "reviews-unavailable" }, 502, headers);
    }
    const rows = await response.json();
    const base = `${env.SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/${SUPABASE_REVIEW_BUCKET}/`;
    const reviews = Array.isArray(rows) ? rows.map((row) => ({
      id: row.id,
      name: row.name,
      rating: row.rating,
      text: row.body,
      photo: row.photo_path ? `${base}${encodeURIComponent(row.photo_path)}` : null,
    })) : [];
    return json({ ok: true, reviews }, 200, { ...headers, "Cache-Control": "public, max-age=60" });
  } catch {
    return json({ ok: false, error: "reviews-unavailable" }, 502, headers);
  }
}

function formatOrder(data) {
  const model = data.fileName || data.modelRequest || (data.comment ? "Заявка по описанию клиента" : "Модель не указана");
  const analysis = data.analysis || {};
  const analysisLines = [
    analysis.dimensions ? `Габариты: ${analysis.dimensions}` : "",
    analysis.triangles ? `Треугольники: ${analysis.triangles}` : "",
    analysis.surface ? `Площадь поверхности: ${analysis.surface} см²` : "",
    analysis.volume ? `Геометрический объём: ${analysis.volume} см³` : "",
    analysis.filament ? `Оценка пластика: ${analysis.filament}` : "",
    analysis.printTime ? `Оценка времени печати: ${analysis.printTime}` : "",
    analysis.infill ? `Заполнение: ${analysis.infill}` : "",
    analysis.layerHeight ? `Высота слоя: ${analysis.layerHeight}` : "",
  ].filter(Boolean);
  return compactLines([
    "🖨️ НОВЫЙ ЗАКАЗ НА 3D-ПЕЧАТЬ",
    `Заказ: ${data.orderId}`,
    `Клиент: ${data.customerName}`,
    `Модель: ${model}`,
    data.modelRequest && data.fileName ? `Поисковый запрос: ${data.modelRequest}` : "",
    data.sourceUrl ? `Страница модели: ${data.sourceUrl}` : "",
    `Материал: ${data.material}`,
    `Цвет: ${data.color}`,
    `Количество: ${data.quantity}`,
    `Получение: ${data.delivery}`,
    `Контакт: ${data.contact}`,
    data.comment ? `Комментарий: ${data.comment}` : "",
    data.estimate ? `Ориентировочная цена на сайте: ${data.estimate}` : "",
    analysisLines.length ? "\nАНАЛИЗ МОДЕЛИ (ОРИЕНТИРОВОЧНО):\n" + analysisLines.join("\n") : "",
    "\nСледующий шаг: проверить модель, лицензию и параметры печати, затем подтвердить цену клиенту.",
  ]);
}

function normalizePayload(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  let analysis = source.analysis;
  if (typeof analysis === "string") {
    try { analysis = JSON.parse(analysis); } catch { analysis = {}; }
  }
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) analysis = {};
  return {
    customerName: clean(source.customerName, 100),
    modelRequest: clean(source.modelRequest, 200),
    sourceUrl: clean(source.sourceUrl, 500),
    material: clean(source.material, 10),
    quantity: clean(source.quantity, 4),
    color: clean(source.color, 40) || "Белый / White",
    delivery: clean(source.delivery, 80),
    contact: clean(source.contact, 160),
    comment: clean(source.comment, 1200),
    estimate: clean(source.estimate, 150),
    language: clean(source.language, 2) === "en" ? "en" : "ru",
    website: clean(source.website, 200),
    analysis: {
      dimensions: clean(analysis.dimensions, 80),
      triangles: clean(analysis.triangles, 40),
      surface: clean(analysis.surface, 40),
      volume: clean(analysis.volume, 40),
      filament: clean(analysis.filament, 60),
      printTime: clean(analysis.printTime, 60),
      infill: clean(analysis.infill, 20),
      layerHeight: clean(analysis.layerHeight, 20),
      units: clean(analysis.units, 10),
    },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = getAllowedOrigins(env);
    const originAllowed = Boolean(origin) && allowedOrigins.includes(origin);
    const headers = originAllowed ? corsHeaders(origin) : {};

    if (url.pathname === "/health" && request.method === "GET") {
      // Expose only whether required secrets exist, never their values.
      const healthHeaders = originAllowed ? headers : {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Cache-Control": "no-store",
      };
      return json({
        ok: true,
        configured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
        service: "layerlab-order-bot",
      }, 200, healthHeaders);
    }
    if (url.pathname !== "/api/order" && url.pathname !== "/api/review" && url.pathname !== "/api/reviews") return json({ ok: false, error: "not-found" }, 404, headers);
    if (request.method === "OPTIONS") {
      if (!originAllowed) return json({ ok: false, error: "origin-not-allowed" }, 403);
      return new Response(null, { status: 204, headers });
    }
    if (!originAllowed) return json({ ok: false, error: "origin-not-allowed" }, 403);
    if (url.pathname === "/api/reviews") {
      if (request.method !== "GET") return json({ ok: false, error: "method-not-allowed" }, 405, headers);
      return handlePublishedReviews(env, headers);
    }
    if (request.method !== "POST") return json({ ok: false, error: "method-not-allowed" }, 405, headers);
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return json({ ok: false, error: "telegram-not-configured" }, 503, headers);
    if (url.pathname === "/api/review") return handleReviewRequest(request, env, headers);

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_FILE_BYTES + 512 * 1024) return json({ ok: false, error: "request-too-large" }, 413, headers);

    const isFileUpload = Boolean(request.headers.get("X-File-Name"));
    let rawPayload;
    let safeFileName = "";
    let fileSize = 0;
    if (isFileUpload) {
      try {
        rawPayload = JSON.parse(decodeURIComponent(request.headers.get("X-Order-Meta") || ""));
        safeFileName = clean(decodeURIComponent(request.headers.get("X-File-Name") || ""), 180).replace(/[^A-Za-z0-9._() -]/g, "_");
        fileSize = Number(request.headers.get("X-File-Size") || contentLength || 0);
      } catch {
        return json({ ok: false, error: "invalid-order-metadata" }, 400, headers);
      }
      if (!request.body || !safeFileName) return json({ ok: false, error: "missing-file" }, 400, headers);
      if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_FILE_BYTES) return json({ ok: false, error: "file-too-large-or-empty" }, 413, headers);
      const extension = safeFileName.split(".").pop().toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) return json({ ok: false, error: "unsupported-file-type" }, 415, headers);
    } else {
      if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") return json({ ok: false, error: "expected-json-or-file" }, 415, headers);
      try { rawPayload = await request.json(); } catch { return json({ ok: false, error: "invalid-json" }, 400, headers); }
    }

    const data = normalizePayload(rawPayload);
    if (data.website) return json({ ok: true, ignored: true }, 200, headers);
    if (!data.customerName || !data.contact) return json({ ok: false, error: "name-and-contact-required" }, 400, headers);
    if (!isFileUpload && !data.modelRequest && !data.sourceUrl && !data.comment) return json({ ok: false, error: "model-or-file-required" }, 400, headers);
    if (!ALLOWED_MATERIALS.has(data.material)) return json({ ok: false, error: "invalid-material" }, 400, headers);
    if (!ALLOWED_QUANTITIES.has(data.quantity)) return json({ ok: false, error: "invalid-quantity" }, 400, headers);
    if (!ALLOWED_DELIVERY.has(data.delivery)) return json({ ok: false, error: "invalid-delivery" }, 400, headers);
    if (data.sourceUrl) {
      try {
        const parsed = new URL(data.sourceUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("protocol");
      } catch {
        return json({ ok: false, error: "invalid-model-url" }, 400, headers);
      }
    }

    data.orderId = makeOrderId();
    data.fileName = safeFileName;
    const orderMessage = formatOrder(data);

    try {
      if (isFileUpload) {
        const caption = compactLines([
          `📎 Файл к заказу ${data.orderId}`,
          `Клиент: ${data.customerName}`,
          `Модель: ${safeFileName}`,
          `Материал: ${data.material} · ${data.color}`,
          `Количество: ${data.quantity}`,
          `Получение: ${data.delivery}`,
          `Контакт: ${data.contact}`,
        ]).slice(0, 1024);
        await telegramSendDocumentStream(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, request.body, safeFileName, caption);
        try {
          await telegramJsonCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: orderMessage });
        } catch {
          return json({ ok: true, partial: true, orderId: data.orderId }, 200, headers);
        }
      } else {
        await telegramJsonCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: orderMessage });
      }
      return json({ ok: true, orderId: data.orderId, hasFile: isFileUpload }, 200, headers);
    } catch {
      return json({ ok: false, error: "telegram-send-failed" }, 502, headers);
    }
  },
};

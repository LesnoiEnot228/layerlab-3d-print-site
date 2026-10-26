const MAX_FILE_BYTES = 30 * 1024 * 1024;
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

function formatOrder(data) {
  const model = data.fileName || data.modelRequest || "Модель не указана";
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
    if (url.pathname !== "/api/order") return json({ ok: false, error: "not-found" }, 404, headers);
    if (request.method === "OPTIONS") {
      if (!originAllowed) return json({ ok: false, error: "origin-not-allowed" }, 403);
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") return json({ ok: false, error: "method-not-allowed" }, 405, headers);
    if (!originAllowed) return json({ ok: false, error: "origin-not-allowed" }, 403);
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return json({ ok: false, error: "telegram-not-configured" }, 503, headers);

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
    if (!isFileUpload && !data.modelRequest && !data.sourceUrl) return json({ ok: false, error: "model-or-file-required" }, 400, headers);
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

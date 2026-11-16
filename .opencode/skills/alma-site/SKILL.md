---
name: Alma Lab site playbook
description: Safely change and verify the Alma Lab site — which layer to edit (Pages/Worker/Supabase), deploy commands, check tools, and pitfalls. Use for any task in this repo.
---

## Что это

Статический лендинг `index.html` (без сборки) + Cloudflare Worker `layerlab-order-bot` + Supabase Edge Function `review-ingest`. `PROJECT_HANDOFF.md` — живая память, читай его до любого изменения.

## Слои изменений

- Текст/галерея/переводы/вёрстка → только `index.html`, публикация push в `main` (Cloudflare Pages `https://alma-lab.pages.dev/`).
- Форма заявки, отзывы, CORS, лимиты, Telegram → `worker/src/index.js`; deploy: `npx wrangler deploy --config worker/wrangler.toml`. HTML-деплой Worker НЕ обновляет.
- Сохранение отзывов/фото → `supabase/functions/review-ingest/index.ts`; деплой отдельно через Supabase CLI/дашборд.

## Порядок работы

1. `git status` — береги untracked-файлы владельца (`.aВерсии/`, `.trail/`, `AGENTS.md`, `PROJECT_HANDOFF.md` — локальные, в git не пушим).
2. Для поиска кода сначала `trail ask "<вопрос>" --source` (см. AGENTS.md).
3. После правки `index.html` вызови инструменты плагина `alma_inline_js_check` и `alma_i18n_check`, затем проверь страницу в браузере (desktop + mobile).
4. После правки Worker: `npx wrangler deploy --config worker/wrangler.toml`, затем `alma_worker_health` (ожидаем `configured:true`).
5. Не отправляй тестовые заказы/отзывы в production Telegram без явного разрешения владельца.

## Грабли

- Переводы: обе локали RU/EN обновляются всегда; `data-i18n-html` разрешает HTML, `data-i18n` — plain text.
- Коллекции: `$$('.order-entry')`, не `$()`.
- `ALLOWED_*` в Worker должны совпадать с дропдаунами фронта.
- `https://alma-lab-minsk.netlify.app/` устарела; проверять и публиковать только через `https://alma-lab.pages.dev/`.
- Красный `github-pages` deployment — старый механизм, игнорируй.
- Секреты (TELEGRAM_BOT_TOKEN, SUPABASE_SECRET_KEYS) не коммитить и не выводить.

## Проверка UI вручную

Карточки file/find/custom, переключатель языка, мобильное меню, галерея/lightbox/FAQ, формы: file и find выбираются отдельно, `custom` открывает Telegram.

---
title: Keep new reviews in Telegram moderation until a database is connected
author: LesnoiEnot
date: 2026-11-03
branch: codex/simplified-site
id: l-7bde363b
scope: repo
status: active
src: agent
touches:
  - README.md
  - index.html
  - worker/src/index.js
  - AGENTS.md
  - assets/reviews.json
  - figm_link.txt
---

## Decided
Until a persistent review database is connected, route new site reviews through the existing Telegram Worker and require manual approval before website publication. This prevents anonymous submissions from appearing publicly without moderation.

## Tried and ruled out
A Supabase-backed public review feed was not used because the Supabase tool connection was unavailable in this session and no project could be inspected.

## Watch out
Telegram is only the moderation inbox, not the public review database. To publish an approved review, add its photo under assets/ and add a record to assets/reviews.json, then redeploy the site. The updated Worker must also be deployed and its ALLOWED_ORIGINS must include the live site origin.

In the code: worker/src/index.js handles POST /api/review; assets/reviews.json is the published list; assets/config.js supplies the Worker API base URL.

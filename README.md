# Tucat — Agentic AI Vlog Editor

Sabihin mo lang ang gusto mong edit ("gawing 30s highlights, cinematic, pang-TikTok") at ang AI agent na ang gagawa ng cuts at effects. CapCut-style na timeline + preview, may AI chat at one-tap presets.

## Pagpapatakbo

Kailangan: Node 20.12+ at `ffmpeg`/`ffprobe` sa PATH.

```bash
npm install
cp .env.example .env      # ilagay ang OPENROUTER_API_KEY (opsyonal)
npm start                 # http://localhost:3000
npm test
```

Kapag walang `OPENROUTER_API_KEY`, tatakbo ito sa **demo mode**: simpleng keyword planner ang papalit sa LLM (libre, para sa testing). Gumagana pa rin ang lahat ng manual tools, presets, at export.

## Paano gumagana

```
Browser (public/)  ──►  Backend (server/)  ──►  OpenRouter (isang key, maraming model)
   walang API key          │  .env: OPENROUTER_API_KEY
                           ├─ rate limit + daily quota + monthly budget
                           ├─ agent loop: LLM ⇄ editing tools
                           └─ ffmpeg: analysis + render
```

- **Non-destructive edit (EDL).** Hindi ginagalaw ang orihinal na video. Ang edit ay listahan ng clips + effects (`server/edit.js`). Ang preview sa browser ay ang source video na pinapatugtog ayon sa EDL, kaya instant ang resulta; ffmpeg lang ang tumatakbo sa Export.
- **Agent tools** (`server/tools.js`): `analyze_video`, `remove_silence`, `make_highlights`, `cut_range`, `split_at`, `set_speed`, `apply_filter`, `set_zoom`, `add_text`, `set_transition`, `set_fades`, `set_aspect`, `set_audio`, atbp. Lahat ng argumento mula sa model ay vina-validate at kina-clamp sa server. Ang parehong tools ang ginagamit ng mga button sa UI — walang LLM cost.
- **Analysis na walang AI cost** (`server/analysis.js`), lahat lokal:
  - loudness envelope (RMS kada 50 ms) mula sa isang PCM decode pass
  - adaptive silence detection — ang threshold ay kinukuha sa noise floor ng mismong video
  - scene-change detection (ffmpeg scene score)
  - highlight scoring: `0.6·z(loudness) + 0.25·z(onset) + 0.15·z(scene density)`, sliding-window sum, greedy na pagpili ng hindi nagpapatong na segments, at snapping ng cuts sa pinakamalapit na katahimikan
- **Render** (`server/render.js`): EDL → ffmpeg filter graph (trim, speed, crop/scale sa aspect ratio, color looks, xfade transitions, text, fades, EBU R128 loudness normalization) → H.264 MP4.

## Seguridad at kontrol sa gastos

| Kontrol | Saan |
| --- | --- |
| API key nasa server lang (`.env`, hindi naka-commit) | `server/config.js` |
| Token-bucket rate limit kada IP (`CHAT_PER_MINUTE`) | `server/limits.js` |
| Daily quota kada IP (`CHAT_PER_DAY`, `UPLOADS_PER_DAY`, `RENDERS_PER_DAY`) | `server/limits.js` |
| Monthly budget (`MONTHLY_BUDGET_USD`) — sinusukat mula sa aktuwal na `usage.cost` ng OpenRouter; hihinto ang AI kapag naabot | `server/limits.js`, `server/agent.js` |
| Murang default model + fallbacks (`LLM_MODEL`, `LLM_FALLBACK_MODELS`), `LLM_MAX_TOKENS`, `AGENT_MAX_STEPS` | `.env` |

Bukod dito, sa OpenRouter dashboard: gumamit ng prepaid credits, **i-off ang Auto Top-Up**, at lagyan ng credit limit ang mismong key. Iyon ang huling harang kung may makalusot sa server-side limits.

Ang quota ay naka-key sa IP (walang login pa). Kapag nasa likod ng proxy, itakda ang `TRUST_PROXY=1` para tama ang IP.

## Deployment

Kailangan ng app ang ffmpeg at disk para sa uploads, kaya **container host** ang bagay dito (Render, Railway, Fly.io, o VPS) — hindi kasya ang video rendering sa Cloudflare Workers / Vercel / Supabase Edge Functions. Ilagay ang mga value ng `.env` sa environment variables ng host at i-mount ang `data/` (o `DATA_DIR`) sa persistent disk.

## Mga limitasyon sa ngayon

- Hindi "nakikita" o "naririnig" ng agent ang laman ng video — loudness, katahimikan, at scene changes lang ang batayan nito. Wala pang auto-captions (speech-to-text), music, o stickers.
- Isang source video kada project. Walang user accounts; ang project link (may random ID) ang nagsisilbing access.
- Ang preview ay approximation ng color looks at transitions; ang export ang eksaktong resulta.
- Ang agent loop sa totoong LLM (OpenRouter) ay hindi pa nasusubukan nang live dito dahil walang API key sa build environment; demo mode at lahat ng tools/render ang na-verify.

# VayuShield — Urban Air Quality & Atmospheric Dispersion Intelligence

> **Understand the air. Predict the risk. Protect your environment.**

**Live Production App:** [https://vayushield-ai-five.vercel.app/](https://vayushield-ai-five.vercel.app/)

VayuShield is a scientific urban air quality, atmospheric dispersion, and indoor air-engineering platform combining live Copernicus CAMS / Open-Meteo telemetry, validated 8-pollutant Indian CPCB NAQI calculations, steady-state indoor filtration physics, daylight-aware daily scheduling, and a server-proxied **Google Gemini 3.5 Flash** coach.

---

## Updated Architecture (v2.5 Chimera)

```text
┌────────────────────────────────────────────────────────────────────────────┐
│            VayuShield Frontend (Zero-Bloat Vanilla ESM, WCAG 2.2 AA)       │
│  index.html + styles/main.css + js/app.js (Zero innerHTML / Zero inline)   │
└───────────────┬──────────────────────────────────────────┬─────────────────┘
                │                                          │
                ▼                                          ▼
┌────────────────────────────────────────┐  ┌────────────────────────────────┐
│       Pure Scientific Core (js/core)   │  │     Services & Server Proxy    │
│ • dataIntegrity.js (Freshness & Units) │  │ • airQualityService.js (Dual   │
│ • cpcbAqi.js (8-Pollutant CPCB NAQI)   │  │   Open-Meteo AQ + Meteorology) │
│ • dispersionEngine.js (BLH, VC, Sun)   │  │ • aiAssistantService.js        │
│ • indoorPhysics.js (Mass-Balance CADR) │  │ • /api/gemini.js (Rate-Limited │
│ • impactModel.js (Parameterized CO2)   │  │   Server-Side Gemini Proxy)    │
│ • routineEngine.js (Daylight Schedule) │  └────────────────────────────────┘
│ • communityModeration.js (PII Guard)   │
│ • security.js (Zero-XSS DOM Helpers)   │
└────────────────────────────────────────┘

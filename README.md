# Web Bus Worker

A Cloudflare Worker application for managing bus data and Telegram bot integration.

## 🚀 Quick Start

1. **Clone and install dependencies (repo root + worker):**
   ```bash
   npm run install:all
   ```
   Or only the Worker: `cd webbus-worker && npm install`

2. **Local development (frontend + Worker together):**
   ```bash
   # Optional: copy secrets for wrangler dev
   copy webbus-worker\.dev.vars.example webbus-worker\.dev.vars   # Windows
   # cp webbus-worker/.dev.vars.example webbus-worker/.dev.vars  # macOS/Linux

   npm run dev
   ```
   - Open **http://127.0.0.1:5173** — the page auto-uses **http://127.0.0.1:8787** for the API when host is localhost.
   - **Important:** default `wrangler dev` uses **local KV** (starts empty). Saved bus stops on **Pages production** live in **Cloudflare KV**, so they will **not** appear until you either re-add stops locally or use remote bindings:
   ```bash
   npm run dev:remote
   ```
   (`dev:remote` runs `wrangler dev --remote` so the Worker uses your **online** KV; saves from the UI then affect production data — use with care.)
   - To point at a deployed Worker instead: in the browser console run  
     `localStorage.setItem('WEBBUS_API_BASE','https://your-worker.workers.dev')` then reload.

3. **Set up environment variables (optional legacy `.env` at repo root):**
   ```bash
   cp .env.example .env
   # Edit .env with your actual values
   ```

4. **Configure Cloudflare secrets (production deploy)** — run from `webbus-worker` (or use `npx wrangler --cwd webbus-worker secret put ...`):
   ```bash
   cd webbus-worker
   wrangler secret put TELEGRAM_BOT_TOKEN
   wrangler secret put TELEGRAM_CHAT_ID
   wrangler secret put WEBHOOK_ID_TRIGGER
   wrangler secret put WEBHOOK_ID_TELEGRAM
   ```

5. **Deploy:**
   ```bash
   npm run deploy
   ```
   (Runs `wrangler deploy` inside `webbus-worker`.)

## 🌐 Deployment

This project is deployed with a separate frontend and backend.

- **Frontend URL:** [https://web-bus.pages.dev](https://web-bus.pages.dev)
- **Backend URL:** [https://webbus-worker.quinton0121.workers.dev](https://webbus-worker.quinton0121.workers.dev)

## 🔧 Development

```bash
npm run dev          # From repo root: Worker (wrangler dev) + static site (port 5173)
npm run dev:worker   # Worker only
npm run dev:web      # Static files only (same folder as index.html)
npm run test         # Run tests (in webbus-worker)
```

## 📁 Project Structure

- `webbus-worker/src/index.ts` - Main Cloudflare Worker code (deployed)
- `index.html` - Configuration UI (Pages / static)
- `bus_request_secure.json` - Secure n8n workflow configuration
- `src/index.ts` - Legacy duplicate entry (prefer `webbus-worker/`)

## 🔒 Security

This project uses environment variables and Cloudflare Workers secrets to protect sensitive data. See `SECURITY_SETUP.md` for detailed setup instructions.

## 📝 License

Private project
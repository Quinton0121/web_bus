# Web Bus Worker

A Cloudflare Worker application for managing bus data and Telegram bot integration.

## 🚀 Quick Start

1. **Clone and install dependencies:**
   ```bash
   cd webbus-worker
   npm install
   ```

2. **Set up environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your actual values
   ```

3. **Configure Cloudflare secrets:**
   ```bash
   wrangler secret put TELEGRAM_BOT_TOKEN
   wrangler secret put TELEGRAM_CHAT_ID
   wrangler secret put WEBHOOK_ID_TRIGGER
   wrangler secret put WEBHOOK_ID_TELEGRAM
   ```

4. **Deploy:**
   ```bash
   npm run deploy
   ```

## 🌐 Deployment

This project is deployed with a separate frontend and backend.

- **Frontend URL:** [https://web-bus.pages.dev](https://web-bus.pages.dev)
- **Backend URL:** [https://webbus-worker.quinton0121.workers.dev](https://webbus-worker.quinton0121.workers.dev)

## 🔧 Development

```bash
npm run dev    # Start development server
npm run test   # Run tests
```

## 📁 Project Structure

- `src/index.ts` - Main Cloudflare Worker code
- `bus_request_secure.json` - Secure n8n workflow configuration
- `index.html` - Configuration UI
- `webbus-worker/` - Cloudflare Worker project

## 🔒 Security

This project uses environment variables and Cloudflare Workers secrets to protect sensitive data. See `SECURITY_SETUP.md` for detailed setup instructions.

## 📝 License

Private project
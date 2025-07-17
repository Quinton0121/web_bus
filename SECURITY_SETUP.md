# Security Setup Instructions

## 🔒 Sensitive Data Removed

The following sensitive data has been identified and needs to be handled securely:

### Original Sensitive Values (DO NOT COMMIT):
- **Telegram Credential ID**: `TV7POkZmwZoORrNO`
- **Telegram Chat ID**: `-4841382045`
- **Webhook ID (Trigger)**: `58f3302f-88d9-4f98-9b90-6a0c76521bfa`
- **Webhook ID (Telegram)**: `06f4ead6-e46c-4f6a-b57e-c9e4875dfec4`
- **KV Namespace ID**: `2d476edb864c47a8b7a2e1eaaef52c60`

## 🛠️ Setup Instructions

### 1. For Cloudflare Workers:
```bash
# Set secrets for your worker
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put WEBHOOK_ID_TRIGGER
wrangler secret put WEBHOOK_ID_TELEGRAM
```

### 2. For Local Development:
1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Fill in your actual values in `.env`:
   ```
   TELEGRAM_BOT_TOKEN=your_actual_bot_token
   TELEGRAM_CHAT_ID=-4841382045
   KV_NAMESPACE_ID=2d476edb864c47a8b7a2e1eaaef52c60
   WEBHOOK_ID_TRIGGER=58f3302f-88d9-4f98-9b90-6a0c76521bfa
   WEBHOOK_ID_TELEGRAM=06f4ead6-e46c-4f6a-b57e-c9e4875dfec4
   ```

### 3. Update Your Code:
- Use `bus_request_secure.json` instead of `bus_request.json`
- Update your application to read from environment variables
- The KV namespace ID in `wrangler.toml` can stay (it's bound to your account)

## ✅ Safe to Commit:
- `.gitignore`
- `.env.example`
- `bus_request_secure.json`
- `SECURITY_SETUP.md`
- Updated `wrangler.toml`

## ❌ DO NOT COMMIT:
- `bus_request.json` (contains sensitive data)
- `.env` (will contain actual secrets)
- Any files with hardcoded credentials

## 🔄 Migration Steps:
1. Move sensitive data to environment variables
2. Update your n8n workflow to use the secure version
3. Test with environment variables
4. Delete the original `bus_request.json`
5. Commit the secure files
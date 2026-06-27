# Interview App — Backend

Node.js + Express backend for the AI Mock Interview app.
Handles session creation, question generation, transcription, scoring, and email delivery.

---

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /health | Health check |
| POST | /api/session/create | Create new session + save CV/JD |
| GET | /api/session/:id/status | Poll session status |
| POST | /api/questions/generate | Trigger Gemini question generation |
| GET | /api/questions/:session_id | Fetch questions for interview room |
| POST | /api/transcribe | Transcribe audio via Groq Whisper |
| POST | /api/score | Trigger scoring + report generation |
| GET | /api/score/:session_id | Fetch completed report |

---

## Local Development

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
```

Fill in your `.env` file with real values:
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from supabase.com → your project → Settings → API
- `GEMINI_API_KEY` from aistudio.google.com
- `GROQ_API_KEY` from console.groq.com
- `RESEND_API_KEY` from resend.com
- `FROM_EMAIL` — your verified sending domain on Resend
- `FRONTEND_URL` — your Lovable app URL

### 3. Run locally
```bash
npm run dev
```

Test the health check:
```bash
curl http://localhost:3000/health
```

---

## Deploy To Railway

### Option A — Deploy via GitHub (recommended)

1. Push this folder to a GitHub repository
```bash
git init
git add .
git commit -m "Initial backend"
git remote add origin https://github.com/yourusername/interview-backend.git
git push -u origin main
```

2. Go to railway.app → New Project → Deploy from GitHub
3. Select your repository
4. Railway auto-detects Node.js and deploys

### Option B — Deploy via Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Add Environment Variables on Railway

Go to your Railway project → Variables → Add all values from .env.example

Railway automatically sets PORT — do not override it.

---

## Update Your Lovable App

Once deployed, Railway gives you a URL like:
`https://interview-backend-production.up.railway.app`

Replace all Make.com webhook URLs in your Lovable app with these:

```
Session creation:
POST https://your-railway-url.up.railway.app/api/session/create

Status polling (replace Make.com webhook):
GET https://your-railway-url.up.railway.app/api/session/SESSION_ID/status

Question generation trigger:
POST https://your-railway-url.up.railway.app/api/questions/generate

Fetch questions for interview room:
GET https://your-railway-url.up.railway.app/api/questions/SESSION_ID

Transcription:
POST https://your-railway-url.up.railway.app/api/transcribe

Scoring trigger:
POST https://your-railway-url.up.railway.app/api/score

Fetch report:
GET https://your-railway-url.up.railway.app/api/score/SESSION_ID
```

---


```

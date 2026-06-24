// ─── SENTRY INITIALIZATION (MUST BE FIRST) ───────────────────
const Sentry = require('@sentry/node')
 
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1
  })
  console.log('Sentry error tracking initialized.')
} else {
  console.log('Sentry warning: SENTRY_DSN environment variable not found.')
}
// ─────────────────────────────────────────────────────────────
 
require('dotenv').config()
 
const express = require('express')
 
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const cron = require('node-cron')
 
const app = express()
app.set('trust proxy', 1)
const PORT = process.env.PORT || 3000

/ ─── CORS — must be before all routes ─────────────────────
const ALLOWED_ORIGINS = [
  'https://rolematch.co',
  'https://www.rolematch.co',
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5173',
].filter(Boolean)
 
const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true)
 
    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true)
    } else {
      console.warn(`CORS blocked origin: ${origin}`)
      callback(new Error(`Origin ${origin} not allowed by CORS`))
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'x-api-key'],
  credentials: true
}
 
app.use(cors(corsOptions))
app.options('*', cors(corsOptions))

const authenticate = require('./middleware/auth')

// Apply after CORS, before all routes
app.use(authenticate)


// ─── Rate Limiting ────────────────────────────────────────

// Global — all routes
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
})

// Questions — generate + next (called many times per single interview)
// 5 main questions + up to 5 follow-ups + 1 generate call = ~11 calls
// minimum per session. Set generously per IP per hour.
const questionsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Interview request limit reached. Please try again in an hour.' }
})

// Scoring — called once per completed session
const scoreLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Scoring request limit reached. Please try again in an hour.' }
})

// Session creation — stops bulk abuse
const sessionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Session limit reached. Please try again in an hour.' }
})

app.use(globalLimiter)

// ─── Body Parsing ─────────────────────────────────────────
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// ─── Health Check ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  })
})

// ─── Routes ───────────────────────────────────────────────
const sessionRoutes = require('./routes/session')
const questionRoutes = require('./routes/questions')
const transcribeRoutes = require('./routes/transcribe')
const scoreRoutes = require('./routes/score')
const speakRoutes = require('./routes/speak')
const paymentRoutes = require('./routes/payment')
const adminRoutes = require('./routes/admin')
const feedbackRoutes = require('./routes/feedback')
const talkToUsRoutes = require('./routes/talkToUs')

app.use('/api/session', sessionLimiter, sessionRoutes)
app.use('/api/questions', questionsLimiter, questionRoutes)
app.use('/api/transcribe', transcribeRoutes)
app.use('/api/score', scoreLimiter, scoreRoutes)
app.use('/api/speak', speakRoutes)
app.use('/api/payment', paymentRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/feedback', feedbackRoutes)
app.use('/api/talk-to-us', talkToUsRoutes)

// ─── Data Privacy Cleanup Cron — runs every hour ──────────
cron.schedule('0 * * * *', async () => {
  const supabase = require('./lib/supabase')

  try {
    console.log('Running system data privacy cleanup job...')

    const cutoff = new Date(
      Date.now() - 24 * 60 * 60 * 1000
    ).toISOString()

    const ninetyDays = new Date(
      Date.now() - 90 * 24 * 60 * 60 * 1000
    ).toISOString()

    // ─── 1. CV cleanup ────────────────────────────────────
    const { data: oldDocs, error: docFetchError } = await supabase
      .from('documents')
      .select('cv_url')
      .lt('created_at', cutoff)
      .not('cv_url', 'is', null)

    if (docFetchError) throw docFetchError

    if (oldDocs?.length > 0) {
      const paths = oldDocs.map(d => d.cv_url).filter(Boolean)
      if (paths.length > 0) {
        await supabase.storage.from('cvs').remove(paths)
        console.log(`Cleaned up ${paths.length} CV files`)
      }
    }

    await supabase
      .from('documents')
      .update({ cv_url: null, cv_extracted_text: null })
      .lt('created_at', cutoff)

    // ─── 2. Audio cleanup ─────────────────────────────────
    const { data: oldAnswers, error: answerFetchError } = await supabase
      .from('answers')
      .select('audio_url')
      .lt('created_at', cutoff)
      .not('audio_url', 'is', null)

    if (answerFetchError) throw answerFetchError

    if (oldAnswers?.length > 0) {
      const audioPaths = oldAnswers.map(a => a.audio_url).filter(Boolean)
      if (audioPaths.length > 0) {
        await supabase.storage.from('audio-answers').remove(audioPaths)
        console.log(`Cleaned up ${audioPaths.length} voice recordings`)
      }
    }

    await supabase
      .from('answers')
      .update({ audio_url: null })
      .lt('created_at', cutoff)

    // ─── 3. 90-day session purge ──────────────────────────
    const { error: purgeError } = await supabase
      .from('sessions')
      .delete()
      .lt('created_at', ninetyDays)

    if (purgeError) throw purgeError

    console.log('Data privacy cleanup completed successfully.')

  } catch (err) {
    console.error('Data privacy cleanup error:', err)
    if (process.env.SENTRY_DSN) Sentry.captureException(err)
  }
})

// ─── 404 Handler ──────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` })
})

// ─── Global Error Handler ─────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)

  if (process.env.SENTRY_DSN) Sentry.captureException(err)

  res.status(500).json({ error: 'Internal server error' })
})

// ─── Start Server ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Interview backend running on port ${PORT}`)
  console.log(`Health check: http://localhost:${PORT}/health`)
})

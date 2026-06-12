require('dotenv').config()

const express = require('express')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const cron = require('node-cron')

const sessionRoutes = require('./routes/session')
const questionRoutes = require('./routes/questions')
const transcribeRoutes = require('./routes/transcribe')
const scoreRoutes = require('./routes/score')
const speakRoutes = require('./routes/speak')
const paymentRoutes = require('./routes/payment')

const app = express()
const PORT = process.env.PORT || 3000

// ─── CORS — must be before all routes ─────────────────────
const corsOptions = {
  origin(origin, callback) {
    if (
      !origin ||
      origin.endsWith('.lovable.app') ||
      origin.startsWith('http://localhost')
    ) {
      callback(null, true)
    } else {
      console.log('Blocked origin:', origin)
      callback(null, true) // temporarily allow all during development
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin'],
  credentials: true
}

app.use(cors(corsOptions))
app.options('*', cors(corsOptions))

// ─── Rate Limiting ────────────────────────────────────────

// Global — all routes
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
})

// AI routes — question generation and scoring
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI request limit reached. Please try again in an hour.' }
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
app.use('/api/session', sessionLimiter, sessionRoutes)
app.use('/api/questions', aiLimiter, questionRoutes)
app.use('/api/transcribe', transcribeRoutes)
app.use('/api/score', aiLimiter, scoreRoutes)
app.use('/api/speak', speakRoutes)
app.use('/api/payment', paymentRoutes)

// ─── CV Cleanup Cron — runs every hour ────────────────────
// ─── Data Privacy Cleanup Cron — runs every hour ────────────────────
cron.schedule('0 * * * *', async () => {
  try {
    console.log('Running system data privacy cleanup job...')
    const supabase = require('./lib/supabase')
    
    // 24 hours ago cutoff time
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    // ─── 1. CLEAN UP CV & EXTRACTED TEXT ─────────────────────
    const { data: oldDocs, error: docFetchError } = await supabase
      .from('documents')
      .select('cv_url')
      .lt('created_at', cutoff)
      .not('cv_url', 'is', null)

    if (docFetchError) throw docFetchError

    if (oldDocs && oldDocs.length > 0) {
      const paths = oldDocs.map(d => d.cv_url).filter(Boolean)
      if (paths.length > 0) {
        await supabase.storage.from('cvs').remove(paths)
        console.log(`Cleaned up ${paths.length} CV files from storage.`)
      }
    }

    // Scrub URLs and permanent extraction fields from the table
    const { error: docUpdateError } = await supabase
      .from('documents')
      .update({ cv_url: null, cv_extracted_text: null })
      .lt('created_at', cutoff)

    if (docUpdateError) throw docUpdateError


    // ─── 2. CLEAN UP VOICE RECORDINGS (audio-answers) ────────
    const { data: oldAnswers, error: answerFetchError } = await supabase
      .from('answers')
      .select('audio_url')
      .lt('created_at', cutoff)
      .not('audio_url', 'is', null)

    if (answerFetchError) throw answerFetchError

    if (oldAnswers && oldAnswers.length > 0) {
      const audioPaths = oldAnswers.map(a => a.audio_url).filter(Boolean)
      if (audioPaths.length > 0) {
        await supabase.storage.from('audio-answers').remove(audioPaths)
        console.log(`Cleaned up ${audioPaths.length} voice recordings from storage.`)
      }
    }

    // Set audio URLs to null so broken file paths aren't left behind
    const { error: answerUpdateError } = await supabase
      .from('answers')
      .update({ audio_url: null })
      .lt('created_at', cutoff)

    if (answerUpdateError) throw answerUpdateError

    console.log('System data privacy cleanup completed successfully.')

  } catch (err) {
    console.error('Data privacy cleanup error:', err)
  }

  const ninetyDays = new Date(
 Date.now() - 90 * 24 * 60 * 60 * 1000 ).toISOString()

await supabase
  .from('sessions')
  .delete()
  .lt('created_at', ninetyDays)
})

// ─── 404 Handler ──────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` })
})

// ─── Global Error Handler ─────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

// ─── Start Server ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Interview backend running on port ${PORT}`)
  console.log(`Health check: http://localhost:${PORT}/health`)
})

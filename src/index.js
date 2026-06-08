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
cron.schedule('0 * * * *', async () => {
  try {
    console.log('Running CV cleanup job...')
    const supabase = require('./lib/supabase')
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    const { data: oldDocs, error } = await supabase
      .from('documents')
      .select('cv_url')
      .lt('created_at', cutoff)
      .not('cv_url', 'is', null)

    if (error) throw error

    if (oldDocs && oldDocs.length > 0) {
      const paths = oldDocs.map(d => d.cv_url).filter(Boolean)

      await supabase.storage.from('cvs').remove(paths)

      await supabase
        .from('documents')
        .update({ cv_url: null, cv_extracted_text: null })
        .lt('created_at', cutoff)

      console.log(`Cleaned up ${paths.length} CV files`)
    } else {
      console.log('No CV files to clean up')
    }

  } catch (err) {
    console.error('CV cleanup error:', err)
  }
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

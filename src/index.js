require('dotenv').config()

const express = require('express')
const cors = require('cors')

const sessionRoutes = require('./routes/session')
const questionRoutes = require('./routes/questions')
const transcribeRoutes = require('./routes/transcribe')
const scoreRoutes = require('./routes/score')

const app = express()
const PORT = process.env.PORT || 3000

const cron = require('node-cron')

// Runs every hour — deletes CV files older than 24 hours
cron.schedule('0 * * * *', async () => {
  try {
    console.log('Running CV cleanup job...')

    const supabase = require('./lib/supabase')
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    // Find old documents
    const { data: oldDocs, error } = await supabase
      .from('documents')
      .select('cv_url')
      .lt('created_at', cutoff)
      .not('cv_url', 'is', null)

    if (error) throw error

    if (oldDocs && oldDocs.length > 0) {
      const paths = oldDocs.map(d => d.cv_url).filter(Boolean)

      // Delete from storage
      await supabase.storage
        .from('cvs')
        .remove(paths)

      // Clear cv_url from documents table
      await supabase
        .from('documents')
        .update({ cv_url: null, cv_extracted_text: null })
        .lt('created_at', cutoff)

      console.log(`Cleaned up ${paths.length} CV files`)
    }

  } catch (err) {
    console.error('CV cleanup error:', err)
  }
})

// ─── CORS — must be before all routes ─────────────────────
const corsOptions = {
  origin(origin, callback) {
    // Allow all lovable.app previews, localhost, and no-origin requests
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
app.options('*', cors(corsOptions))  // handle all preflight requests

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
app.use('/api/session', sessionRoutes)
app.use('/api/questions', questionRoutes)
app.use('/api/transcribe', transcribeRoutes)
app.use('/api/score', scoreRoutes)

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


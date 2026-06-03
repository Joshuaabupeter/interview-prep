require('dotenv').config()

const express = require('express')
const cors = require('cors')

const sessionRoutes = require('./routes/session')
const questionRoutes = require('./routes/questions')
const transcribeRoutes = require('./routes/transcribe')
const scoreRoutes = require('./routes/score')

const app = express()
const PORT = process.env.PORT || 3000

// ─── Middleware ───────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))

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

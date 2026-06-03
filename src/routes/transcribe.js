const express = require('express')
const router = express.Router()
const multer = require('multer')
const fetch = require('node-fetch')
const FormData = require('form-data')
const supabase = require('../lib/supabase')

// Store audio in memory temporarily — no disk writes needed
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max
})

// POST /api/transcribe
// Receives audio blob from browser, sends to Groq Whisper, saves transcript
router.post('/', upload.single('audio'), async (req, res) => {
  try {
    const { session_id, question_id } = req.body

    if (!req.file) {
      return res.status(400).json({ error: 'No audio file received' })
    }

    if (!session_id || !question_id) {
      return res.status(400).json({ error: 'session_id and question_id are required' })
    }

    // Send audio to Groq Whisper
    const formData = new FormData()
    formData.append('file', req.file.buffer, {
      filename: 'audio.webm',
      contentType: req.file.mimetype || 'audio/webm'
    })
    formData.append('model', 'whisper-large-v3')
    formData.append('response_format', 'text')
    formData.append('language', 'en')

    const groqResponse = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          ...formData.getHeaders()
        },
        body: formData
      }
    )

    if (!groqResponse.ok) {
      const errText = await groqResponse.text()
      throw new Error(`Groq transcription failed: ${errText}`)
    }

    const transcript = await groqResponse.text()

    if (!transcript || transcript.trim().length === 0) {
      return res.status(400).json({ error: 'No speech detected in recording' })
    }

    // Save transcript to answers table
    const { error: upsertError } = await supabase
      .from('answers')
      .upsert({
        session_id,
        question_id,
        transcript: transcript.trim()
      }, {
        onConflict: 'session_id, question_id'
      })

    if (upsertError) throw upsertError

    return res.json({
      transcript: transcript.trim(),
      message: 'Transcription saved successfully'
    })

  } catch (err) {
    console.error('Transcription error:', err)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router

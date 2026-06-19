const express = require('express')
const router = express.Router()
const multer = require('multer')
const fetch = require('node-fetch')
const FormData = require('form-data')
const supabase = require('../lib/supabase')

// Store audio in memory — no disk writes needed
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max
})

// POST /api/transcribe
router.post('/', upload.single('audio'), async (req, res) => {
  try {
    const { session_id, question_id, duration_seconds } = req.body

    if (!req.file) {
      return res.status(400).json({ error: 'No audio file received' })
    }

    if (!session_id || !question_id) {
      return res.status(400).json({ error: 'session_id and question_id are required' })
    }

    let transcript = ''

    // ─── Try Deepgram first ───────────────────────────────
    if (process.env.DEEPGRAM_API_KEY) {
      try {
        const deepgramResponse = await fetch(
          'https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true',
          {
            method: 'POST',
            headers: {
              'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
              'Content-Type': req.file.mimetype || 'audio/webm'
            },
            body: req.file.buffer
          }
        )

        if (deepgramResponse.ok) {
          const deepgramData = await deepgramResponse.json()
          transcript = deepgramData?.results?.channels?.[0]
            ?.alternatives?.[0]?.transcript || ''
          console.log('Transcribed via Deepgram')
        } else {
          const errText = await deepgramResponse.text()
          console.error('Deepgram error:', errText)
          throw new Error('Deepgram transcription failed')
        }
      } catch (deepgramErr) {
        console.error('Deepgram failed, trying OpenAI fallback:', deepgramErr.message)
        transcript = '' // will fall through to OpenAI
      }
    }

    // ─── Fallback to OpenAI Whisper ───────────────────────
    if (!transcript && process.env.OPENAI_API_KEY) {
      try {
        const formData = new FormData()
        formData.append('file', req.file.buffer, {
          filename: 'audio.webm',
          contentType: req.file.mimetype || 'audio/webm'
        })
        formData.append('model', 'whisper-1')
        formData.append('language', 'en')
        formData.append('response_format', 'text')

        const openaiResponse = await fetch(
          'https://api.openai.com/v1/audio/transcriptions',
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
              ...formData.getHeaders()
            },
            body: formData
          }
        )

        if (openaiResponse.ok) {
          transcript = await openaiResponse.text()
          console.log('Transcribed via OpenAI Whisper fallback')
        } else {
          const errText = await openaiResponse.text()
          throw new Error(`OpenAI transcription failed: ${errText}`)
        }
      } catch (openaiErr) {
        console.error('OpenAI fallback also failed:', openaiErr.message)
        throw new Error('All transcription services failed')
      }
    }

    // ─── Last resort — Groq ───────────────────────────────
    if (!transcript && process.env.GROQ_API_KEY) {
      try {
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

        if (groqResponse.ok) {
          transcript = await groqResponse.text()
          console.log('Transcribed via Groq fallback')
        } else {
          const errText = await groqResponse.text()
          throw new Error(`Groq transcription failed: ${errText}`)
        }
      } catch (groqErr) {
        console.error('Groq fallback failed:', groqErr.message)
        throw new Error('All transcription services exhausted')
      }
    }

    if (!transcript || transcript.trim().length === 0) {
      return res.status(400).json({ error: 'No speech detected in recording' })
    }

    // Save transcript to Supabase
    const { error: upsertError } = await supabase
      .from('answers')
      .upsert({
        session_id,
        question_id,
        transcript: transcript.trim(),
        duration_seconds: duration_seconds
          ? Math.round(parseFloat(duration_seconds))
          : null
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

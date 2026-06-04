const express = require('express')
const router = express.Router()
const fetch = require('node-fetch') // Matches the fetch setup in your transcribe.js

// POST /api/speak
router.post('/', async (req, res) => {
  try {
    const { text } = req.body

    if (!text) {
      return res.status(400).json({ error: 'Text parameter is required' })
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        })
      }
    )

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`ElevenLabs API failed: ${errText}`)
    }

    res.setHeader('Content-Type', 'audio/mpeg')
    response.body.pipe(res)

  } catch (err) {
    console.error('TTS execution error:', err)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router

const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')

// POST /api/talk-to-us
// Always-available feedback channel — no session required
// Catches users who hit friction before completing anything
router.post('/', express.json(), async (req, res) => {
  try {
    const { message, email, session_id, page_url } = req.body

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' })
    }

    if (message.trim().length > 2000) {
      return res.status(400).json({ error: 'Message is too long' })
    }

    // session_id is optional — only validate if provided
    let validSessionId = null
    if (session_id) {
      const { data: session } = await supabase
        .from('sessions')
        .select('id')
        .eq('id', session_id)
        .maybeSingle()

      if (session) validSessionId = session_id
    }

    const { error: insertError } = await supabase
      .from('general_feedback')
      .insert({
        session_id: validSessionId,
        email: email ? email.trim().toLowerCase().substring(0, 255) : null,
        page_url: page_url ? page_url.substring(0, 500) : null,
        message: message.trim()
      })

    if (insertError) throw insertError

    return res.status(201).json({
      message: 'Thank you. We have received your message.'
    })

  } catch (err) {
    console.error('Talk to us submit error:', err)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router

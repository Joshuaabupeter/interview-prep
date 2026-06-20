const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')

// POST /api/feedback
// Submitted from the results page after a session completes
router.post('/', express.json(), async (req, res) => {
  try {
    const { session_id, rating, comment } = req.body

    if (!session_id) {
      return res.status(400).json({ error: 'session_id is required' })
    }

    const ratingNum = parseInt(rating)
    if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ error: 'rating must be between 1 and 5' })
    }

    // Confirm session actually exists — prevents junk submissions
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('id')
      .eq('id', session_id)
      .single()

    if (sessionError || !session) {
      return res.status(404).json({ error: 'Session not found' })
    }

    // Prevent duplicate feedback on the same session
    const { data: existing } = await supabase
      .from('feedback')
      .select('id')
      .eq('session_id', session_id)
      .maybeSingle()

    if (existing) {
      // Update instead of creating a duplicate
      const { error: updateError } = await supabase
        .from('feedback')
        .update({
          rating: ratingNum,
          comment: comment ? comment.trim().substring(0, 1000) : null
        })
        .eq('session_id', session_id)

      if (updateError) throw updateError

      return res.json({ message: 'Feedback updated. Thank you.' })
    }

    const { error: insertError } = await supabase
      .from('feedback')
      .insert({
        session_id,
        rating: ratingNum,
        comment: comment ? comment.trim().substring(0, 1000) : null
      })

    if (insertError) throw insertError

    return res.status(201).json({ message: 'Thank you for your feedback.' })

  } catch (err) {
    console.error('Feedback submit error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// GET /api/feedback/:session_id
// Check if feedback was already submitted for this session
// Used by the results page to avoid showing the prompt twice
router.get('/:session_id', async (req, res) => {
  try {
    const { session_id } = req.params

    const { data, error } = await supabase
      .from('feedback')
      .select('rating, comment')
      .eq('session_id', session_id)
      .maybeSingle()

    if (error) throw error

    return res.json({ feedback: data || null })

  } catch (err) {
    console.error('Fetch feedback error:', err)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router

const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')

// POST /api/session/create
// Called by Lovable upload screen on final submit
router.post('/create', async (req, res) => {
  try {
    const { email, jd_text, cv_extracted_text, cv_url, payment_ref } = req.body

    // ─── Input validation ────────────────────────────────
    if (!email || !jd_text || !cv_extracted_text) {
      return res.status(400).json({
        error: 'Missing required fields: email, jd_text, cv_extracted_text'
      })
    }

    if (jd_text.length < 500) {
      return res.status(400).json({
        error: 'Job description too short. Please include the full responsibilities and requirements.'
      })
    }

    if (cv_extracted_text.length < 100) {
      return res.status(400).json({
        error: 'CV content too short. Please upload a complete CV.'
      })
    }

    // ─── Payment verification ────────────────────────────
    // Only enforce if payment_ref is provided
    if (payment_ref) {
      const { data: payment, error: paymentError } = await supabase
        .from('payments')
        .select('credits_remaining')
        .eq('reference', payment_ref)
        .single()

      // Consolidated check for missing reference, db errors, or insufficient credits
      if (paymentError || !payment || payment.credits_remaining <= 0) {
        return res.status(403).json({ 
          error: 'No credits remaining or invalid payment reference. Please purchase a new session.',
          redirect: '/pricing'
        })
      }

      // Deduct one credit
      const { error: deductError } = await supabase
        .from('payments')
        .update({ credits_remaining: payment.credits_remaining - 1 })
        .eq('reference', payment_ref)

      if (deductError) throw deductError
    }

    // ─── Create session row ──────────────────────────────
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .insert({
        email,
        status: 'pending'
      })
      .select()
      .single()

    if (sessionError) throw sessionError

    // ─── Create document row ─────────────────────────────
    const { error: docError } = await supabase
      .from('documents')
      .insert({
        session_id: session.id,
        cv_url: cv_url || null,
        jd_text,
        cv_extracted_text
      })

    if (docError) throw docError

    return res.status(201).json({
      session_id: session.id,
      message: 'Session created successfully'
    })

  } catch (err) {
    console.error('Session create error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// GET /api/session/:id/status
// Polled by /waiting and /processing screens
router.get('/:id/status', async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('sessions')
      .select('id, status')
      .eq('id', id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Session not found' })

    return res.json({ status: data.status })

  } catch (err) {
    console.error('Session status error:', err)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router

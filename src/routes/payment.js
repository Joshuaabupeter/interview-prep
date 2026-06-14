const express = require('express')
const router = express.Router()
const fetch = require('node-fetch')
const supabase = require('../lib/supabase')
const crypto = require('crypto')
const { Resend } = require('resend') // <-- ADD THIS LINE

const resend = new Resend(process.env.RESEND_API_KEY) // <-- ADD THIS LINE

// POST /api/payment/verify
// Called after Paystack payment completes
// Verifies payment is real before allowing session creation
router.post('/verify', async (req, res) => {
  try {
    const { reference, plan } = req.body

    if (!reference) {
      return res.status(400).json({ error: 'Payment reference is required' })
    }

    // ─── STEP 1: ARREST JUNK FORMATS EARLY ────────────────────────
    // Validates standard alphanumeric Paystack characters before hitting APIs
    const isValidRef = /^[a-zA-Z0-9_\-]+$/.test(reference)
    if (!isValidRef || reference.length < 5) {
      return res.status(400).json({ 
        error: 'Invalid payment reference format.' 
      })
    }

    // Verify with Paystack server-side
    const paystackResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    )

    const paystackData = await paystackResponse.json()

    if (!paystackData.status) {
      return res.status(400).json({ error: 'Could not verify payment' })
    }

    const transaction = paystackData.data

    // Confirm transaction was successful
    if (transaction.status !== 'success') {
      return res.status(400).json({ 
        error: `Payment not successful. Status: ${transaction.status}` 
      })
    }

    // Confirm correct amount was paid
    const expectedAmounts = {
      session: 100000,  // ₦1,000 in kobo (Paystack uses kobo)
      monthly: 2500000  // ₦25,000 in kobo
    }

    const expectedAmount = expectedAmounts[plan] || expectedAmounts.session

    if (transaction.amount < expectedAmount) {
      return res.status(400).json({ 
        error: 'Incorrect payment amount' 
      })
    }

    // Determine session credits based on plan
    const credits = plan === 'monthly' ? 50 : 1

    // ─── PINPOINT FOR INSERTION ─────────────────────────────────
    // Calculate the expiration date right here:
    const expirationDate = plan === 'monthly' 
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : null

   // Store verified payment in Supabase
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .insert({
        reference: transaction.reference,
        email: transaction.customer.email,
        amount: transaction.amount,
        plan: plan || 'session',
        credits_remaining: credits,
        status: 'success',
        expires_at: expirationDate // <-- ADD THIS LINE HERE
      })
      .select()
      .single()

    if (paymentError) {
      // If duplicate reference ignore — already verified
      if (paymentError.code === '23505') {
        return res.json({ 
          verified: true, 
          reference: transaction.reference,
          credits,
          message: 'Payment already verified' 
        })
      }
      throw paymentError
    }

    return res.json({
      verified: true,
      reference: transaction.reference,
      email: transaction.customer.email,
      plan: plan || 'session',
      credits,
      message: 'Payment verified successfully'
    })

  } catch (err) {
    console.error('Payment verify error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// POST /api/payment/consume-credit
// Called when user starts a session — deducts one credit
router.post('/consume-credit', async (req, res) => {
  try {
    const { reference } = req.body

    if (!reference) {
      return res.status(400).json({ error: 'Payment reference is required' })
    }
    // Fetch payment record
    const { data: payment, error: fetchError } = await supabase
      .from('payments')
      .select('credits_remaining, status, expires_at')
      .eq('reference', reference)
      .single()

    if (fetchError || !payment) {
      return res.status(404).json({ error: 'Payment not found' })
    }

    // ─── PINPOINT FOR INSERTION: EXPIRATION CHECK ─────────────────
    if (payment.expires_at && new Date(payment.expires_at) < new Date()) {
      return res.status(403).json({ 
        error: 'Your monthly plan has expired.',
        redirect: '/pricing'
      })
    }
    // ─────────────────────────────────────────────────────────────

    if (payment.credits_remaining <= 0) {
      return res.status(403).json({ 
        error: 'No credits remaining. Please purchase a new session.' 
      })
    }

    // Deduct one credit
    const { error: updateError } = await supabase
      .from('payments')
      .update({ 
        credits_remaining: payment.credits_remaining - 1 
      })
      .eq('reference', reference)

    if (updateError) throw updateError

    return res.json({
      success: true,
      credits_remaining: payment.credits_remaining - 1
    })

  } catch (err) {
    console.error('Consume credit error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// GET /api/payment/credits/:reference
// Check how many credits remain on a payment
router.get('/credits/:reference', async (req, res) => {
  try {
    const { reference } = req.params

    const { data, error } = await supabase
      .from('payments')
      .select('credits_remaining, plan, email')
      .eq('reference', reference)
      .single()

    if (error || !data) {
      return res.status(404).json({ error: 'Payment not found' })
    }

    return res.json({
      credits_remaining: data.credits_remaining,
      plan: data.plan,
      email: data.email
    })

  } catch (err) {
    console.error('Credits check error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// GET /api/payment/recover?email=xxx
// Lets users recover a paid session they lost
router.get('/recover', async (req, res) => {
  try {
    const { email } = req.query

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    // Find most recent payment with credits remaining
    const { data, error } = await supabase
      .from('payments')
      .select('reference, credits_remaining, plan, created_at')
      .eq('email', email.toLowerCase().trim())
      .gt('credits_remaining', 0)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (error || !data) {
      return res.status(404).json({
        error: 'No active sessions found for this email.'
      })
    }

    return res.json({
      found: true,
      reference: data.reference,
      credits_remaining: data.credits_remaining,
      plan: data.plan
    })

  } catch (err) {
    console.error('Payment recovery error:', err)
    return res.status(500).json({ error: err.message })
  }
})


// POST /api/payment/webhook
// Securely captures backend transaction events directly out of Paystack servers
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // 1. Validate request signature using the uncorrupted raw request body Buffer
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET)
      .update(req.body) // Passed directly as raw Buffer
      .digest('hex')

    if (hash !== req.headers['x-paystack-signature']) {
      console.error('Unauthorized Webhook Sign-Check Attempt: Signature mismatch.')
      return res.status(401).json({ error: 'Invalid signature' })
    }

    // 2. Safely parse the verified Buffer into JSON data
    const event = JSON.parse(req.body.toString())
    
    // Only process charge.success events
    if (event.event === 'charge.success') {
      const transaction = event.data
      const reference = transaction.reference
      const customerEmail = transaction.customer.email
      
      // Extract plan selection from custom fields array metadata if available
      const plan = transaction.metadata?.custom_fields?.find(f => f.variable_name === 'plan')?.value || 'session'
      const credits = plan === 'monthly' ? 50 : 1
      const expirationDate = plan === 'monthly' 
        ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        : null

      console.log(`Verified webhook payment incoming: ${reference}. Granting ${credits} credits.`)

      // Check if payment already exists via reference to avoid duplication
      const { data: existingPayment } = await supabase
        .from('payments')
        .select('id')
        .eq('reference', reference)
        .maybeSingle()

      if (!existingPayment) {
        await supabase
          .from('payments')
          .insert({
            reference: reference,
            email: customerEmail.toLowerCase().trim(),
            amount: transaction.amount,
            plan: plan,
            credits_remaining: credits,
            status: 'success',
            expires_at: expirationDate
          })
      }
    }

    // Always tell Paystack your server received the event successfully
    return res.status(200).json({ status: 'success' })

  } catch (err) {
    console.error('Webhook compilation processing error:', err)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router

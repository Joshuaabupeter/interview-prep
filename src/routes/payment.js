const express = require('express')
const router = express.Router()
const fetch = require('node-fetch')
const supabase = require('../lib/supabase')

// POST /api/payment/verify
// Called after Paystack payment completes
// Verifies payment is real before allowing session creation
router.post('/verify', async (req, res) => {
  try {
    const { reference, plan } = req.body

    if (!reference) {
      return res.status(400).json({ error: 'Payment reference is required' })
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
    const credits = plan === 'monthly' ? 999 : 1

    // Store verified payment in Supabase
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .insert({
        reference: transaction.reference,
        email: transaction.customer.email,
        amount: transaction.amount,
        plan: plan || 'session',
        credits_remaining: credits,
        status: 'success'
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
      .select('credits_remaining, status')
      .eq('reference', reference)
      .single()

    if (fetchError || !payment) {
      return res.status(404).json({ error: 'Payment not found' })
    }

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

module.exports = router

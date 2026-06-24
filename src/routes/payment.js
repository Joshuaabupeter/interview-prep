const express = require('express')
const router = express.Router()
const fetch = require('node-fetch')
const supabase = require('../lib/supabase')
const crypto = require('crypto')
const { Resend } = require('resend')


const derivePlanFromAmount = (amount) => {
  // Amount is in kobo (100 kobo = 1 Naira)
  if (amount >= 2500000) return { plan: 'monthly', credits: 50 }
  if (amount >= 100000) return { plan: 'session', credits: 1 }
  return null
}

const resend = new Resend(process.env.RESEND_API_KEY)


// POST /api/payment/verify
// express.json() inline — works regardless of global middleware order
router.post('/verify', express.json(), async (req, res) => {
  try {
    // 1. Only trust the reference from the client
    const { reference } = req.body

    if (!reference) {
      return res.status(400).json({ error: 'Payment reference is required' })
    }

    // 2. Verify with Paystack (keep your existing Paystack fetch logic here)
    const paystackResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    )
    const paystackData = await paystackResponse.json()
    
    if (!paystackData.status) return res.status(400).json({ error: 'Could not verify payment' })
    const transaction = paystackData.data
    if (transaction.status !== 'success') return res.status(400).json({ error: 'Payment not successful' })

    // 3. SECURE PLAN DERIVATION: Derive plan from the actual verified amount
    const derived = derivePlanFromAmount(transaction.amount)
if (!derived) {
  return res.status(400).json({ error: 'Payment amount does not match any valid plan.' })
}
const { plan, credits } = derived
const expirationDate = plan === 'monthly'
  ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  : null

    // ... Proceed to your existing Supabase insert logic below this ...
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .insert({
        reference: transaction.reference,
        email: transaction.customer.email,
        amount: transaction.amount,
        plan: plan || 'session',
        credits_remaining: credits,
        status: 'success',
        expires_at: expirationDate
      })
      .select()
      .single()

    if (paymentError) {
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

    // Send confirmation email
    try {
      await resend.emails.send({
        from: process.env.FROM_EMAIL,
        to: transaction.customer.email.toLowerCase().trim(),
        subject: 'Payment confirmed — RoleMatch',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #0a0a0f; color: #e8e8e0;">
            <p style="color: #c8a96e; font-weight: bold; text-transform: uppercase; font-size: 12px; letter-spacing: 0.05em;">Transaction Receipt</p>
            <h2 style="color: #fff;">Payment Confirmed!</h2>
            <p>Your payment of ₦${transaction.amount / 100} was successful. Your session credits are now live and ready.</p>
            <div style="margin: 32px 0;">
              <a href="${process.env.FRONTEND_URL}/upload"
                 style="background: #c8a96e; color: #0a0a0f; padding: 12px 24px; text-decoration: none; font-weight: bold; border-radius: 4px; display: inline-block;">
                Start Your Interview →
              </a>
            </div>
            <p style="color: rgba(255,255,255,0.4); font-size: 13px; line-height: 1.6;">
              If you close this window or lose this link, simply use the <strong>"Already paid?"</strong> recovery option on our pricing page to get back into your account instantly.
            </p>
          </div>
        `
      })
      console.log(`Receipt email sent to ${transaction.customer.email}`)
    } catch (emailErr) {
      console.error('Failed to send receipt email:', emailErr)
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
router.post('/consume-credit', express.json(), async (req, res) => {
  try {
    const { reference } = req.body

    if (!reference) {
      return res.status(400).json({ error: 'Payment reference is required' })
    }

    const { data: payment, error: fetchError } = await supabase
      .from('payments')
      .select('credits_remaining, status, expires_at')
      .eq('reference', reference)
      .single()

    if (fetchError || !payment) {
      return res.status(404).json({ error: 'Payment not found' })
    }

    if (payment.expires_at && new Date(payment.expires_at) < new Date()) {
      return res.status(403).json({
        error: 'Your monthly plan has expired.',
        redirect: '/pricing'
      })
    }

    if (payment.credits_remaining <= 0) {
      return res.status(403).json({
        error: 'No credits remaining. Please purchase a new session.'
      })
    }

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
router.get('/recover', async (req, res) => {
  try {
    const { email } = req.query

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

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
// express.raw() inline — keeps body as Buffer for signature verification
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    if (!process.env.PAYSTACK_WEBHOOK_SECRET) {
      console.error('PAYSTACK_WEBHOOK_SECRET not configured')
      return res.status(500).json({ error: 'Webhook secret not configured' })
    }

  const rawBody = Buffer.isBuffer(req.body) 
  ? req.body 
  : Buffer.from(JSON.stringify(req.body))

   const hash = crypto
  .createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET)
  .update(rawBody)
  .digest('hex')

    if (hash !== req.headers['x-paystack-signature']) {
      console.error('Webhook signature mismatch — unauthorized attempt')
      return res.status(401).json({ error: 'Invalid signature' })
    }

    const event = Buffer.isBuffer(req.body) 
  ? JSON.parse(req.body.toString()) 
  : req.body

    if (event.event === 'charge.success') {
      const transaction = event.data
      const reference = transaction.reference
      const customerEmail = transaction.customer.email
       const derived = derivePlanFromAmount(transaction.amount)
if (!derived) {
  console.log(`Webhook: unrecognized amount ${transaction.amount}, skipping`)
  return res.status(200).json({ status: 'success' })
}
const { plan, credits } = derived
const expirationDate = plan === 'monthly'
  ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  : null

      console.log(`Webhook received: ${reference} — granting ${credits} credits`)

      const { data: existingPayment } = await supabase
        .from('payments')
        .select('id')
        .eq('reference', reference)
        .maybeSingle()

      if (!existingPayment) {
        await supabase
          .from('payments')
          .insert({
            reference,
            email: customerEmail.toLowerCase().trim(),
            amount: transaction.amount,
            plan,
            credits_remaining: credits,
            status: 'success',
            expires_at: expirationDate
          })

        try {
          await resend.emails.send({
            from: process.env.FROM_EMAIL,
            to: customerEmail.toLowerCase().trim(),
            subject: 'Payment confirmed — RoleMatch',
            html: `
              <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #0a0a0f; color: #e8e8e0;">
                <p style="color: #c8a96e; font-weight: bold; text-transform: uppercase; font-size: 12px; letter-spacing: 0.05em;">Transaction Receipt</p>
                <h2 style="color: #fff;">Payment Confirmed!</h2>
                <p>Your payment of ₦${transaction.amount / 100} was successful. Your session credits are now live and ready.</p>
                <div style="margin: 32px 0;">
                  <a href="${process.env.FRONTEND_URL}/upload"
                     style="background: #c8a96e; color: #0a0a0f; padding: 12px 24px; text-decoration: none; font-weight: bold; border-radius: 4px; display: inline-block;">
                    Start Your Interview →
                  </a>
                </div>
                <p style="color: rgba(255,255,255,0.4); font-size: 13px; line-height: 1.6;">
                  If you close this window or lose this link, simply use the <strong>"Already paid?"</strong> recovery option on our pricing page to get back into your account instantly.
                </p>
              </div>
            `
          })
          console.log(`Receipt email sent via webhook to ${customerEmail}`)
        } catch (emailErr) {
          console.error('Webhook receipt email failed:', emailErr)
        }
      } else {
        console.log(`Webhook duplicate ignored: ${reference}`)
      }
    }

    return res.status(200).json({ status: 'success' })

  } catch (err) {
    console.error('Webhook error:', err)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router

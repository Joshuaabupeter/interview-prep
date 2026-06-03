const express = require('express')
const router = express.Router()
const { GoogleGenerativeAI } = require('@google/generative-ai')
const { Resend } = require('resend')
const supabase = require('../lib/supabase')

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const resend = new Resend(process.env.RESEND_API_KEY)

// POST /api/score
// Called after all 5 answers are recorded — triggers scoring + report
router.post('/', async (req, res) => {
  const { session_id } = req.body

  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required' })
  }

  // Respond immediately — scoring runs in background
  res.status(202).json({ message: 'Scoring started' })

  try {
    // Update status to scoring
    await supabase
      .from('sessions')
      .update({ status: 'scoring' })
      .eq('id', session_id)

    // Fetch questions
    const { data: questions, error: qError } = await supabase
      .from('questions')
      .select('id, prompt, position')
      .eq('session_id', session_id)
      .order('position', { ascending: true })

    if (qError || !questions.length) throw new Error('Could not fetch questions')

    // Fetch answers
    const { data: answers, error: aError } = await supabase
      .from('answers')
      .select('question_id, transcript')
      .eq('session_id', session_id)

    if (aError) throw new Error('Could not fetch answers')

    // Fetch JD
    const { data: doc, error: dError } = await supabase
      .from('documents')
      .select('jd_text')
      .eq('session_id', session_id)
      .single()

    if (dError || !doc) throw new Error('Could not fetch job description')

    // Fetch session email
    const { data: session, error: sError } = await supabase
      .from('sessions')
      .select('email, metadata')
      .eq('id', session_id)
      .single()

    if (sError) throw new Error('Could not fetch session')

    // Get email — handle both direct column and metadata
    const email = session.email || session.metadata?.email

    // Build Q+A block for Gemini
    const qaBlock = questions.map(q => {
      const answer = answers.find(a => a.question_id === q.id)
      const transcript = answer?.transcript || 'The candidate did not answer this question.'
      return `QUESTION ${q.position}: ${q.prompt}\nCANDIDATE ANSWER: ${transcript}`
    }).join('\n\n')

    // Call Gemini for scoring
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

    const prompt = `You are a senior executive recruiter scoring a mock job interview.

Score each answer honestly and critically. Do not be generous.
A score of 7 or above must be genuinely earned.
If the candidate did not answer, score it 0.

JOB DESCRIPTION:
${doc.jd_text}

INTERVIEW TRANSCRIPT:
${qaBlock}

Return ONLY valid JSON. No explanation. No markdown. No code blocks.
Exactly this structure:
{
  "overall_score": 74,
  "job_title": "The job title extracted from the JD",
  "executive_summary": "3-4 sentence overall assessment. No apostrophes.",
  "top_strengths": "What they demonstrated well. No apostrophes.",
  "critical_gaps": "Most important weaknesses exposed. No apostrophes.",
  "recommended_actions": "3 specific things to work on. No apostrophes.",
  "answers": [
    {
      "question_order": 1,
      "score": 7,
      "feedback_strong": "What was good. No apostrophes.",
      "feedback_weak": "What was missing. No apostrophes.",
      "ideal_answer_summary": "What a great answer would have covered. No apostrophes."
    }
  ]
}`

    const result = await model.generateContent(prompt)
    const text = result.response.text().trim()

    const cleaned = text
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim()

    const scored = JSON.parse(cleaned)

    // Write report to Supabase
    const { error: reportError } = await supabase
      .from('reports')
      .insert({
        session_id,
        overall_score: scored.overall_score,
        job_title: scored.job_title,
        summary: scored.executive_summary,
        scores: JSON.stringify({
          top_strengths: scored.top_strengths,
          critical_gaps: scored.critical_gaps,
          recommended_actions: scored.recommended_actions,
          answers: scored.answers
        }),
        email_sent: false
      })

    if (reportError) throw reportError

    // Update individual answer scores
    if (scored.answers && scored.answers.length) {
      for (const ans of scored.answers) {
        const question = questions.find(q => q.position === ans.question_order)
        if (!question) continue

        await supabase
          .from('answers')
          .update({
            score: ans.score,
            feedback_strong: ans.feedback_strong,
            feedback_weak: ans.feedback_weak,
            ideal_answer_summary: ans.ideal_answer_summary
          })
          .eq('session_id', session_id)
          .eq('question_id', question.id)
      }
    }

    // Send email if we have an address
    if (email) {
      await resend.emails.send({
        from: process.env.FROM_EMAIL,
        to: email,
        subject: `Your Interview Report — ${scored.overall_score}/100`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; background: #0a0a0f; color: #e8e8e0;">
            <p style="font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: #c8a96e; margin-bottom: 8px;">Your Interview Report</p>
            <h1 style="font-size: 56px; font-weight: 300; color: #fff; margin: 0 0 4px;">
              ${scored.overall_score}
              <span style="font-size: 24px; color: rgba(255,255,255,0.3);">/100</span>
            </h1>
            <p style="font-size: 13px; color: rgba(255,255,255,0.4); margin-bottom: 32px;">Interview Readiness Score — ${scored.job_title}</p>
            
            <hr style="border: 0.5px solid rgba(255,255,255,0.08); margin-bottom: 32px;" />
            
            <p style="font-size: 15px; color: rgba(255,255,255,0.7); line-height: 1.7;">${scored.executive_summary}</p>
            
            <h3 style="font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: #c8a96e; margin-top: 32px;">Top Strengths</h3>
            <p style="color: rgba(255,255,255,0.6); line-height: 1.7;">${scored.top_strengths}</p>
            
            <h3 style="font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: #c8a96e; margin-top: 24px;">Critical Gaps</h3>
            <p style="color: rgba(255,255,255,0.6); line-height: 1.7;">${scored.critical_gaps}</p>
            
            <h3 style="font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: #c8a96e; margin-top: 24px;">What To Work On</h3>
            <p style="color: rgba(255,255,255,0.6); line-height: 1.7;">${scored.recommended_actions}</p>
            
            <div style="margin-top: 40px;">
              <a href="${process.env.FRONTEND_URL}/results?session=${session_id}" 
                 style="background: #c8a96e; color: #0a0a0f; padding: 14px 32px; text-decoration: none; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;">
                View Full Report
              </a>
            </div>
          </div>
        `
      })

      // Mark email sent
      await supabase
        .from('reports')
        .update({ email_sent: true })
        .eq('session_id', session_id)
    }

    // Set session complete
    await supabase
      .from('sessions')
      .update({ status: 'complete' })
      .eq('id', session_id)

    console.log(`Scoring complete for session ${session_id}`)

  } catch (err) {
    console.error('Scoring error:', err)

    await supabase
      .from('sessions')
      .update({ status: 'failed' })
      .eq('id', session_id)
  }
})

// GET /api/score/:session_id
// Called by /results page to fetch the report
router.get('/:session_id', async (req, res) => {
  try {
    const { session_id } = req.params

    const { data, error } = await supabase
      .from('reports')
      .select('*')
      .eq('session_id', session_id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Report not found' })

    // Parse scores JSON back to object
    if (data.scores && typeof data.scores === 'string') {
      data.scores = JSON.parse(data.scores)
    }

    return res.json({ report: data })

  } catch (err) {
    console.error('Fetch report error:', err)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router

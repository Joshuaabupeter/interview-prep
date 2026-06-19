const express = require('express')
const router = express.Router()
const { GoogleGenerativeAI } = require('@google/generative-ai')
const supabase = require('../lib/supabase')

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// ─── Gemini retry with backoff ─────────────────────────────
const generateWithRetry = async (model, prompt, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt)
      const text = result.response.text().trim()
      const cleaned = text
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim()
      return JSON.parse(cleaned)
    } catch (err) {
      console.error(`Gemini attempt ${attempt} failed:`, err)
      if (attempt === maxRetries) throw err
      await new Promise(r => setTimeout(r, 1000 * attempt))
    }
  }
}

// POST /api/questions/generate
router.post('/generate', async (req, res) => {
  const { session_id } = req.body

  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required' })
  }

  res.status(202).json({ message: 'Question generation started' })

  try {
    await supabase
      .from('sessions')
      .update({ status: 'processing' })
      .eq('id', session_id)

    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('cv_extracted_text, jd_text')
      .eq('session_id', session_id)
      .single()

    if (docError || !doc) throw new Error('Could not fetch documents for session')

    const { cv_extracted_text, jd_text } = doc

    if (!cv_extracted_text || cv_extracted_text.length < 100) {
      throw new Error('CV content is too short or missing')
    }

    if (!jd_text || jd_text.length < 500) {
      throw new Error('Job description is too short or missing')
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' })

    const prompt = `You are a senior recruiter and executive interview coach.

You have been given a candidate CV and a Job Description.

Your task:
1. Identify the 3 most significant gaps between the candidate and the role
2. Generate exactly 5 probing interview questions targeting those gaps

Rules for questions:
- Question 1 must ALWAYS be a version of "tell me about yourself" but written specifically for THIS candidate and THIS role.
  Reference their actual background and the specific role they are applying for.
  Example format: "I have your CV in front of me, and I see you've spent the last [Number] years focused heavily on [Skill/Industry from CV]. 
  To kick things off, tell me a bit about yourself and specifically why you are pivoting toward this [Job Title from JD] position right now?"
- Questions 2-5 target the specific gaps between their CV and the JD
- Specific to THIS candidate and THIS role only
- Direct and pressure-testing, no soft language
- Sound exactly like a real human interviewer speaking out loud
- No apostrophes, no double quotes, no backslashes, no special characters
- Write all contractions as full words: use "you are" not "you're"
- Use only plain letters, numbers, spaces, commas, and question marks
- Mix of situational, competency, and skills-gap questions

CANDIDATE CV:
${cv_extracted_text}

JOB DESCRIPTION:
${jd_text}

Return ONLY valid JSON. No explanation. No markdown. No code blocks.
Exactly this structure:
{
  "gaps": ["Gap 1", "Gap 2", "Gap 3"],
  "questions": [
    {"order": 1, "question": "Question text here"},
    {"order": 2, "question": "Question text here"},
    {"order": 3, "question": "Question text here"},
    {"order": 4, "question": "Question text here"},
    {"order": 5, "question": "Question text here"}
  ]
}`

    const parsed = await generateWithRetry(model, prompt)

    if (!parsed.questions || !Array.isArray(parsed.questions)) {
      throw new Error('Gemini returned invalid question format')
    }

    const questionRows = parsed.questions.map(q => ({
      session_id,
      prompt: q.question,
      position: q.order,
      is_followup: false
    }))

    const { error: insertError } = await supabase
      .from('questions')
      .insert(questionRows)

    if (insertError) throw insertError

    await supabase
      .from('sessions')
      .update({ status: 'interview_ready', current_position: 1, total_turns: 0 })
      .eq('id', session_id)

    console.log(`Questions generated successfully for session ${session_id}`)

  } catch (err) {
    console.error('Question generation error:', err)

    await supabase
      .from('sessions')
      .update({ status: 'failed' })
      .eq('id', session_id)

    // Auto credit refund on failure
    try {
      const { data: sessionData } = await supabase
        .from('sessions')
        .select('payment_ref')
        .eq('id', session_id)
        .single()

      if (sessionData?.payment_ref) {
        const { data: currentPayment } = await supabase
          .from('payments')
          .select('credits_remaining')
          .eq('reference', sessionData.payment_ref)
          .single()

        if (currentPayment) {
          await supabase
            .from('payments')
            .update({
              credits_remaining: currentPayment.credits_remaining + 1
            })
            .eq('reference', sessionData.payment_ref)

          console.log('Credit refunded due to generation failure.')
        }
      }
    } catch (refundError) {
      console.error('Credit refund failed:', refundError)
    }
  }
})

// GET /api/questions/:session_id
router.get('/:session_id', async (req, res) => {
  try {
    const { session_id } = req.params

    const { data, error } = await supabase
      .from('questions')
      .select('id, prompt, position, is_followup, parent_question_id')
      .eq('session_id', session_id)
      .order('position', { ascending: true })

    if (error) throw error

    return res.json({ questions: data })

  } catch (err) {
    console.error('Fetch questions error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// POST /api/questions/next
router.post('/next', async (req, res) => {
  try {
    const { session_id, question_id, transcript } = req.body

    if (!session_id || !question_id || !transcript) {
      return res.status(400).json({
        error: 'session_id, question_id, and transcript are required'
      })
    }

    // Fetch current session state
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('current_position, total_turns')
      .eq('id', session_id)
      .single()

    if (sessionError || !session) throw new Error('Session not found')

    const current_position = parseInt(session.current_position) || 1
    const total_turns = parseInt(session.total_turns) || 0

    // Fetch the current question
    const { data: currentQuestion, error: qError } = await supabase
      .from('questions')
      .select('id, prompt, position, is_followup, parent_question_id')
      .eq('id', question_id)
      .single()

    if (qError || !currentQuestion) throw new Error('Question not found')

    // Fetch all main questions
    const { data: allQuestions } = await supabase
      .from('questions')
      .select('id, prompt, position, is_followup')
      .eq('session_id', session_id)
      .eq('is_followup', false)
      .order('position', { ascending: true })

    const totalMainQuestions = allQuestions?.length || 5
    const maxTurns = totalMainQuestions * 2

    const alreadyHadFollowup = currentQuestion.is_followup
    const hitMaxTurns = total_turns >= maxTurns

    let decision = { action: 'next', followup_question: null }

    if (!alreadyHadFollowup && !hitMaxTurns) {
      // Ask Gemini to decide
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' })

      const decisionPrompt = `You are conducting a job interview.

You just asked this question:
"${currentQuestion.prompt}"

The candidate answered:
"${transcript}"

Decide: does this answer warrant a follow-up question, or was it sufficient to move on?

Rules:
- Follow up ONLY if the answer was vague, incomplete, or dodged the core of the question
- Do NOT follow up if the answer was clear, specific, and addressed the question well
- Follow-up questions must dig deeper into the SAME topic, not introduce a new area
- Write follow-up questions as clean spoken sentences, no apostrophes, no special characters
- Maximum one follow-up per main question

Return ONLY valid JSON. No markdown. No explanation.
{
  "should_followup": true,
  "reason": "Answer was vague about specific metrics",
  "followup_question": "You mentioned managing a team but did not specify the size or outcomes. How many people did you manage and what measurable results did your leadership produce?"
}

OR if moving on:
{
  "should_followup": false,
  "reason": "Answer was specific and complete",
  "followup_question": null
}`

      try {
        const geminiDecision = await generateWithRetry(model, decisionPrompt)

        if (geminiDecision.should_followup && geminiDecision.followup_question) {
          decision.action = 'followup'
          decision.followup_question = geminiDecision.followup_question
          decision.reason = geminiDecision.reason
        } else {
          decision.action = 'next'
          decision.reason = geminiDecision.reason
        }
      } catch (geminiErr) {
        // If Gemini fails on decision, safely move to next question
        console.error('Gemini follow-up decision failed, moving on:', geminiErr)
        decision.action = 'next'
      }
    }

    // Insert follow-up question
    if (decision.action === 'followup' && decision.followup_question) {
      const parentId = currentQuestion.is_followup
        ? currentQuestion.parent_question_id
        : currentQuestion.id

      // ─── KEY FIX ─────────────────────────────────────────
      // Use a large integer position instead of decimal (e.g. 1.5)
      // Multiply main position by 100, add 50 for follow-up
      // So Q1=100, Q1 followup=150, Q2=200, Q2 followup=250 etc.
      // This keeps ordering correct without any decimals
      const mainPosition = Math.round(parseFloat(currentQuestion.position))
      const followupPosition = (mainPosition * 100) + 50

      const { data: newQuestion, error: insertError } = await supabase
        .from('questions')
        .insert({
          session_id,
          prompt: decision.followup_question,
          position: followupPosition,
          is_followup: true,
          parent_question_id: parentId
        })
        .select()
        .single()

      if (insertError) throw insertError

      await supabase
        .from('sessions')
        .update({ total_turns: total_turns + 1 })
        .eq('id', session_id)

      return res.json({
        action: 'followup',
        question: {
          id: newQuestion.id,
          prompt: newQuestion.prompt,
          position: newQuestion.position,
          is_followup: true
        },
        reason: decision.reason
      })
    }

    // Move to next main question
    const nextPosition = current_position + 1
    const nextQuestion = allQuestions?.find(
      q => parseInt(q.position) === nextPosition
    )
    const isComplete = !nextQuestion

    await supabase
      .from('sessions')
      .update({
        current_position: nextPosition,
        total_turns: total_turns + 1
      })
      .eq('id', session_id)

    if (isComplete) {
      return res.json({
        action: 'complete',
        message: 'All questions answered'
      })
    }

    return res.json({
      action: 'next',
      question: {
        id: nextQuestion.id,
        prompt: nextQuestion.prompt,
        position: nextQuestion.position,
        is_followup: false
      },
      reason: decision.reason
    })

  } catch (err) {
    console.error('Next question error:', err)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router

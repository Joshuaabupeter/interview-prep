const express = require('express')
const router = express.Router()
const { GoogleGenerativeAI } = require('@google/generative-ai')
const supabase = require('../lib/supabase')

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// POST /api/questions/generate
// Called after session is created — triggers question generation
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

    const result = await model.generateContent(prompt)
    const text = result.response.text().trim()
    const cleaned = text
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim()

    const parsed = JSON.parse(cleaned)

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
  }
})

// GET /api/questions/:session_id
// Called by interview room to load questions
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
// Called after each answer — AI decides follow-up or move on
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

    const { current_position, total_turns } = session

    // Fetch the current question
    const { data: currentQuestion, error: qError } = await supabase
      .from('questions')
      .select('id, prompt, position, is_followup, parent_question_id')
      .eq('id', question_id)
      .single()

    if (qError || !currentQuestion) throw new Error('Question not found')

    // Fetch all main questions for this session
    const { data: allQuestions } = await supabase
      .from('questions')
      .select('id, prompt, position, is_followup')
      .eq('session_id', session_id)
      .eq('is_followup', false)
      .order('position', { ascending: true })

    const totalMainQuestions = allQuestions?.length || 5
    const maxTurns = totalMainQuestions * 2 // 1 follow-up max per question

    // Hard limits — always move on if:
    // 1. Already did a follow-up on this question
    // 2. Hit max turns
    // 3. On the last main question with no follow-up yet
    const alreadyHadFollowup = currentQuestion.is_followup
    const hitMaxTurns = total_turns >= maxTurns

    let decision = { action: 'followup', followup_question: null }

    if (alreadyHadFollowup || hitMaxTurns) {
      decision.action = 'next'
    } else {
      // Ask Gemini to decide — follow-up or move on
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

      const decisionPrompt = `You are conducting a job interview.

You just asked this question:
"${currentQuestion.prompt}"

The candidate answered:
"${transcript}"

Decide: does this answer warrant a follow-up question, or was it sufficient to move on?

Rules:
- Follow up ONLY if the answer was vague, incomplete, or dodged the core of the question
- Do NOT follow up if the answer was clear, specific, and addressed the question well
- Follow-up questions must dig deeper into the SAME topic — not introduce a new area
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

      const result = await model.generateContent(decisionPrompt)
      const text = result.response.text().trim()
      const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
      const geminiDecision = JSON.parse(cleaned)

      if (geminiDecision.should_followup && geminiDecision.followup_question) {
        decision.action = 'followup'
        decision.followup_question = geminiDecision.followup_question
        decision.reason = geminiDecision.reason
      } else {
        decision.action = 'next'
        decision.reason = geminiDecision.reason
      }
    }

    // If following up — insert the follow-up question into DB
    if (decision.action === 'followup' && decision.followup_question) {
      const parentId = currentQuestion.is_followup
        ? currentQuestion.parent_question_id
        : currentQuestion.id

      // Position as decimal so it sorts between main questions
      const followupPosition = currentQuestion.position + 0.5

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

      // Update turn count
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

    // Moving to next main question
    const nextPosition = current_position + 1
    const nextQuestion = allQuestions?.find(q => q.position === nextPosition)
    const isComplete = !nextQuestion

    // Update session position
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

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

  // Respond immediately so Lovable does not time out
  // Question generation runs in the background
  res.status(202).json({ message: 'Question generation started' })

  try {
    // Update status to processing
    await supabase
      .from('sessions')
      .update({ status: 'processing' })
      .eq('id', session_id)

    // Fetch CV and JD
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

    // Call Gemini
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
- Write all contractions as full words: use "you are" not "you're", "do not" not "don't"
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

    // Strip any markdown code blocks if Gemini adds them
    const cleaned = text
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim()

    const parsed = JSON.parse(cleaned)

    if (!parsed.questions || !Array.isArray(parsed.questions)) {
      throw new Error('Gemini returned invalid question format')
    }

    // Write all questions to Supabase in one batch
    const questionRows = parsed.questions.map(q => ({
      session_id,
      prompt: q.question,
      position: q.order
    }))

    const { error: insertError } = await supabase
      .from('questions')
      .insert(questionRows)

    if (insertError) throw insertError

    // Update session status to interview_ready
    await supabase
      .from('sessions')
      .update({ status: 'interview_ready' })
      .eq('id', session_id)

    console.log(`Questions generated successfully for session ${session_id}`)

  } catch (err) {
    console.error('Question generation error:', err)

    // Mark session as failed so frontend stops polling
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
      .select('id, prompt, position')
      .eq('session_id', session_id)
      .order('position', { ascending: true })

    if (error) throw error

    return res.json({ questions: data })

  } catch (err) {
    console.error('Fetch questions error:', err)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router

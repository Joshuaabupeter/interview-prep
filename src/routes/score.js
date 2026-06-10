const express = require('express')
const router = express.Router()
const { GoogleGenerativeAI } = require('@google/generative-ai')
const { Resend } = require('resend')
const supabase = require('../lib/supabase')

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const resend = new Resend(process.env.RESEND_API_KEY)

// ─── Speech Analysis Helper ───────────────────────────────
const analyzeSpeech = (transcript, durationSeconds) => {
  if (!transcript || transcript.trim().length === 0) {
    return {
      word_count: 0,
      words_per_minute: 0,
      wpm_rating: 'No answer',
      filler_count: 0,
      filler_words_found: [],
      filler_rating: 'No answer',
      answer_length_rating: 'No answer',
      answer_length_note: 'No answer was recorded'
    }
  }

  const words = transcript.trim().split(/\s+/)
  const wordCount = words.length

  // Words per minute
  const durationMinutes = durationSeconds ? durationSeconds / 60 : null
  const wpm = durationMinutes ? Math.round(wordCount / durationMinutes) : null

  let wpmRating = 'Unknown'
  let wpmNote = ''
  if (wpm) {
    if (wpm < 80) {
      wpmRating = 'Too slow'
      wpmNote = 'Speaking too slowly can signal nervousness. Aim for 120-150 WPM.'
    } else if (wpm <= 160) {
      wpmRating = 'Good pace'
      wpmNote = 'Your speaking pace is within the ideal interview range.'
    } else if (wpm <= 200) {
      wpmRating = 'Slightly fast'
      wpmNote = 'Try slowing down slightly to give the interviewer time to absorb your answer.'
    } else {
      wpmRating = 'Too fast'
      wpmNote = 'Speaking too quickly can make answers hard to follow. Slow down and pause deliberately.'
    }
  }

  // Filler word detection
  const fillerPatterns = [
    'um', 'uh', 'uhh', 'umm', 'er', 'err',
    'you know', 'like', 'basically', 'literally',
    'right', 'so', 'kind of', 'sort of', 'i mean',
    'actually', 'honestly', 'to be honest'
  ]

  const lowerTranscript = transcript.toLowerCase()
  const foundFillers = []
  let totalFillerCount = 0

  fillerPatterns.forEach(filler => {
    const regex = new RegExp(`\\b${filler}\\b`, 'gi')
    const matches = lowerTranscript.match(regex)
    if (matches && matches.length > 0) {
      foundFillers.push({ word: filler, count: matches.length })
      totalFillerCount += matches.length
    }
  })

  // Sort by frequency
  foundFillers.sort((a, b) => b.count - a.count)

  let fillerRating = 'Excellent'
  let fillerNote = 'No significant filler words detected.'
  const fillerRate = wordCount > 0 ? (totalFillerCount / wordCount) * 100 : 0

  if (fillerRate > 15) {
    fillerRating = 'High'
    fillerNote = 'Excessive filler words detected. Practice pausing silently instead of filling gaps.'
  } else if (fillerRate > 8) {
    fillerRating = 'Moderate'
    fillerNote = 'Some filler words present. Be more conscious of pause moments.'
  } else if (fillerRate > 3) {
    fillerRating = 'Low'
    fillerNote = 'Minor filler words. Nearly interview-ready on this metric.'
  }

  // Answer length rating
  let answerLengthRating = 'Good length'
  let answerLengthNote = 'Your answer length is appropriate for an interview setting.'

  if (wordCount < 30) {
    answerLengthRating = 'Too brief'
    answerLengthNote = 'Answer is too short. Interviewers expect structured responses of at least 60-150 words.'
  } else if (wordCount < 60) {
    answerLengthRating = 'Slightly short'
    answerLengthNote = 'Answer could be more detailed. Add specific examples or outcomes.'
  } else if (wordCount > 350) {
    answerLengthRating = 'Too long'
    answerLengthNote = 'Answer is too long. Keep responses focused and under 2 minutes.'
  } else if (wordCount > 250) {
    answerLengthRating = 'Slightly long'
    answerLengthNote = 'Consider trimming. Concise answers are more memorable.'
  }

  return {
    word_count: wordCount,
    words_per_minute: wpm,
    wpm_rating: wpmRating,
    wpm_note: wpmNote,
    filler_count: totalFillerCount,
    filler_words_found: foundFillers.slice(0, 5), // top 5 offenders
    filler_rate_percent: Math.round(fillerRate * 10) / 10,
    filler_rating: fillerRating,
    filler_note: fillerNote,
    answer_length_rating: answerLengthRating,
    answer_length_note: answerLengthNote
  }
}

// ─── Overall Speech Summary Helper ───────────────────────
const buildSpeechSummary = (speechMetrics) => {
  const validAnswers = speechMetrics.filter(m => m.word_count > 0)
  if (validAnswers.length === 0) return null

  const totalFillers = validAnswers.reduce((sum, m) => sum + m.filler_count, 0)
  const totalWords = validAnswers.reduce((sum, m) => sum + m.word_count, 0)
  const avgWpm = validAnswers
    .filter(m => m.words_per_minute)
    .reduce((sum, m, _, arr) => sum + m.words_per_minute / arr.length, 0)

  // Most used filler words across all answers
  const allFillers = {}
  validAnswers.forEach(m => {
    m.filler_words_found.forEach(f => {
      allFillers[f.word] = (allFillers[f.word] || 0) + f.count
    })
  })

  const topFillers = Object.entries(allFillers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word, count]) => ({ word, count }))

  const overallFillerRate = totalWords > 0
    ? Math.round((totalFillers / totalWords) * 1000) / 10
    : 0

  return {
    total_filler_words: totalFillers,
    overall_filler_rate_percent: overallFillerRate,
    top_filler_words: topFillers,
    average_wpm: avgWpm ? Math.round(avgWpm) : null,
    total_words_spoken: totalWords
  }
}

// POST /api/score
router.post('/', async (req, res) => {
  const { session_id } = req.body

  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required' })
  }

  res.status(202).json({ message: 'Scoring started' })

  try {
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

    // Fetch answers — include duration_seconds
    const { data: answers, error: aError } = await supabase
      .from('answers')
      .select('question_id, transcript, duration_seconds')
      .eq('session_id', session_id)

    if (aError) throw new Error('Could not fetch answers')

    // Fetch JD
    const { data: doc, error: dError } = await supabase
      .from('documents')
      .select('jd_text')
      .eq('session_id', session_id)
      .single()

    if (dError || !doc) throw new Error('Could not fetch job description')

    // Fetch session
    const { data: session, error: sError } = await supabase
      .from('sessions')
      .select('email, metadata')
      .eq('id', session_id)
      .single()

    if (sError) throw new Error('Could not fetch session')

    const email = session.email || session.metadata?.email

    // ─── Run speech analysis on every answer ─────────────
    const speechMetrics = questions.map(q => {
      const answer = answers.find(a => a.question_id === q.id)
      const transcript = answer?.transcript || ''
      const duration = answer?.duration_seconds || null
      return {
        question_position: q.position,
        ...analyzeSpeech(transcript, duration)
      }
    })

    const speechSummary = buildSpeechSummary(speechMetrics)

      // Build Q+A block including follow-ups
const qaBlock = questions.map(q => {
  const answer = answers.find(a => a.question_id === q.id)
  const transcript = answer?.transcript || 'The candidate did not answer.'

  // Find follow-up for this question if any
  const followupQuestion = allFollowups?.find(
    fq => fq.parent_question_id === q.id
  )
  const followupAnswer = followupQuestion
    ? answers.find(a => a.question_id === followupQuestion.id)
    : null

  let block = `QUESTION ${q.position}: ${q.prompt}\nCANDIDATE ANSWER: ${transcript}`

  if (followupQuestion && followupAnswer) {
    block += `\nFOLLOW-UP: ${followupQuestion.prompt}\nCANDIDATE FOLLOW-UP ANSWER: ${followupAnswer.transcript || 'No answer given.'}`
  }

  return block
}).join('\n\n')

    // Call Gemini for scoring
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' })

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
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
    const scored = JSON.parse(cleaned)

    // Write report — include speech data in scores
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
          answers: scored.answers,
          speech_summary: speechSummary,
          speech_per_answer: speechMetrics
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

    // Send email
    if (email) {
      const topFillerText = speechSummary?.top_filler_words?.length
        ? speechSummary.top_filler_words.map(f => `"${f.word}" (${f.count}x)`).join(', ')
        : 'None detected'

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
            ${speechSummary ? `
            <hr style="border: 0.5px solid rgba(255,255,255,0.08); margin: 32px 0;" />
            <h3 style="font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: #c8a96e;">Communication Analysis</h3>
            <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
              <tr>
                <td style="color: rgba(255,255,255,0.4); font-size: 12px; padding: 8px 0;">Total words spoken</td>
                <td style="color: #fff; font-size: 12px; text-align: right;">${speechSummary.total_words_spoken}</td>
              </tr>
              <tr>
                <td style="color: rgba(255,255,255,0.4); font-size: 12px; padding: 8px 0;">Average speaking pace</td>
                <td style="color: #fff; font-size: 12px; text-align: right;">${speechSummary.average_wpm ? speechSummary.average_wpm + ' WPM' : 'N/A'}</td>
              </tr>
              <tr>
                <td style="color: rgba(255,255,255,0.4); font-size: 12px; padding: 8px 0;">Filler words used</td>
                <td style="color: #fff; font-size: 12px; text-align: right;">${speechSummary.total_filler_words} (${speechSummary.overall_filler_rate_percent}% of speech)</td>
              </tr>
              <tr>
                <td style="color: rgba(255,255,255,0.4); font-size: 12px; padding: 8px 0;">Most used fillers</td>
                <td style="color: #fff; font-size: 12px; text-align: right;">${topFillerText}</td>
              </tr>
            </table>
            ` : ''}
            <div style="margin-top: 40px;">
              <a href="${process.env.FRONTEND_URL}/results?session=${session_id}"
                 style="background: #c8a96e; color: #0a0a0f; padding: 14px 32px; text-decoration: none; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;">
                View Full Report
              </a>
            </div>
          </div>
        `
      })

      await supabase
        .from('reports')
        .update({ email_sent: true })
        .eq('session_id', session_id)
    }

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

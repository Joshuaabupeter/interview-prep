const express = require('express')
const router = express.Router()
const supabase = require('../lib/supabase')

// GET /api/admin/stats?key=YOUR_ADMIN_KEY
router.get('/stats', async (req, res) => {
  try {
    const { key } = req.query

    // 1. Authenticate the administrator request
    if (!key || key !== process.env.ADMIN_SECRET_KEY) {
      return res.status(401).json({ error: 'Unauthorized: Invalid admin key.' })
    }

    // Set up relative date filters
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayISO = todayStart.toISOString()

    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    const sevenDaysAgoISO = sevenDaysAgo.toISOString()

    // 2. Fetch Today's Sessions metrics
    const { data: todaySessions, error: todayErr } = await supabase
      .from('sessions')
      .select('status')
      .gte('created_at', todayISO)

    if (todayErr) throw todayErr

    const sessionsToday = todaySessions?.length || 0
    const sessionsCompleted = todaySessions?.filter(s => s.status === 'complete').length || 0
    const sessionsFailed = todaySessions?.filter(s => s.status === 'failed').length || 0

    // 3. Fetch Weekly Revenue (Convert Paystack Kobo to Naira)
    const { data: weeklyPayments, error: revErr } = await supabase
      .from('payments')
      .select('amount')
      .eq('status', 'success')
      .gte('created_at', sevenDaysAgoISO)

    if (revErr) throw revErr

    const revenueThisWeek = weeklyPayments?.reduce((sum, item) => sum + (item.amount / 100), 0) || 0

    // 4. ADDED: Fetch All-Time Total Revenue
    const { data: allPayments, error: allRevErr } = await supabase
      .from('payments')
      .select('amount')
      .eq('status', 'success')

    if (allRevErr) throw allRevErr

    const totalRevenueAllTime = allPayments?.reduce((sum, item) => sum + (item.amount / 100), 0) || 0

    // 5. ADDED: Fetch All-Time Total Sessions using high-performance 'head' count
    const { count: allSessionsCount, error: countErr } = await supabase
      .from('sessions')
      .select('*', { count: 'exact', head: true })

    if (countErr) throw countErr

    // 6. Fetch Average Scoring performance across reports
    const { data: performanceReports, error: scoreErr } = await supabase
      .from('reports')
      .select('overall_score')

    if (scoreErr) throw scoreErr

    const totalReportsCount = performanceReports?.length || 0
    const sumScores = performanceReports?.reduce((sum, item) => sum + item.overall_score, 0) || 0
    const avgScore = totalReportsCount > 0 ? Math.round(sumScores / totalReportsCount) : 0

    // 7. Output combined analytics payload response
    return res.json({
      sessions_today: sessionsToday,
      sessions_completed: sessionsCompleted,
      sessions_failed: sessionsFailed,
      revenue_this_week_ngn: revenueThisWeek,
      total_revenue_all_time_ngn: totalRevenueAllTime,
      total_sessions_all_time: allSessionsCount || 0,
      avg_score: avgScore
    })

  } catch (err) {
    console.error('Admin stats error:', err)
    return res.status(500).json({ error: err.message })
  }

  // Average feedback rating
const { data: feedbackData } = await supabase
  .from('feedback')
  .select('rating')

const totalFeedback = feedbackData?.length || 0
const avgRating = totalFeedback > 0
  ? Math.round(
      (feedbackData.reduce((sum, f) => sum + f.rating, 0) / totalFeedback) * 10
    ) / 10
  : null

  // General feedback / talk to us
const { data: talkToUsData, count: talkToUsCount } = await supabase
  .from('general_feedback')
  .select('*', { count: 'exact' })
  .order('created_at', { ascending: false })
  .limit(10)
  
})

module.exports = router

const authenticate = (req, res, next) => {
  // Skip auth for health check and payment webhook
  // Webhook has its own Paystack signature verification
  const skipPaths = [
    '/health',
    '/api/payment/webhook'
  ]

  if (skipPaths.some(path => req.path.startsWith(path))) {
    return next()
  }

  const apiKey = req.headers['x-api-key']

  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ 
      error: 'Unauthorized' 
    })
  }

  next()
}

module.exports = authenticate
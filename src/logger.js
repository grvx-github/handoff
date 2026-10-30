const pino = require('pino'), fs = require('fs');
fs.mkdirSync('logs', { recursive: true });
module.exports = pino(
  { level: process.env.LOG_LEVEL || 'info', redact: { paths: ['apiKey', '*.apiKey', 'req.headers.authorization'], censor: '[REDACTED]' } },
  pino.multistream([{ stream: process.stdout }, { stream: pino.destination({ dest: 'logs/app.log', sync: false }) }])
);

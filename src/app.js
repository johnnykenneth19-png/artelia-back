const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const config = require('./config');
const routes = require('./routes');
const { apiLimiter } = require('./middleware/rateLimit');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const paymentController = require('./controllers/paymentWebhookController');
const payoutWebhookController = require('./controllers/payoutWebhookController');

const app = express();

app.use(helmet());
app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(morgan(config.env === 'development' ? 'dev' : 'combined'));
app.use(cookieParser());

// Webhook routes need the RAW body for signature verification, so they
// are mounted BEFORE express.json() and given their own raw parser.
app.post('/api/webhooks/payments', express.raw({ type: '*/*' }), paymentController.handleWebhook);
app.post('/api/webhooks/payouts', express.raw({ type: '*/*' }), payoutWebhookController.handleWebhook);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api', apiLimiter, routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;

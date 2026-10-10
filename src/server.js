const app = require('./app');
const config = require('./config');

const server = app.listen(config.port, () => {
  console.log(`ARTELIA API listening on port ${config.port} [${config.env}]`);
});

// Graceful shutdown
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

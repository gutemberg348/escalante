module.exports = {
  apps: [{
    name: 'escala-cicc-api',
    cwd: '/var/www/bot_escala/escalante/backend',
    script: 'src/server.js',
    interpreter: 'node',
    instances: 1,
    autorestart: true,
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'production',
      API_PORT: 3000
    }
  }]
};

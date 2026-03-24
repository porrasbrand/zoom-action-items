/**
 * PM2 Configuration for Zoom Pipeline Services
 */
module.exports = {
  apps: [
    {
      name: 'zoom-pipeline',
      script: 'src/service.js',

      // Logging
      out_file: 'logs/zoom-pipeline-out.log',
      error_file: 'logs/zoom-pipeline-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // Restart behavior
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000, // 5 seconds between restarts

      // Environment
      env: {
        NODE_ENV: 'production',
      },

      // Memory limits (restart if exceeds)
      max_memory_restart: '500M',

      // Watch settings (disabled - we poll on interval)
      watch: false,
    },
    {
      name: 'zoom-dashboard',
      script: 'src/api/server.js',

      // Logging
      out_file: 'logs/zoom-dashboard-out.log',
      error_file: 'logs/zoom-dashboard-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // Restart behavior
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,

      // Environment
      env: {
        NODE_ENV: 'production',
        DASHBOARD_PORT: 3875,
      },

      // Memory limits
      max_memory_restart: '300M',

      watch: false,
    },
  ],
};

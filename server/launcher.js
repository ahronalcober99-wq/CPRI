import { spawn } from 'child_process';
import net from 'net';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const SERVER_ENTRY = join(__dirname, 'server.js');

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err) => {
      resolve(err.code !== 'EADDRINUSE');
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, HOST);
  });
}

function startServer() {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code, signal) => {
    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      process.exit(0);
    }

    if (code === 0) {
      process.exit(0);
    }

    console.error(`Server exited unexpectedly with code ${code}. Restarting in 2 seconds...`);
    setTimeout(startServer, 2000);
  });
}

async function main() {
  const available = await isPortAvailable(PORT);

  if (!available) {
    console.log(`Port ${PORT} is already in use. The server may already be running. Exiting launcher.`);
    process.exit(0);
  }

  console.log(`Starting CPRI server on http://localhost:${PORT}...`);
  startServer();
}

main().catch((err) => {
  console.error('Launcher failed to start:', err);
  process.exit(1);
});

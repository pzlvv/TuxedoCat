import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_DIR_NAME, LOG_FILE_NAME } from '../config/project.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const PREFIXES: Record<LogLevel, string> = {
  debug: '[DEBUG]',
  info: '[INFO]',
  warn: '[WARN]',
  error: '[ERROR]',
};

type LogCallback = (message: string) => void;

let logCallback: LogCallback | null = null;
let logToConsole = false;

const LOG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', CONFIG_DIR_NAME, 'logs');
const LOG_FILE = path.join(LOG_DIR, LOG_FILE_NAME);
const MAX_FILE_SIZE = 1 * 1024 * 1024;
const MAX_BACKUPS = 3;

let logStream: fs.WriteStream | null = null;

function ensureLogDir(): void {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch {
    // 目录创建失败时忽略，写入会降级为无文件日志
  }
}

function rotateLog(): void {
  try {
    const oldestBackup = `${LOG_FILE}.${MAX_BACKUPS}`;
    if (fs.existsSync(oldestBackup)) fs.unlinkSync(oldestBackup);
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      const src = `${LOG_FILE}.${i}`;
      if (fs.existsSync(src)) fs.renameSync(src, `${LOG_FILE}.${i + 1}`);
    }
    if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // 轮转失败时忽略
  }
}

function getLogStream(): fs.WriteStream | null {
  if (logStream) return logStream;

  try {
    ensureLogDir();
    try {
      if (fs.statSync(LOG_FILE).size >= MAX_FILE_SIZE) rotateLog();
    } catch {
      // 文件不存在，无需轮转
    }
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    logStream.on('error', () => {});
    return logStream;
  } catch {
    return null;
  }
}

function writeToFile(message: string): void {
  getLogStream()?.write(message + '\n');
}

export function setLogCallback(callback: LogCallback | null): void {
  logCallback = callback;
}

export function setLogToConsole(enabled: boolean): void {
  logToConsole = enabled;
}

function log(level: LogLevel, component: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const prefix = `${PREFIXES[level]} [${component}]`;
  const message = `${prefix} ${timestamp} ${args.map(arg =>
    typeof arg === 'string' ? arg : JSON.stringify(arg, null, 2)
  ).join(' ')}`;

  if (logToConsole) {
    console.error(prefix, timestamp, ...args);
  }
  writeToFile(message);
  logCallback?.(message);
}

export const logger = {
  debug: (component: string, ...args: unknown[]) => log('debug', component, ...args),
  info: (component: string, ...args: unknown[]) => log('info', component, ...args),
  warn: (component: string, ...args: unknown[]) => log('warn', component, ...args),
  error: (component: string, ...args: unknown[]) => log('error', component, ...args),
};

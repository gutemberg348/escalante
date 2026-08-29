import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
dotenv.config({ path: path.join(projectRoot, '.env') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_PATH: z.string().default('./data/escala.sqlite'),
  SESSION_SECRET: z.string().min(16),
  LOG_LEVEL: z.string().default('info'),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_INITIAL_PASSWORD: z.string().min(12)
});

const values = schema.parse(process.env);
export const env = { ...values, DATABASE_PATH: path.isAbsolute(values.DATABASE_PATH) ? values.DATABASE_PATH : path.resolve(projectRoot, values.DATABASE_PATH) };

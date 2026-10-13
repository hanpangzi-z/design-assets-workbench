import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Local development starts with the existing administrator identity, without SSO.
// The production entry remains app.ts and never enables this mode.
process.env.NODE_ENV ??= 'development';
if (process.env.NODE_ENV === 'development') process.env.LOCAL_DEV_NO_LOGIN ??= '1';
process.env.HOST ??= '127.0.0.1';

void import('./app');

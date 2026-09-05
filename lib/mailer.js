// ============================================================================
//  Outbound mail.
//
//  Pluggable transport chosen by MAIL_TRANSPORT:
//    unset / 'console' — log the message (dev default; nothing is sent)
//    'file'            — append to MAIL_FILE, useful in CI
//    'smtp'            — real delivery over SMTP with STARTTLS
//
//  SMTP is implemented directly on node:net/node:tls rather than pulling in
//  nodemailer: this needs one code path (submit a message, then quit), and a
//  mail library is a large dependency for that.
// ============================================================================

import fs from 'fs/promises';
import net from 'net';
import tls from 'tls';

const FROM = process.env.MAIL_FROM || 'Antigravity Discord <no-reply@antigravity.local>';

export function currentTransport() {
  return (process.env.MAIL_TRANSPORT || 'console').toLowerCase();
}

/**
 * Send one message. Never throws for delivery problems — the caller's flow
 * (e.g. "reset link sent") must not fail because a mail server is unreachable,
 * and it must not leak whether an address exists.
 */
export async function sendMail({ to, subject, text }) {
  const message = { to, subject, text, from: FROM, at: new Date().toISOString() };

  try {
    switch (currentTransport()) {
      case 'file': {
        const target = process.env.MAIL_FILE || 'mail.log';
        await fs.appendFile(target, `${JSON.stringify(message)}\n`, 'utf8');
        return { delivered: true, transport: 'file' };
      }
      case 'smtp': {
        await sendSmtp(message);
        return { delivered: true, transport: 'smtp' };
      }
      default: {
        console.log(
          `\n📧 [mail:console] to=${to}\n   subject=${subject}\n` +
          text.split('\n').map((line) => `   ${line}`).join('\n')
        );
        return { delivered: true, transport: 'console' };
      }
    }
  } catch (err) {
    console.error(`📧 mail delivery failed (${currentTransport()}):`, err.message);
    return { delivered: false, error: err.message };
  }
}

// --- minimal SMTP client -----------------------------------------------------

const CRLF = '\r\n';

function encodeHeader(value) {
  // RFC 2047 for non-ASCII subjects; plain ASCII passes through untouched.
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

async function sendSmtp({ to, subject, text, from }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host) throw new Error('SMTP_HOST is not set');

  let socket = await connect({ host, port, secure: port === 465 });

  const read = () => new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      // A reply is complete when the last line's 4th character is a space.
      const lines = buffer.split(CRLF).filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && last[3] === ' ') {
        cleanup();
        const code = Number(last.slice(0, 3));
        if (code >= 400) reject(new Error(`SMTP ${code}: ${last.slice(4)}`));
        else resolve({ code, text: buffer });
      }
    };
    const onError = (err) => { cleanup(); reject(err); };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => onError(new Error('SMTP read timeout')), 15_000);
    socket.on('data', onData);
    socket.on('error', onError);
  });

  const send = async (line) => {
    socket.write(line + CRLF);
    return read();
  };

  await read();                                  // server greeting
  await send(`EHLO ${process.env.SMTP_EHLO || 'localhost'}`);

  if (port !== 465) {
    // Upgrade before authenticating: credentials must never cross in the clear.
    await send('STARTTLS');
    socket = await upgrade(socket, host);
    await send(`EHLO ${process.env.SMTP_EHLO || 'localhost'}`);
  }

  if (user && pass) {
    await send('AUTH LOGIN');
    await send(Buffer.from(user, 'utf8').toString('base64'));
    await send(Buffer.from(pass, 'utf8').toString('base64'));
  }

  const fromAddress = from.match(/<([^>]+)>/)?.[1] ?? from;
  await send(`MAIL FROM:<${fromAddress}>`);
  await send(`RCPT TO:<${to}>`);
  await send('DATA');

  const body = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    // Base64 in 76-character lines, so no line can exceed the SMTP limit and
    // a leading "." can never be mistaken for the end-of-data marker.
    Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g).join(CRLF),
    '.'
  ].join(CRLF);

  socket.write(body + CRLF);
  await read();
  await send('QUIT');
  socket.end();
}

function connect({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.setTimeout(15_000, () => reject(new Error('SMTP connect timeout')));
    socket.once('error', reject);
  });
}

function upgrade(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host }, () => resolve(secure));
    secure.once('error', reject);
  });
}

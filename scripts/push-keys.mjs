#!/usr/bin/env node
// ============================================================================
//  Generate a VAPID key pair for Web Push (npm run push:keys).
//
//  Prints .env lines. Generate once per deployment and keep the private key
//  secret: rotating it invalidates every existing browser subscription (each
//  browser re-subscribes on its next visit).
//
//    npm run push:keys                       # prints to stdout
//    npm run push:keys -- --subject mailto:ops@example.com
// ============================================================================

import webpush from 'web-push';

const i = process.argv.indexOf('--subject');
const subject = i !== -1 ? process.argv[i + 1] : 'mailto:admin@example.com';
if (!/^(mailto:|https:\/\/)/.test(subject ?? '')) {
  console.error('--subject must be a mailto: or https:// URL');
  process.exit(1);
}
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log('# Web Push (VAPID) — add to .env; keep VAPID_PRIVATE_KEY secret');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=${subject}`);

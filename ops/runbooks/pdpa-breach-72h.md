# Runbook: personal-data breach — 72-hour notification (PDPA)

Thailand's Personal Data Protection Act B.E. 2562 (2019), section 37(4),
requires the **data controller** (whoever operates this deployment) to notify
the **Office of the Personal Data Protection Committee (PDPC Office)** of a
personal-data breach **without delay and, where feasible, within 72 hours of
becoming aware of it**, unless the breach is unlikely to result in a risk to
people's rights and freedoms. Where the risk is **high**, the affected people
must also be told, without delay, together with the remedial measures. The
PDPC's 2022 notification on breach-notification criteria sets out what the
report must contain. (If you also serve people in the EU/UK, GDPR Art. 33/34
has the same 72-hour rule towards your lead supervisory authority.)

This is an operational checklist, not legal advice — involve your DPO or
counsel as soon as a breach is plausible.

**The clock starts when you become reasonably certain a breach happened, not
when the investigation ends.** Report what you know by hour 72 and send
updates as you learn more; a late complete report is worse than a timely
partial one.

## What counts here

Personal data in this system: account data (username, display name, e-mail,
password hashes, 2FA secrets), messages and attachments (DMs especially),
avatars, IP addresses and session metadata, voice/stage presence, reports and
moderation records, backups and log/telemetry stores holding any of these.

Breach = unauthorised access, disclosure, alteration, loss or destruction —
including a lost unencrypted backup, a leaked `.env` (database password,
`STORAGE_URL_SECRET`), a public bucket, a bug that showed one user's DMs to
another, or ransomware.

## Hour 0–4: contain and preserve

1. Open an incident; name an incident lead and a scribe. Start the timeline
   **with the time you became aware** — that is T0 for the 72 hours.
2. Contain without destroying evidence:
   - rotate what leaked: `POSTGRES_PASSWORD`, `STORAGE_URL_SECRET` (invalidates signed file URLs), `METRICS_TOKEN`, `ADMIN_TOKEN`, `TURN_SECRET`, SMTP / S3 credentials, bot tokens;
   - revoke sessions if accounts may be compromised (password reset for affected users; admin session revocation);
   - close the hole (block the path at the proxy, disable a feature, roll back the release);
   - make a bucket private / remove a public link.
3. Preserve: snapshot the database (see [restore-from-backup.md](restore-from-backup.md) §0),
   export relevant logs (`docker compose logs --since <T-7d> app > incident-logs.jsonl`),
   Loki/Tempo exports, proxy access logs. Logs are already redacted of
   passwords, tokens, e-mails and message content, but still hold user ids and IPs —
   store the evidence encrypted, access-restricted.

## Hour 4–48: assess

Answer, with evidence (request ids, trace ids, log queries):

| Question | Where to look |
| --- | --- |
| What data, whose, how many people? | database queries on affected rows; `app_http_request_duration_seconds_count` by route for volume |
| When did it start and stop? | logs by `request_id` / `user_id`, deploy history (image `org.opencontainers.image.revision`) |
| How did it happen? | the code path / config; error tracker; traces |
| Is it ongoing? | the containment above holds? |
| Risk to people? | sensitive data (DMs, health/religion/etc. in messages, credentials) or large scale → high |

Decide: **no risk** (document why, no report) / **risk** (report to PDPC
Office) / **high risk** (report and notify affected people).

## By hour 72: notify the PDPC Office

Through the PDPC Office's breach-notification channel (see pdpc.or.th for the
current form/e-service). Include, as far as known:

- the controller's name and contact person (DPO if designated);
- the nature of the breach: what happened, when, how discovered;
- categories and approximate number of people and records affected;
- the likely consequences for those people;
- measures taken and proposed, including to mitigate harm;
- whether affected people are being notified, and how.

Keep a copy of what was sent and when.

## Notify affected people (high risk)

Plain language, in the users' language (Thai and English at least), through a
channel they will see (e-mail from `MAIL_TRANSPORT`, an in-app announcement):
what happened, what data, what you have done, what they should do (change
password, revoke sessions, watch for phishing), and a contact point.

## After

- Post-incident review within two weeks: root cause, why detection took as long as it did, what alert or test would have caught it.
- Record the breach in the breach register **even if it was not reportable** (the controller must be able to show its reasoning).
- Review retention: logs, Loki/Tempo, backups and error-tracker data all hold personal data; keep them only as long as needed.

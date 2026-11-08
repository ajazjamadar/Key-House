# Public APIs catalog and Keyhouse

This repository contains the generated Public APIs catalog and a small local API key manager called Keyhouse. The catalog remains the source for the directory; it does not contain private credentials.

## Setup

Keyhouse uses Node.js built-in HTTP and crypto modules with a static browser client. Copy `.env.example` to `.env`, set `API_KEY_MANAGER_ENCRYPTION_KEY` to a new 64-character hexadecimal value, and run `npm start`. Generate a key with:

`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Open `http://127.0.0.1:3000`. Keyhouse reads `.env` automatically. Credentials are encrypted with AES-256-GCM in `storage/credentials.enc`; keep the encryption key separate. Losing the key makes stored credentials unrecoverable.

## Routes

- `/` — Keyhouse introduction and product overview
- `/directory` — searchable API catalog and category browser
- `/directory/:category` — APIs and descriptions for one category
- `/vault` — saved credentials dashboard
- `/about` — how Keyhouse works and FAQ

## Security notes

- Secret values are encrypted at rest and are never included in list responses or the client bundle.
- Reveal and copy are intentional actions. Secrets are not logged by the app.
- Server-side validation limits credential types, field names, labels, and values. Mutating requests require a local allowed origin and request header.
- This is a single-user local deployment, not a hosted secrets manager. Keep it on `127.0.0.1` and do not expose the port publicly.
- Never commit `.env`, `storage/credentials.enc`, or real credentials.

## Catalog scripts

- `npm run generate` parses a README into `data/apis.json` and `data/categories.json`.
- `npm run validate` validates the source README.
- `npm test` runs the existing Node test suite.
- `npm run test:app` runs the app module tests.
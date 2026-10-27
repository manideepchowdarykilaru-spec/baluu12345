# Foodie Table

Foodie Table is a restaurant ordering and table booking application. The existing visual theme is preserved with the updated brand name. The app uses React, TypeScript, Vite, Express, MongoDB/Mongoose, and server managed sessions.

## What works

- Customer registration and sign in, with bcrypt password hashing and rate limited authentication.
- Database saved customer addresses with create, edit, delete, default selection, ownership checks, and address snapshots on delivery orders.
- Database backed menu prices and availability, dish search, and a vegetarian filter.
- Server calculated delivery totals and Razorpay payment creation, signature verification, capture checks, and a signed webhook handler.
- Customer order history, status polling, tracking, and cancellation before restaurant acceptance.
- Table availability checks based on party size, active tables, and 90 minute reservation intervals. Unique 15 minute table locks prevent overlapping requests from being accepted concurrently.
- Customer reservation history and eligible cancellation. Requests stay pending until restaurant staff decides.
- Separate administrator and restaurant manager sign in. The administrator can provision, suspend, reactivate, and reset manager accounts. Managers must change temporary passwords and can manage their restaurant's orders, menu, tables, and reservation requests.
- Status history for orders and reservations. Managers and administrators can only move records through allowed status transitions.
- Persistent in-app order and reservation updates, with unread counts and per-user read controls.
- Administrative activity records for manager account changes and staff order, reservation, menu, and table changes.

## Local setup

Requirements: Node.js 20.19 or newer. MongoDB can run locally through the included `mongodb-memory-server-core` package or use a MongoDB URI.

From the `FSD Project/FSD Project` directory:

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` before starting. Set a random `SESSION_SECRET` with at least 32 characters. To enable the administrator desk, set `ADMIN_USERNAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`; the password is hashed before it is stored. The bootstrap account is created or updated at server startup. Leave Razorpay values empty to use the clearly labelled local demo payment flow, or configure Razorpay test credentials and a webhook secret.

Run the development servers:

```powershell
npm run dev
```

Open `http://127.0.0.1:5173`. The Vite server forwards `/api` calls to Express at `http://127.0.0.1:4000`.

For the single origin build served by Express:

```powershell
npm run build
npm start
```

Open `http://127.0.0.1:4000`.

The local MongoDB database stores files in the operating system temporary directory under `juniper-table-mongodb`. It is separate from the source tree and is reused between local starts. Set `MONGODB_URI` to use MongoDB Atlas or another MongoDB server.

## Public demo deployment

The repository root includes `render.yaml` for a Render web service. Connect this repository to Render as a Blueprint, then provide a hosted MongoDB URI and administrator username, email, and password when prompted. Render generates the session secret. In MongoDB Atlas, allow access from `0.0.0.0/0` under Network Access, because Render's free plan does not use fixed IP addresses. The app uses the Render service URL for same-origin API requests and serves the built client and API from one service.

The local temporary MongoDB database is not suitable for hosting. Use a hosted MongoDB database for persistent accounts, orders, and reservations. Render's free web services can spin down while idle, so the first request after inactivity may take longer.

## Staff access

1. Configure the initial administrator with the three `ADMIN_*` environment variables and start the app.
2. Open `/admin/login` and sign in with the configured username and password.
3. Use **Create a manager account** in the admin desk. The generated temporary password is displayed once. Share it through a secure channel.
4. The manager signs in at `/admin/login` with the issued username and temporary password, then chooses a new password before opening the manager desk.

The default restaurant tenant keeps its stable internal ID, `juniper-table`, so existing records remain intact. Public table booking also offers additional sample restaurants with separate sample table inventories.

## Payments

- `DEMO_ONLINE_PAYMENTS=true` is for local development and records a test payment with no charge. It is automatically disabled in production.
- Razorpay requires `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`. Configure the webhook for `payment.captured` and use the same secret in Razorpay.
- The app never receives or stores card numbers or CVV values.
- Razorpay refunds are not sent automatically. Rejected or cancelled captured orders show `refund_pending` so staff can process the refund with the provider.

## Tests

Run:

```powershell
npm test
```

The automated unit tests cover Indian Standard Time reservation intervals, overlap and lock slot calculations, and valid order and reservation status transitions. They do not replace database backed API, concurrency, payment provider, or browser end to end tests.

## API reference

See [docs/API.md](docs/API.md) for the implemented routes and request behavior.

## Current scope and follow up

This codebase remains a single restaurant site. It does not yet implement a multi restaurant marketplace or restaurant creation workflow. Reservation pre-orders are saved with the booking and payable at the restaurant; they do not use online checkout. Restaurant hours and restaurant profile editing, image uploads, automatic Razorpay refunds, and email/SMS notifications still need implementation or provider configuration. The seeded floor plan is marked illustrative and must be replaced with the restaurant's verified tables. Before public deployment, configure verified business data, HTTPS, production MongoDB, backups, Razorpay credentials, and a real email/SMS provider if needed.

# CarlTech M-Pesa payments

The public website remains on GitHub Pages. The `api` service handles Daraja STK Push requests, checks payment callbacks with the Daraja STK Query API, and stores orders in MongoDB. Only verified payments appear in the paid total. The private ledger is available at the backend URL followed by `/admin`; monthly CSV exports include all transaction statuses.

## Important before going live

- The payment flow is **not live** until the backend is deployed, its URL is added to `payment-config.js`, and Daraja production credentials are configured.
- The site accepts customer-entered whole-shilling amounts from KSh 1 to KSh 250,000. M-Pesa and Daraja transaction limits still apply.
- Set `MPESA_SHORTCODE` to the shortcode shown for your Daraja app's sandbox test credentials before sandbox deployment. A production Till/Paybill number is not necessarily the same as the sandbox shortcode. Confirm with Safaricom Daraja that the production shortcode is enabled for STK Push and the selected transaction type.
- Use Daraja sandbox credentials first. A production shortcode, consumer key, consumer secret, and Lipa Na M-Pesa passkey must be issued to the business by Safaricom. Never put these values in `index.html`, `payment-config.js`, GitHub, or customer-facing code.
- Render's paid always-on service plan is recommended for timely M-Pesa callbacks. The transaction database must have durable storage and backups; configure MongoDB Atlas network access for the Render service.

## Deploy the backend

1. Push the site and `api` folder to the GitHub repository. The root `render.yaml` describes the Render web service.
2. Create a MongoDB Atlas database and a dedicated database user. Allow connections from the deployed backend, then use its connection string for `MONGODB_URI`.
3. In Render, create the service from the repository's Blueprint (`render.yaml`). Keep `MPESA_ENV` as `sandbox` initially. Set:
   - `MONGODB_URI` and, if desired, `MONGODB_DB`.
   - `MPESA_SHORTCODE` from Daraja's sandbox test credentials. Use the merchant Till/Paybill only after switching to approved production credentials and confirming STK Push support.
   - A long unique `ADMIN_PASSWORD` (at least 16 characters).
   - `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, and `MPESA_PASSKEY` from Daraja.
4. Render generates `SESSION_SECRET` and `MPESA_CALLBACK_SECRET`. Keep them private. Set `MPESA_SHORTCODE` to the correct sandbox shortcode. The callback endpoint uses a SHA-256 token derived from the secret and the Render service URL.
5. Add the deployed API origin to `WEBSITE_ORIGINS` if it differs from the default Pages origin. Use only exact trusted website origins.
6. Confirm `https://<your-render-service>.onrender.com/health` returns `{"status":"ok"}`. Open `/admin` and sign in with `ADMIN_PASSWORD`.
7. Copy the backend origin into `window.CARLTECH_PAYMENT_API` in `payment-config.js` (no trailing slash), then publish the updated static site.
8. Test an STK request with the Daraja sandbox and confirm the callback, verification, status page, and private monthly CSV. Do not switch to production until a small live test confirms that the Till/Buy Goods setup is supported by your Daraja account.

## Local API tests

In PowerShell:

```powershell
Set-Location 'C:\Users\ADMIN\Desktop\CarlTech WEB\api'
npm install
npm test
```

For local development, copy `.env.example` to `.env`, fill the MongoDB and sandbox settings, add `http://localhost:5500` to `WEBSITE_ORIGINS`, and set `PUBLIC_API_URL` to the publicly reachable HTTPS backend URL for callbacks. A local-only URL cannot receive Safaricom callbacks.

## Data and access

- Payment requests retain customer/order details and M-Pesa status in MongoDB.
- Only one unresolved payment prompt is allowed per M-Pesa number. If a prompt remains unresolved, check it in M-Pesa before an administrator marks it as not paid; customers should not retry while payment status is uncertain.
- Only a successful Daraja STK query plus matching callback amount, payer phone, and receipt can mark a transaction paid.
- The admin ledger is password-protected, uses an HTTP-only session cookie, and is not exposed by the static GitHub Pages site.
- Customers see only the status and receipt for their unguessable payment request ID. Never share that ID as an admin credential.
- This setup records payments made through the website; it cannot automatically capture Till transactions customers make outside the STK prompt.

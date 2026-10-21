# Quote form Worker

Receives the quote form from reprobate-guitars.com and emails it (with photos) to reprobateguitars@gmail.com.

## One-time setup (Cloudflare dashboard)

1. **Email Routing**: open the domain in Cloudflare, go to Email, then Email Routing, and enable it. Accept the DNS records Cloudflare offers to add.
2. **Verify the destination**: under Destination addresses, add `reprobateguitars@gmail.com`. Cloudflare emails that inbox a verification link. It must be clicked or sending will fail.
3. **Deploy the Worker**: go to Workers & Pages, then Create, then import this GitHub repo. Set the root directory to `worker` and the deploy command to `npx wrangler deploy`. After that, every push to `main` redeploys it.
4. **Switch the form on**: in `form.js`, set `FORM_ENDPOINT` to `https://forms.reprobate-guitars.com/contact` and push.

Never put passwords or API keys in this repo. It is public. This Worker needs none.

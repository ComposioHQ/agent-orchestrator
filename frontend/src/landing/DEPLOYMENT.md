# Landing deployment

The landing site is a Next.js static export served by **GitHub Pages**, with
Cloudflare providing DNS, HTTPS, Worker routes, and the old-domain redirect.
The public origin is `https://useao.dev`.

`.github/workflows/deploy-landing.yml` builds `frontend/src/landing/out` and
deploys it on landing changes to `main`, every six hours, or a manual dispatch.
The schedule refreshes release/download data. The GitHub Pages custom domain
is a repository setting, not a Cloudflare Pages project or a build environment
variable. An Actions-based Pages deployment does not use a `CNAME` file.

## Domain configuration

- GitHub repository Settings → Pages → Custom domain: `useao.dev`.
- Cloudflare `useao.dev`: proxied apex A records pointing to GitHub Pages
  (`185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`).
- `www.useao.dev`: proxied CNAME to `untrivial-ai.github.io`, redirecting to
  `https://useao.dev`.
- Cloudflare `aoagents.dev`: keep apex and `www` DNS proxied. Redirect only
  those two hostnames to `https://useao.dev`, preserving the path and query
  string. Use a permanent **308** redirect to preserve the method/body for old
  form submissions as well as ordinary page navigation.
- Do not redirect other `aoagents.dev` subdomains: the cloud API, staging API,
  and other services have independent origins. Keep email DNS records and the
  Android application ID `aoagents.dev` unchanged.

The redirect rule's match expression is:

```text
(http.host in {"aoagents.dev" "www.aoagents.dev"})
```

Use a dynamic target `concat("https://useao.dev", http.request.uri.path)`, status
308, and enable **Preserve query string**.

These existing Workers must also have routes on the new domain; GitHub Pages
cannot execute the application's API handlers:

| Route | Worker |
| --- | --- |
| `useao.dev/api/cloud-waitlist*` | `ao-cloud-waitlist` |
| `useao.dev/api/testimonial-submissions*` | `ao-cloud-waitlist` |
| `useao.dev/hackathons/syndicate/pass*` | `ao-syndicate-pass-router` |

The deployed `ao-cloud-waitlist` Worker handles both form routes. The two
source examples under `cloudflare/` are separate handlers; do not overwrite
the combined live Worker with just one of them. Browser forms use same-origin
relative URLs.

## Cutover and verification

Prepare DNS and Worker routes first. Change the GitHub Pages custom domain,
verify HTTPS on `useao.dev`, then enable the old-domain redirect. Deploy the
updated static export so canonical metadata, sitemap, feeds, and public links
use the new origin.

```bash
cd frontend/src/landing
npm ci
npm run build
curl -I https://useao.dev/
curl -I 'https://aoagents.dev/docs/installation/?utm_source=migration-check'
curl -I 'https://www.aoagents.dev/docs/installation/?utm_source=migration-check'
curl -I https://useao.dev/hackathons/syndicate/pass/
curl -i -X OPTIONS https://useao.dev/api/cloud-waitlist/
curl -i -X OPTIONS https://useao.dev/api/testimonial-submissions/
```

Expect the landing page and pass to return 200, old-domain requests to return
308 with the same path/query on `useao.dev`, and API preflights to reach the
Workers. Verify `/sitemap.xml`, `/robots.txt`, and page canonical metadata refer
to `useao.dev`. Check HTTP and HTTPS and the `www` variants without following
redirects first, then follow them to detect loops. Avoid submitting real form
data as a deployment check.

If cutover fails, disable the old-domain redirect and restore the GitHub Pages
custom domain to `aoagents.dev`. Keep the original DNS and Worker routes until
the migration is verified so that rollback remains available.

References: [GitHub Pages custom domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site),
[Cloudflare redirect settings](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/settings/).

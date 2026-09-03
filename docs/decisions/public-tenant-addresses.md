# ADR: Public tenant addresses — a separate registrable domain, a workspace subdomain, and customer-owned domains on Fly certificates

- **Status:** Accepted (2026-09-03)
- **Story / Subtask:** MOTIR-3878 (Customer-owned addresses for a public project) ·
  Subtask MOTIR-4206
- **Supersedes / superseded by:** none. It **closes** `public-surface-hosts.md`
  §4's reversal condition (AMENDMENT 5 of that record, written by this card) and
  is the record `public-surface-hosts.md` §9 named as owning per-tenant and
  custom domains.
- **Consumed by:** MOTIR-4208 (buy the base domain), MOTIR-4209 (the address
  store), MOTIR-4210 (the Fly certificates adapter), MOTIR-4211 (the settings
  design), MOTIR-4212 (the AUP clause), MOTIR-4213 (the PSL submission),
  MOTIR-4214 (the runtime configuration), MOTIR-4215 (claim/rename the
  subdomain), MOTIR-4216 (the customer-domain lifecycle), MOTIR-4217 (the host
  contract), MOTIR-4218 (CORS + return target), MOTIR-4219 (the certificate
  status job), MOTIR-4220 (the host router), MOTIR-4221 / MOTIR-4229 (the
  settings pane), MOTIR-4222 (the canonical), MOTIR-4228 (the entitlement).

> **No application behaviour, schema or copy ships in this record.** What it
> freezes is what makes the store, the services, the router and the settings pane
> buildable — and, per the convention `work-item-type-taxonomy.md` set, every
> load-bearing fact is pinned in a table so each consumer implements against one
> authoritative source rather than re-deciding.

---

## Context

`public-surface-hosts.md` moved the public surface off `app.motir.co` and onto
`motir.co`, rendered by `motir-marketing` over `motir-core`'s public contract.
That record's §4 accepted a **deviation it named as a deviation**: tenant-authored
content would sit on `motir.co`, the _parent domain_ of the host holding the
session, where every mirror in the category puts tenant content on a **separate
registrable domain**. It accepted the residual exposure on one condition — the
session cookie stays host-only — and it wrote a reversal condition naming **this
story** as where the arrangement is revisited, for two reasons quoted verbatim
from §4:

> 1. Per-tenant addressing multiplies the exposure — one origin of user content
>    becomes one per customer, all under the session's registrable domain.
> 2. A base on a subdomain forces three-level addresses (`acme.open.motir.co`),
>    which a `*.motir.co` certificate does not cover. A separate registrable
>    domain gives `acme.motir.build` under one wildcard.

So this record has two jobs at once. It answers the ten questions the story's
other cards each encode an answer to, and in answering Q1 it discharges §4's
reversal condition — turning an accepted risk back into the arrangement every
mirror chose.

### How each answer is grounded

Every question below is answered from **rung 1** (the mirror product, _fetched_
for this record — the observation and its URL are quoted) and **rung 2** (shipped
code on `origin/main`, cited by path), per the decision-authority ladder. Where a
rung-1 reading came back **different from what this card's own brief asserted**,
the reading wins and the difference is recorded rather than quietly absorbed —
see Q7, which is the one place that happened.

---

## §1 — The decisions, in one table

| #       | Question                                               | Decision                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q1**  | Which base domain do tenant subdomains hang off?       | A **separate registrable domain**, never a subdomain of `motir.co`. The exact string is **configuration, not code** — MOTIR-4208 buys one from the ranked, RDAP-checked shortlist in §2.                 |
| **Q2**  | What does a subdomain NAME?                            | The **WORKSPACE**. `acme.<base>/<identifier>`.                                                                                                                                                           |
| **Q3**  | What does a customer domain name?                      | **ONE public project, at the domain's root.**                                                                                                                                                            |
| **Q4**  | Which customer hostnames, and how is ownership proven? | **Any hostname the customer can point** — `CNAME` for a subdomain, `A`/`AAAA` for an apex. Ownership proven by a **`TXT` record** at `_motir-verify.<host>` BEFORE a certificate is requested.           |
| **Q5**  | Who issues and renews the certificate?                 | **Fly**, per hostname, on the **`motir-marketing`** app, driven from `motir-core` over Fly's REST certificates API. One **wildcard** `*.<base>` covers every tenant subdomain.                           |
| **Q6**  | The canonical rule                                     | **Exactly one PRIMARY address per project.** Every other address `301`s to it; `canonical`, `og:url`, JSON-LD `@id`, the sitemap and the Atom feed all name the primary.                                 |
| **Q7**  | Rename, and the reserved set                           | An old subdomain **keeps redirecting and is never released**. Renames capped at **5**. The reserved-name set is a constant in code, enumerated in §8.                                                    |
| **Q8**  | The tier gate                                          | A new `EntitlementKind` **`custom_domains`** and **`maxCustomDomains`** on `PmEntitlements`, read through `entitlementsService`. **Tenant subdomains are free on every tier; custom domains are gated.** |
| **Q9**  | The open-core line                                     | The whole capability is **cloud-only** behind `isCloud()`.                                                                                                                                               |
| **Q10** | Branding on a customer address                         | **The public chrome stays Motir's on every address.** No white-label in this story — a decision with a reversal condition, not a deferral.                                                               |

---

## §2 — Q1: which base domain do tenant subdomains hang off

### The decision

**A separate registrable domain.** Not `open.motir.co`, not any subdomain of
`motir.co`, now or as a convenience later.

**The exact string is NOT frozen by this record**, and that is deliberate rather
than an omission. The base domain reaches the code in exactly one way — the
`MOTIR_PUBLIC_TENANT_DOMAIN` configuration variable of §10 — so **no module
contains it**, no test asserts it, and changing it is a Fly secret and a build
arg rather than a pull request. What this record fixes is the SHAPE the string
must have; MOTIR-4208 buys one and MOTIR-4214 configures it.

### The shape the string must have

1. **A registrable domain of its own** — one label under a public suffix, so that
   a browser treats `<tenant>.<base>` and `app.motir.co` as different _sites_,
   not merely different origins.
2. **Two levels, not three** — `acme.<base>`, so that a single wildcard
   certificate `*.<base>` covers every tenant. A three-level address
   (`acme.open.motir.co`) needs a certificate `*.open.motir.co` that
   `*.motir.co` does not cover, which is §4's second reason verbatim.
3. **Submittable to the Public Suffix List** (MOTIR-4213), which is the later
   refinement that adds isolation _between tenants_. §4 is explicit that nothing
   here waits on it: _"A separate domain gets the isolation immediately; PSL
   listing is a later refinement."_
4. **Registrable at Spaceship**, the registrar that already holds `motir.co`
   (`marketing-site-hosting.md` §3, nameservers `launch1.spaceship.net` /
   `launch2.spaceship.net`). No new vendor, and therefore no subprocessor row —
   a registrar is not a processor of personal data on our behalf, and §5 of that
   record's reasoning about _adding_ a vendor is what this avoids.

### The ranked shortlist, with its RDAP readings

Availability was **read, not assumed**. RDAP is the registry's own authoritative
answer: `404` is _no such registration_, `200` is _registered_.

```
$ curl -sL -o /tmp/rdap.json -w '%{http_code}' \
    -H 'Accept: application/rdap+json' https://rdap.org/domain/<name>
```

`.com` candidates were read from Verisign's registry endpoint directly, because
`rdap.org` rate-limits (`HTTP 429`) after a handful of queries and a `429` is not
an availability reading:

```
$ curl -sL -o /tmp/rdap.json -w '%{http_code}' \
    -H 'Accept: application/rdap+json' \
    https://rdap.verisign.com/com/v1/domain/<name>
```

All readings taken **2026-09-03**:

| rank  | candidate                                   | RDAP                             | reading         | why it is ranked here                                                                                                                                                                                                    |
| ----- | ------------------------------------------- | -------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | `motir.site`                                | `404`                            | **available**   | The exact rung-1 shape: Notion publishes tenant sites on `notion.site`. `acme.motir.site/ROADMAP` reads as _a site published with Motir_, which is what the page is.                                                     |
| **2** | `motir.build`                               | `404`                            | **available**   | The candidate `public-surface-hosts.md` §4 itself used to illustrate the decision, and on-brand for build-in-public.                                                                                                     |
| **3** | `motirhq.com`                               | `404`                            | **available**   | The conservative option — a `.com` carries no TLD reputation question anywhere, at the cost of a longer, less legible address.                                                                                           |
| 4     | `motir.page`                                | `404`                            | available       | HSTS-preloaded (Google TLD): a browser will not speak HTTP to it at all, which is a genuine plus for a domain hosting tenant content. Reads narrower than `.site`.                                                       |
| 5     | `motir.pub` · `motir.space`                 | `404`                            | available       | Both free; neither has a mirror precedent nor a brand argument.                                                                                                                                                          |
| —     | `motir.dev` · `motir.app`                   | `404`                            | available       | **Not recommended.** Both read as _developer tooling_ / _the application_, and `app.motir.co` already answers for the application. An address whose name contradicts what it serves is a permanent tax on explaining it. |
| —     | `motir.com`                                 | `200`, registered **2006-04-22** | **unavailable** | Recorded so the next reader does not spend the query.                                                                                                                                                                    |
| —     | `motir.works` · `motir.zone` · `motir.host` | `429`                            | **not read**    | `rdap.org` rate-limited these. They are not asserted available or unavailable.                                                                                                                                           |

**The recommendation is `motir.site`**, on the ladder: rung 1 is the default
where the mirror implements the behaviour, and Notion's is the closest mirror to
what this serves (published tenant pages, not status pages or issue boards).
`motir.build` is the runner-up and the choice between the two is a **brand call
for Yue at purchase time** — MOTIR-4208 buys whichever, and nothing in the code
changes either way.

### Rejected alternatives

| alternative                                                        | why not                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A subdomain of `motir.co`** (`acme.open.motir.co`)               | §4's reversal condition rejects it in advance on two independent grounds: it multiplies user-content origins under the session's own registrable domain, and it forces a three-level address no `*.motir.co` certificate covers. Adopting it would be re-taking the decision §4 asked this record to revisit, in the direction §4 already argued against. |
| **`motir.co` with a path prefix per tenant** (`motir.co/t/acme/…`) | This is what ships today (`/p/<identifier>`) and it is precisely the arrangement the story exists to replace. It gives the customer no address of their own, so it answers none of Q2–Q4.                                                                                                                                                                 |
| **A per-tenant domain we register on the customer's behalf**       | Motir becomes the registrant of names customers think they own — a renewal obligation, a transfer dispute and a trademark exposure per customer, for a capability Q3's customer-domain path already delivers with the customer as registrant.                                                                                                             |

---

## §3 — Q2: what a subdomain NAMES

### The decision

**A subdomain names a WORKSPACE.** The address of a public project is
`acme.<base>/<identifier>`, where `acme` is the workspace's claimed subdomain and
`<identifier>` is the project's key.

**The workspace root `acme.<base>/`** lists that workspace's public projects — or
renders the single project directly when the workspace has exactly one.

### Why the workspace and not the organization or the project

**Rung 2 settles it.** `Project.identifier` is unique **per workspace**, not per
organization — `prisma/schema.prisma` carries `@@unique([workspaceId,
identifier])` on `Project` (line 1543) and the identical shape on
`ProjectKeyAlias` (line 1748). So:

- `acme.<base>/PROD` with `acme` a **workspace** is unambiguous by construction.
- `acme.<base>/PROD` with `acme` an **organization** is not: two workspaces of one
  organization may each hold a project keyed `PROD`, and the address would need a
  second segment to disambiguate — which is the path-prefix scheme Q1 rejected,
  reintroduced one level down.

**`Organization.slug` stays exactly as `organization-url.md` §3 left it** — the
column, its `@unique`, the create-time slugify and `organizationRepository.findBySlug`
— _"internal substrate from now on, not a user-facing value."_ This record does
not touch it and does not make it user-facing.

**`organization-url.md`'s reversal condition is NOT triggered**, and this is the
one line that record's reversal asks for: it fires on _organization-addressable
URLs_ — re-basing the **authed** application's routes under a tenant segment and
retiring the cookie as the source of truth. Nothing here re-bases an authed
route; the addresses in this record are read-only public surfaces served by
`motir-marketing`, and the active organization is still resolved from the cookie
exactly as it is today.

### Rung 1

| mirror         | what it does                                                                                                       | source                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Notion**     | A workspace claims a `notion.site` domain; pages hang under it.                                                    | `https://www.notion.com/help/connect-a-custom-domain-with-notion-sites`                        |
| **Canny**      | Every portal starts at a **company** subdomain — the default shape is `company.canny.io` — with boards underneath. | `https://help.canny.io/en/articles/1355038-setting-up-your-custom-domain` (read 2026-09-03)    |
| **Statuspage** | The default is `mycompany.statuspage.io` — the _company_, not the page.                                            | `https://support.atlassian.com/statuspage/docs/set-a-custom-domain-and-ssl/` (read 2026-09-03) |

All three name a **tenant**, and hang content underneath. None names a single
document at the subdomain level.

---

## §4 — Q3: what a CUSTOMER domain names

### The decision

**A customer domain names ONE public project, and serves it at the domain's
root.** `roadmap.acme.com/` is that project's overview; `roadmap.acme.com/board`
is its board.

So an address is exactly one of two shapes, and the store (MOTIR-4209) holds both
in one table:

| shape                                  | example                   | names                                |
| -------------------------------------- | ------------------------- | ------------------------------------ |
| **workspace subdomain + project path** | `acme.motir.site/ROADMAP` | a workspace; the project is the path |
| **customer domain at its root**        | `roadmap.acme.com/`       | one project                          |

### Why the root, and why one project

Rung 1 is unanimous: a Statuspage page and a Productboard portal each answer at
the root of the domain the customer pointed. A customer who buys
`roadmap.acme.com` means _this domain is our roadmap_; serving it at
`roadmap.acme.com/ROADMAP` would repeat the project's name in a path the customer
already encoded in the hostname.

**One project, not a workspace**, because the two directions are not symmetric: a
customer who wants several projects on their own domain can point several
hostnames (`roadmap.acme.com`, `status.acme.com`), each naming one project — which
is what the mirrors do — whereas a workspace-rooted customer domain would need a
path segment and would make the customer's own domain look like ours.

### Consequence for the router

The `motir-marketing` host router (MOTIR-4220) therefore resolves a host to a
**subject** that is either a workspace (render its project list at `/`, and
`/<identifier>/…` beneath) or a single project (render its pages at `/` directly).
That is one branch, taken once per request, and it is the reason MOTIR-4217's
contract returns the subject rather than just an id.

---

## §5 — Q4: which customer hostnames are accepted, and how ownership is proven

### The decision — which hostnames

**Any hostname the customer can point at the `motir-marketing` app.** No
restriction to subdomains, and no restriction to one hostname per domain.

| customer's hostname                  | record they create                     | why                                                                                                                                                                                                                                  |
| ------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a **subdomain** (`roadmap.acme.com`) | `CNAME` → the app's Fly hostname       | Fly: _"CNAME records work well for subdomains (like `www.example.com` or `app.example.com`). A CNAME points your custom domain at a unique `.fly.dev` hostname for your app."_                                                       |
| an **apex** (`acme-roadmap.com`)     | `A` + `AAAA` → the app's dedicated IPs | Fly: _"Use A and AAAA records for most direct connections to your app. These records point your domain directly to your app's IP addresses."_ This is the same shape `marketing-site-hosting.md` §3 already relies on at `motir.co`. |

**An apex is accepted rather than refused**, and Statuspage is the mirror we
deviate from here — its help page recommends _"that you make this a dedicated
domain (e.g. `www.mycompanystatus.com`)"_. The concrete use case that earns the
deviation: a customer who has bought a domain **for** their roadmap will point its
apex, and `marketing-site-hosting.md` §3 has already proven the `A`/`AAAA` shape
works against this exact Fly app. Refusing it would be refusing the case the
capability is bought for.

> **The apex path carries a real, stateful cost — recorded because it is not
> obvious.** A customer apex is pinned to the `motir-marketing` app's **IP
> addresses**, not to a name we control. If those addresses ever change, every
> customer apex breaks at once and the fix is on the customer's side. A
> subdomain pointed by `CNAME` does not have this property. The settings pane
> (MOTIR-4229) therefore presents `CNAME` as the recommended shape and the apex
> as the one that needs the customer's DNS to be re-edited if we ever move — and
> `A`/`AAAA` values are read from `fly ips list` at provisioning, never
> hardcoded. (`marketing-site-hosting.md` §3's own table already reads them that
> way.)

### The decision — how ownership is proven

**A `TXT` record at `_motir-verify.<host>`, carrying a per-address token, must be
present BEFORE a certificate is requested.**

**Rung 1 is split and we follow Notion.** Notion requires exactly this — its
instructions are _"Next, add a TXT record for the domain. You can copy the record
name and value for easy use"_, at the name `_notion-dcv.[subdomain]`. Canny
relies on the `CNAME` alone; its instructions ask only for a record pointing at
`cname.canny.io`.

**Why the TXT is worth its friction**, which is the half a reader will question:
without it, **whoever points a hostname at us first claims it**. Anyone can create
`motir.acme.com CNAME <our app>` for a domain they do not control; if pointing is
the whole proof, they have taken a name inside somebody else's domain and we have
issued a certificate for it. The TXT is the only step that requires **write access
to the zone**, which is the thing ownership actually means. It costs the customer
one extra record, once, at add time.

### The order of operations, fixed here because three cards implement it

1. Customer adds the hostname in settings → we store it `unverified` with a freshly
   minted token.
2. Customer creates `_motir-verify.<host> TXT "<token>"`, and the record they must
   create for traffic (`CNAME` or `A`/`AAAA`).
3. Customer presses **Verify** → we resolve the `TXT`. Match → `verified`.
4. **Only then** do we `POST` the certificate request to Fly. A certificate is
   never requested for an unverified hostname — which also keeps us clear of
   Let's Encrypt's per-registered-domain issuance limits for names we do not own.

---

## §6 — Q5: who issues and renews the certificate

### The decision

**Fly issues and renews, per hostname, on the `motir-marketing` app, driven from
`motir-core` over Fly's REST certificates API.**

`motir-marketing` is the app the addresses point at (`fly.toml`: `app =
"motir-marketing"`, org `moooon`, region `iad`), so it is the app that must hold
the certificates. `motir-core` is where the store, the lifecycle and the settings
pane live, so it is what drives the API. The adapter (MOTIR-4210) sits **beside**
`lib/orchestrator/adapters/fly/flyMachines.ts`, not inside it — a different Fly
app, a different token, a different question.

### The endpoints, pinned

Read from `https://fly.io/docs/networking/custom-domain-api/` on **2026-09-03**:

| act                   | call                                                     |
| --------------------- | -------------------------------------------------------- |
| request a certificate | `POST /v1/apps/{app_name}/certificates/acme`             |
| check its state       | `POST /v1/apps/{app_name}/certificates/{hostname}/check` |
| remove it             | `DELETE /v1/apps/{app_name}/certificates/{hostname}`     |

The check answers with `hostname`, `configured`, `acme_requested`, `status`,
`dns_provider`, `rate_limited_until`, `certificates`, `validation`,
`dns_requirements`, `validation_errors` and `dns_records`; `validation` carries
`dns_configured`, `alpn_configured`, `http_configured` and
`ownership_txt_configured`. `dns_requirements` carries an `acme_challenge` object
with a `name` (e.g. `_acme-challenge.example.com`) and a `target` for CNAME
delegation. **MOTIR-4210 maps those fields to our own states and MOTIR-4219 polls
this endpoint** — neither invents a state machine, and neither reads a field this
table does not name without adding it here.

The base URL is Fly's Machines API host, the one `flyMachines.ts` already uses:
`https://api.machines.dev/v1`.

### The wildcard, and who cuts it

**One wildcard certificate `*.<base>` covers every tenant subdomain**, so claiming
a subdomain issues no certificate at all — it writes a row. Fly's docs are
explicit that _"Wildcard certificates are supported"_, that a wildcard hostname
must be URL-encoded (`%2A.example.com`), and that the DNS-01 challenge is the one
to use _"when you need a wildcard certificate, or when you want to generate the
certificate before directing traffic to your app"_ — which needs an
`_acme-challenge` CNAME delegation on the base domain.

**A human cuts the wildcard once, with `fly certs add`** (MOTIR-4208). It is not
in the adapter's surface, because it happens once per base domain rather than once
per address, and it happens before any code exists.

### Renewal

Fly renews. We do not hold a renewal clock, and the only renewal fact this record
pins is Fly's own: _"certificate renewals don't count against your Certificates
per Registered Domain limit."_ **What we own is SURFACING the state, not
maintaining it** — MOTIR-4219 refreshes pending and issued certificates from the
check endpoint and records the last check, so an `expired` or `revoked` state
becomes something the customer sees rather than something a visitor discovers.

> **⚠️ This is a claim about a RUNNING system, and MOTIR-4207 is what discharges
> it.** Nothing in this record proves Fly will issue a certificate for a hostname
> we do not own on an app we do — the docs say so, and docs are not the platform.
> That is exactly why the story carries a `verification` task **outside** this
> container (MOTIR-4207: _the first customer domain issues a certificate on the
> live `motir-marketing` Fly app, read from the platform_). No card inside this
> story may report the certificate path proven; the deploy is a later clock.

### Rejected alternatives

| alternative                                           | why not                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare for SaaS**                               | Purpose-built for exactly this and rejected on `marketing-site-hosting.md` §5's reasoning: it is a **third vendor** in the request path for tenant content, which is a **subprocessor row** on a published legal document plus a verified transfer basis under `production-service-stack.md` Q8 — a real legal change to buy a capability the platform we already pay for provides. |
| **A self-run ACME client** (Certbot / `lego` / Caddy) | A second certificate system beside the one the platform already operates, with its own storage, its own renewal clock, its own failure mode and its own on-call. Fly terminates TLS for this app; a certificate we issue would have nowhere to be installed without also taking over termination.                                                                                   |
| **A single wildcard covering customer domains too**   | Not expressible — a wildcard is scoped to one registrable domain, and customer domains are by definition domains we do not control. One certificate per customer hostname is not a choice.                                                                                                                                                                                          |

---

## §7 — Q6: the canonical rule

### The decision

**Exactly one address per project is PRIMARY.** Every other address for the same
page returns a **`301`** to the primary, and `canonical`, `og:url`, the JSON-LD
`@id`, the sitemap entry and the Atom feed's links all name the primary — never
the address the request arrived on.

**The default primary:**

| state                              | primary                                                |
| ---------------------------------- | ------------------------------------------------------ |
| no subdomain claimed               | `motir.co/p/<identifier>` — today's address, unchanged |
| a workspace subdomain claimed      | `<workspace>.<base>/<identifier>`                      |
| a customer domain **made primary** | that customer domain's root                            |

A customer domain becomes primary **only by an explicit act** — a _make primary_
control — never by being added. Adding a domain is a technical step that can be
half-finished (unverified, certificate pending); promoting the canonical is a
publishing decision, and conflating them would move a project's canonical to an
address that does not yet serve traffic.

### Rung 1

Canny is the mirror here and the wording is theirs: pressing **make primary** on a
custom domain is what makes Canny treat it as **the canonical source**, and once a
primary custom domain is set Canny uses that URL for public links and email
notifications rather than the `canny.io` one
(`https://help.canny.io/en/articles/1355038-setting-up-your-custom-domain` and
Canny's own feedback board, read 2026-09-03). That second half is the part worth
copying and easy to miss: **the primary is not only a `<link rel="canonical">`,
it is the address the product itself emits everywhere** — so MOTIR-4222 changes
what `publicProjectUrl()` produces, not merely what a `<head>` says.

### ⚠️ The consequence for §4's exposure, stated because it is the good news

Once a project's primary is off `motir.co`, **`motir.co/p/<identifier>` for that
project becomes a redirect** — it serves no tenant content at all. So adopting
per-tenant addresses does not merely _avoid_ multiplying §4's exposure; for every
project that claims an address it **removes** the exposure, one project at a time.
The `motir.co/p/*` route survives for projects that have claimed nothing, which is
the default and stays free.

### Rejected alternatives

| alternative                                                               | why not                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Serve every address `200`, with a `canonical` pointing at the primary** | It is what a naive reading of "canonical" suggests, and it is worse in two measurable ways: a `canonical` is a **hint** a crawler may ignore, and every non-primary address stays a live, indexable, screenshot-able copy of the tenant's content. A `301` is an instruction, and it collapses the duplicate. |
| **The address the request arrived on is canonical**                       | Two addresses then compete for the same page in exactly the way Canny's _"canonical source"_ framing exists to prevent, and a customer's own domain would rank against ours.                                                                                                                                  |

---

## §8 — Q7: rename, and the reserved-name set

### The decision — the old address is never released

**A renamed subdomain keeps redirecting, permanently, and is never released for
another workspace to claim.**

**Rung 2 has the precedent in-repo**: `ProjectKeyAlias` (`prisma/schema.prisma`
line 1738) is exactly this shape for project keys — its own comment says a retired
key's row _"reserves the key workspace-wide — the SAME uniqueness shape
`project.identifier` carries — so a rename's collision"_ behaves identically to a
live key's. A retained subdomain alias is that pattern one level up, and
MOTIR-4209 models it the same way: a retained alias occupies the uniqueness slot,
so nobody else can claim it and a lookup still resolves it.

**Rung 1 confirms the redirect half.** Atlassian: _"We'll store the previous URL
in your site's history and redirect all links to the new URL"_
(`https://support.atlassian.com/organization-administration/docs/update-a-product-url/`,
read 2026-09-03).

### The rename cap: **5**

> **⚠️ A rung-1 figure in this card's own brief was WRONG, and the correction is
> recorded rather than absorbed.** MOTIR-4206's description asserts _"Atlassian
> caps at 3 — decide a number"_. Read from the cited surface on **2026-09-03**,
> Atlassian's documented cap is **15**: _"You can update the subdomain up to 15
> times."_ The card's own instruction (decide a number) is unaffected, but the
> number it offered as grounds is not the mirror's. Filed as a planning bug and
> amended on the card.

**We cap at 5**, deviating from the mirror's 15 with a concrete use case, as the
ladder requires: **every rename permanently burns a name in a shared namespace**.
A workspace that renames 15 times permanently reserves 15 subdomains it does not
use. On `atlassian.net` that namespace is enormous and a decade old; ours will be
new and small, and the reserved-name set below already carves a chunk out of it.
Five is enough for a real rebrand plus mistakes, and it is a **constant one line
changes** if it turns out to bind anyone.

### The reserved-name set

A **constant in code**, enumerated here so the service (MOTIR-4215) and the ADR
cannot drift. A claim is refused when the requested label:

1. **Is one of Motir's own hostnames or a hostname a reader would read as ours:**
   `www` · `app` · `api` · `mail` · `smtp` · `imap` · `mx` · `ns` · `ns1` · `ns2` ·
   `status` · `docs` · `help` · `support` · `blog` · `admin` · `assets` · `cdn` ·
   `static` · `img` · `media` · `motir` · `moooon` · `staging` · `preview` · `dev` ·
   `test` · `internal` · `dashboard` · `account` · `accounts` · `billing` ·
   `login` · `signin` · `signup` · `auth` · `oauth` · `sso` · `webhook` ·
   `webhooks` · `ai` · `gateway`.
2. **Is an impersonation risk**: `security` · `abuse` · `postmaster` · `hostmaster` ·
   `webmaster` · `noreply` · `no-reply` · `official` · `verify` · `verification` ·
   `payment` · `payments` · `invoice` · `legal` · `privacy` · `terms`.
3. **Is structurally reserved**: any label beginning `_` (the underscore space
   `_acme-challenge` and `_motir-verify` live in), any label beginning `xn--`
   (punycode, which a homograph attack arrives as), and `motir-*` as a prefix.
4. **Fails the shape rule**: shorter than **3** characters, longer than **63**
   (the DNS label limit), not matching `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, or
   containing `--` at positions 3–4 (the punycode-lookalike form).

The single-character and two-character exclusion is the minimum-length rule
stated as a rule rather than a list: short labels are the scarcest and the most
valuable, and they are the ones to hold back deliberately rather than hand to
whoever signs up first.

> `_motir-verify` and `_acme-challenge` are covered by rule 3 rather than by being
> listed, because rule 3 is total over the underscore space and a list is not.

---

## §9 — Q8: the tier gate

### The decision

**A new `EntitlementKind` `custom_domains`, and a new `maxCustomDomains` field on
`PmEntitlements`** (`lib/billing/entitlements.ts`), asserted through
`entitlementsService` exactly as every other §4 cap is.

**Tenant subdomains are FREE on every tier. Custom domains are gated.**

| tier         | `maxCustomDomains` (provisional) |
| ------------ | -------------------------------- |
| `free`       | `0`                              |
| `scaled`     | `5`                              |
| `enterprise` | `null` (unlimited)               |
| `meta`       | `null` (unlimited)               |

### ⚠️ The VALUES are `billing-tiering.md`'s, not this record's

This story **ships the capability and the gate it reads, not the price.** The four
numbers above are a provisional seed so MOTIR-4228 has something total to write;
changing them is a one-line edit in `entitlements.ts` with **no migration**,
exactly as `PM_ENTITLEMENTS`'s own comment says (_"a tunable seed policy — a later
change is a one-line edit here, no schema migration"_). **`billing-tiering.md` §4
owns the numbers, and Stories 8.1 / 8.6 are where they are set.** A card that
wants to argue about `5` is arguing with that record, not this one.

### The shape MOTIR-4228 implements, pinned

Rung 2, read from `lib/services/entitlementsService.ts`: every count cap is the
same five lines, and the custom-domain assert is the sixth instance of them, not a
new pattern.

```ts
async assertWithinCustomDomainCap(
  organizationId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (!isCloudBilling()) return;
  await lockOrgRowOrRefuse(organizationId, tx);
  const { maxCustomDomains } = entitlementsFor(await tierForOrgInTx(organizationId, tx));
  if (maxCustomDomains === null) return;
  const current = await publicAddressRepository.countCustomDomainsByOrganization(organizationId, tx);
  if (current >= maxCustomDomains) {
    throw new EntitlementExceededError('custom_domains', { limit: maxCustomDomains, usage: current });
  }
}
```

Three properties of that shape are **required, not stylistic**, and the module's
own header says why: the org row is locked `FOR UPDATE` before the count is read
(a count-then-write guard with no lock fails under a warm pool), the assert runs
**inside the same transaction as the create it guards**, and it returns early when
`isCloudBilling()` is false so a self-hosted build never consults a cap. `free: 0`
means the assert refuses on the **first** domain, which is what makes
`EntitlementExceededError('custom_domains', …)` the upgrade prompt's trigger rather
than a special-cased empty state.

### Rung 1 — the whole category gates this, and only this

| mirror           | subdomain                            | custom domain                                                                                                          |
| ---------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Notion**       | included                             | **paid add-on** — _"This feature is only available on paid plans"_, `$10 per month` (`$8` annually) on top of the plan |
| **Statuspage**   | included (`mycompany.statuspage.io`) | **excluded from Free** — _"Public pages can use a custom domain, except for pages on the Free plan"_                   |
| **Canny**        | included (`company.canny.io`)        | paid                                                                                                                   |
| **Productboard** | included                             | on a _"Host Portal on your domain"_ toggle                                                                             |

All read 2026-09-03. Nobody gates the tenant subdomain, and everybody gates the
custom domain — which is the split this record adopts unchanged.

---

## §10 — The configuration this record decides

Named here so MOTIR-4214 can run **before any code lands**, which is the whole
point of deciding it in a document.

| variable                          | app               | kind                                                        | value                                                        | read by                                                                            |
| --------------------------------- | ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `MOTIR_PUBLIC_TENANT_DOMAIN`      | `motir-core`      | **runtime secret / env**                                    | the base domain (`motir.site`)                               | the address store, the subdomain service, the host contract, the canonical builder |
| `NEXT_PUBLIC_MOTIR_TENANT_DOMAIN` | `motir-marketing` | **`NEXT_PUBLIC_*` BUILD ARG**, in `fly.toml` `[build.args]` | the same base domain                                         | the host router, the per-host canonical / sitemap / robots                         |
| `FLY_CERTS_TOKEN`                 | `motir-core`      | **runtime secret**                                          | a Fly API token **scoped to the `motir-marketing` app only** | the certificates adapter, the certificate status job                               |
| `FLY_CERTS_APP`                   | `motir-core`      | env                                                         | `motir-marketing`                                            | the certificates adapter                                                           |

**Two of those four rows carry a rule rather than a value.**

- **`NEXT_PUBLIC_MOTIR_TENANT_DOMAIN` is a BUILD ARG, not a Fly secret**, and
  setting it as a secret would silently do nothing. `motir-marketing`'s
  `lib/siteOrigin.ts` states the reason for exactly this class of variable:
  _"Every consumer here is statically rendered … so the value is baked into the
  output by `next build` exactly as `NEXT*PUBLIC*_`is — setting it as a Fly
SECRET would do nothing."* It travels in`fly.toml`'s `[build.args]`, beside
`NEXT_PUBLIC_MOTIR_APP_ORIGIN`.
- **`FLY_CERTS_TOKEN` is scoped to `motir-marketing` and has NO fallback to a
  general Fly token.** This follows `flyMachines.ts`'s rule verbatim —
  _"`FLY_FLEET_API_TOKEN`, never the token `motir-ai` or `motir-gateway` deploy
  with … a token that could reach the production org is the one thing that could
  quietly undo that, so the config accessor names a distinct variable and there is
  no fallback to a general Fly token."_ The reason transfers exactly: this token's
  only job is to add and remove certificates on one app, and a deploy-capable
  token in a code path driven by customer input is a much larger grant than the
  path needs.
- **Config is read at CALL time, never at module load** — `appAuth.ts`'s contract,
  restated in `flyMachines.ts`: a self-hosted deploy that never provisions
  certificates must not crash on boot; it must simply be unable to reach the path.

---

## §11 — Q9: the open-core line

**The whole capability is cloud-only.** `public-surface-hosts.md` §5 already
decided that public projects are a cloud capability and that with `MOTIR_CLOUD`
unset the feature is **ABSENT, not hidden** — and a build with no public projects
has nothing to address.

So there is nothing new to decide, only something to inherit consistently:

- Every new `app/api/public/*` route added by this story opens with
  `publicSurfaceUnavailable()`, as its first statement, before the rate-limit
  guard and before any session read — `lib/publicProjects/cloudGate.ts`. The
  totality test `tests/api/public/cloud-gate-totality.test.ts` enumerates the
  surface from the filesystem, so a route that forgets is caught rather than
  reviewed for.
- The **Public address settings pane** (MOTIR-4221 / MOTIR-4229) and its rail entry
  are gated on `isCloud()`, and a self-hosted build shows no entry — not a
  disabled one.
- The certificate status job (MOTIR-4219) does not schedule on a non-cloud build.

---

## §12 — Q10: branding on a customer address

**The public chrome stays Motir's on every address**, including a customer's own
domain. A page at `roadmap.acme.com` is visibly a Motir page.

**This is a DECISION with a reversal condition, not a deferral**, which is why it
appears here rather than in §14. Notion couples the two — buying its custom-domain
add-on is also what unlocks removing Notion's branding from that domain — so the
coupling is a known product shape and this record declines it on purpose:
white-labelling is a second capability (which surfaces carry the mark, what
replaces it, what a customer may upload, and the abuse question of an unbranded
Motir-hosted page on a domain we do not control), and bundling it into an
addressing story would put a brand system on the critical path of a URL.

**Reversal condition:** a paying customer asks for it, or a deal is lost naming it.
Adopting it is then a per-address branding record plus an asset pipeline — an
epic, not a settings toggle.

---

## Consequences — §13: what this record binds, card by card

| card                                                  | what it inherits from here                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-4208** (buy the domain, manual)               | §2's shape rules and ranked shortlist; the RDAP readings and the command that produced them; Spaceship as registrar; `fly certs add` for the wildcard `*.<base>`, and the `_acme-challenge` CNAME delegation the DNS-01 challenge needs.                                                                                                                                                                                              |
| **MOTIR-4209** (the store)                            | §3 + §4's two address shapes in one table; §7's exactly-one-primary invariant; §8's retained-alias rule (`ProjectKeyAlias`'s uniqueness shape) and reserved-name set.                                                                                                                                                                                                                                                                 |
| **MOTIR-4210** (the certificates adapter)             | §6's three endpoints, the check response's field names, `https://api.machines.dev/v1`, the `%2A.` wildcard encoding, and §10's `FLY_CERTS_TOKEN` / `FLY_CERTS_APP` with the no-fallback token rule.                                                                                                                                                                                                                                   |
| **MOTIR-4211** (the design)                           | §5's add → verify → issue order and its two record shapes; §6's certificate states; §7's _make primary_; §9's tier upsell on `EntitlementExceededError('custom_domains')`; §8's rename warning ("the old address keeps redirecting and is never released").                                                                                                                                                                           |
| **MOTIR-4212** (the AUP clause)                       | §12 (our chrome stays), and §5's point that we serve hostnames whose zones we do not control — which is what the acceptable-use clause is about.                                                                                                                                                                                                                                                                                      |
| **MOTIR-4213** (the PSL submission)                   | §2 rule 3, and §4's statement that PSL listing is a **later refinement** nothing waits on.                                                                                                                                                                                                                                                                                                                                            |
| **MOTIR-4214** (provisioning)                         | §10's table, in full: four variables, which app each lives on, and which one is a build arg rather than a secret.                                                                                                                                                                                                                                                                                                                     |
| **MOTIR-4215** (claim / rename)                       | §3 (a subdomain names a workspace), §8's cap of **5**, the reserved-name set, and the retained-alias rule.                                                                                                                                                                                                                                                                                                                            |
| **MOTIR-4216** (the customer-domain lifecycle)        | §5's four-step order — a certificate is **never** requested before the TXT verifies — and §9's cap assert, run inside the create's transaction.                                                                                                                                                                                                                                                                                       |
| **MOTIR-4217** (the host contract)                    | §4's subject shapes: a host resolves to a workspace **or** to one project, and the DTO carries the project's addresses and its primary.                                                                                                                                                                                                                                                                                               |
| **MOTIR-4218** (CORS + return target)                 | §7's rule that every registered address is a legitimate public origin — `publicCorsHeaders` and `resolvePublicReturnTarget` currently compare against the **single** `publicSiteOrigin()`, and both become a membership test over the registered set. **The positive-test discipline in `returnTarget.ts` is not relaxed by that**: it stays an origin equality check against a set, never a `startsWith` or a hostname suffix match. |
| **MOTIR-4219** (the status job)                       | §6's check endpoint and its `validation` fields; §6's division of labour — Fly renews, we surface.                                                                                                                                                                                                                                                                                                                                    |
| **MOTIR-4220** (the host router)                      | §4's one branch per request; §11's cloud gate.                                                                                                                                                                                                                                                                                                                                                                                        |
| **MOTIR-4221 / MOTIR-4229** (the pane)                | §5, §7, §8, §9 and §11 — the whole customer-facing vocabulary.                                                                                                                                                                                                                                                                                                                                                                        |
| **MOTIR-4222** (the canonical)                        | §7 in full, including the half that is easy to miss: the primary is what `publicProjectUrl()` **emits**, not only what `<link rel="canonical">` says.                                                                                                                                                                                                                                                                                 |
| **MOTIR-4228** (the entitlement)                      | §9's kind, field, four provisional values and the six-line assert shape.                                                                                                                                                                                                                                                                                                                                                              |
| **MOTIR-4207** (verification, **outside** this story) | §6's warning: the certificate path is a claim about a running system and only a live issue discharges it.                                                                                                                                                                                                                                                                                                                             |

### ⚠️ What this record CHANGES about cards already written

Per the close-out discipline that a decision must diff itself against the
criteria of the cards it names, **every consumer's acceptance criteria were
re-read against the answers above.** The result:

- **MOTIR-4206 (this card) — AMENDED.** Its Q7 grounds cite Atlassian's rename
  cap as **3**; the fetched figure is **15**. Amended on the record, and a
  planning bug filed under MOTIR-1465.
- **MOTIR-4209 (the store) — CHECKED, and nothing is owed.** Its _title_ reads
  _"a SET of addresses per public project"_, which §3 does not support for the
  subdomain half. Its **body** does: its own table already assigns
  `workspace_subdomain` to the workspace (`workspaceId`, `projectId` null) and
  `custom_domain` to the project, which is exactly §3 and §4. The title is a
  pointer and the body is the spec, so the card is correct as it stands and is
  left alone. Recorded here because the next reader will notice the title and
  should not re-open it.
- **Every other consumer — CHECKED, no contradiction.** Each either names no
  shape this record fixes differently, or already states the answer above.

The check that mattered most is the one that came back **negative**: a decision's
own consequences table makes it easy to assert an amendment that was never made,
and _"I checked and nothing was owed"_ is a different claim from _"I did not
check"_ only if it is written down.

## §14 — What this record deliberately does NOT decide

**Every entry names the card or record that owns it** — nothing is left _"for
later"_ without an owner.

- **Which string the base domain actually is.** §2 fixes the shape and ranks the
  candidates; **MOTIR-4208** buys one. No code changes when it does.
- **The Public Suffix List submission.** **MOTIR-4213**. Trigger: the base domain
  is registered and serving.
- **The per-tier values of `maxCustomDomains`.** `billing-tiering.md` §4, via
  Stories **8.1 / 8.6**. §9 seeds them provisionally so MOTIR-4228 is total.
- **White-labelling a customer address.** §12, with its reversal condition. No
  card exists and none should until the condition fires.
- **What a customer address serves when the project stops being public.** The
  address record survives and the page 404s through the existing
  `ProjectNotFoundError` → 404 path (_"deliberately indistinguishable from an
  unknown key"_, `cloudGate.ts`) — but the _"your domain now points at a 404"_
  notification is not this story's. Trigger: the first support ticket.
  **MOTIR-4193** owns what that 404 looks like on `motir-marketing`.
- **Whether a workspace root lists projects or renders the single one.** §3 decides
  the rule; **MOTIR-4220** decides the rendering and **MOTIR-4211** draws it.

---

## Sources

**Rung 2 — `motir-core` `origin/main` at `f8fb84d8`, read 2026-09-03**

- `docs/decisions/public-surface-hosts.md` — §4 (the deviation, the accepted
  exposure, the reversal condition), §5 (the cloud gate), §9 (what it does not
  decide), AMENDMENT 4
- `docs/decisions/organization-url.md` — §3 (`Organization.slug` stays as
  substrate), the reversal condition
- `docs/decisions/marketing-site-hosting.md` — §3 (Spaceship, the Fly `A`/`AAAA`
  shape, the apex `MX`/`TXT` constraint and RFC 1034 §3.6.2), §5 (the
  subprocessor reasoning)
- `docs/decisions/billing-tiering.md` · `lib/billing/entitlements.ts` (`PmTier`,
  `EntitlementKind`, `PmEntitlements`, `PM_ENTITLEMENTS`) ·
  `lib/services/entitlementsService.ts` (the lock-then-count assert shape)
- `prisma/schema.prisma` — `Project` `@@unique([workspaceId, identifier])` (1543),
  `ProjectKeyAlias` (1738–1750), `Organization.slug @unique`
- `lib/publicProjects/urls.ts` (`publicSiteOrigin`, `publicProjectUrl`) ·
  `cors.ts` (`publicCorsHeaders`) · `returnTarget.ts`
  (`resolvePublicReturnTarget`) — the three modules that assume ONE public origin
- `lib/publicProjects/cloudGate.ts` (`publicSurfaceUnavailable`) ·
  `lib/billing/availability.ts` (`isCloud`)
- `lib/orchestrator/adapters/fly/flyMachines.ts` — the Fly boundary, the
  call-time config rule and the scoped-token rule
- `motir-marketing` `origin/main` at `e263dbc` — `fly.toml` (`app =
"motir-marketing"`, org `moooon`, `iad`, `[build.args]`), `lib/siteOrigin.ts`
  (why a `NEXT_PUBLIC_*` build arg and not a secret)

**Rung 1 — fetched 2026-09-03**

- Fly — `https://fly.io/docs/networking/custom-domain-api/` (the three endpoints,
  the check response fields, wildcard support and `%2A.` encoding) ·
  `https://fly.io/docs/networking/custom-domain/` (CNAME for subdomains, A/AAAA
  for apex, the `_acme-challenge` CNAME, DNS-01 for wildcards, renewals not
  counting against the per-registered-domain limit)
- Notion —
  `https://www.notion.com/help/connect-a-custom-domain-with-notion-sites`
  (_"This feature is only available on paid plans"_, `$10`/month, the
  `_notion-dcv.<subdomain>` TXT and the `external.notion.site.` CNAME)
- Canny — `https://help.canny.io/en/articles/1355038-setting-up-your-custom-domain`
  (`company.canny.io`, `cname.canny.io`, no TXT) and Canny's own feedback board
  for _make primary_ → the canonical source
- Statuspage —
  `https://support.atlassian.com/statuspage/docs/set-a-custom-domain-and-ssl/`
  (`mycompany.statuspage.io`; _"Public pages can use a custom domain, except for
  pages on the Free plan"_; the dedicated-domain **recommendation**)
- Atlassian —
  `https://support.atlassian.com/organization-administration/docs/update-a-product-url/`
  (_"We'll store the previous URL in your site's history and redirect all links
  to the new URL"_; _"You can update the subdomain up to 15 times"_)
- RDAP — `https://rdap.org/domain/<name>`, and
  `https://rdap.verisign.com/com/v1/domain/<name>` for `.com`

**Read but NOT confirmed, recorded so nobody re-cites it from here**

- Statuspage's help page, as fetched, does **not** state that a root/apex domain
  cannot be used; it _recommends_ a dedicated domain. §5 accepts apex domains and
  does not rest on that claim either way.
- The Atlassian page cited by this card's brief does not itself state that the old
  URL cannot be claimed by another organization. Atlassian's community
  documentation says a redirected URL is not available to another site while the
  owning site exists; §8's decision is taken on `ProjectKeyAlias`'s in-repo
  precedent (rung 2), which does not depend on that reading.

# Full-stack engineering standards

How we expect changes to this repo to be made — by people and by assistants.
This is reference material, not a stage in the `docs/` progression, so it sits
alongside `local-development.md` rather than under `plans/` or `specs/`.

**[`CLAUDE.md`](../CLAUDE.md) remains the single source of truth for
conventions** — branching, tickets, commit format, the complexity gate, the
commands. This file covers *how to work*, not *what the conventions are*, and
links rather than restates. Where the two could disagree, `CLAUDE.md` wins.

Every assistant reads this the same way: `AGENTS.md` is a symlink to
`CLAUDE.md`, and `.cursor/rules/full-stack-engineering.mdc` points here. One
copy, so there is one thing to keep correct.

---

## Tests come first (mandatory)

**Write the failing test before the implementation.** Not after, not alongside.

1. Write a test that expresses the desired behaviour.
2. **Run it and watch it fail.** A test that has never failed proves nothing —
   it may be asserting something already true, or not running at all.
3. Write the smallest implementation that makes it pass.
4. Run it and watch it pass.
5. Commit.

Applies to features and to bug fixes. For a bug, the failing test *is* the
reproduction: if you cannot write a test that fails for the reason the user is
reporting, you have not found the bug yet.

The one thing never to do is weaken a test to make it pass. If a test fails,
either the code is wrong or the test's expectation was wrong — decide which, and
say which. Changing `toBe(1)` to `toBeGreaterThan(0)` to get green is how a
suite stops meaning anything.

### Characterization tests before moving code

When relocating or refactoring existing behaviour, pin it with a test that
passes **against the unmodified code** first. Then the refactor is either
provably behaviour-preserving or provably not. "No behaviour change" without a
test that ran before the change is an assertion, not evidence.

### The runner

Vitest. See [`local-development.md`](./local-development.md#tests) for commands
and layout. Two things that bite:

- `vitest.config.js` collects `test/**/*.test.js` **only**. A `.test.mjs` file
  is not an error — it is silently never run.
- The suite needs neither Mongo nor Redis (`test/setup.js` provides
  `mongodb-memory-server` and mocks `ioredis`), so a failure is never "my
  database was in a funny state".

Prefer `test/msw/handlers.js` over reaching the network. It intercepts ISO+ at
the HTTP layer, which is the only practical way to drive code that branches on
an upstream response.

## End-to-end tests

Playwright, in `Frontend/e2e/`:

```bash
cd Frontend
npm run e2e:install   # once — downloads Chromium
npm run e2e           # headless
npm run e2e:ui        # watch it drive the browser
npm run e2e:report    # last HTML report
```

It targets `FRONTEND_PORT` (default **3100**), reusing whatever is already
serving — so `npm run dev:up` first and the suite runs against the real stack.

**A user-visible change needs an e2e test.** Unit and integration tests prove a
function and a route behave; they do not prove the feature is reachable. A tab
that renders perfectly and is never linked passes every unit test in the repo.

Keep them about journeys, not appearance: can the user get there, do the
controls respond, does the state persist across a reload. Assert on roles and
text (`getByRole`, `getByText`), not CSS classes or DOM structure, so a restyle
does not break the suite.

Note that most of this app is behind a login that proxies ISO+, so an e2e test
touching real workspace data needs credentials. Offline mode
([`local-development.md`](./local-development.md#running-without-iso-credentials))
covers workspaces and boards; anything beyond that belongs in `Backend/test/real-api/`
behind `RUN_REAL_API_TESTS=1`.

---

## Change control

- **Do not refactor, restructure or rewrite existing code unless asked.** A
  request to fix X is not a licence to tidy Y.
- **Prefer minimal, surgical edits.** When a one-line fix and a restructure both
  work, take the one-line fix and mention the restructure.
- Before a non-trivial change: explain the problem, propose the fix, show the
  diff. For anything hard to reverse, wait for approval.
- Preserve backward compatibility. When changing existing logic, state the blast
  radius and the edge cases you considered.

## Evidence over assertion

Claims that something works need the command and its actual output. "Tested
locally" is not evidence. Neither is a passing test you did not watch fail.

Report faithfully: if tests fail, say so and show the output; if a step was
skipped, say which and why. When something is verified, say so plainly.

This cuts both ways — do not report a *problem* you have not verified either.
Check whether a failure is pre-existing before attributing it to your change,
and check whether it is your change before attributing it to someone else's.

## Code quality

- **Cognitive complexity < 15 per file** — enforced by SonarQube in CI, not
  advisory. See [`CLAUDE.md`](../CLAUDE.md#code-quality-gate-enforced-not-optional).
  When a route or service grows complex, extract into `utils/*Helpers.js`; that
  is why `Backend/src/utils/` is dozens of small files.
- Small, single-purpose functions. Meaningful names.
- Comments explain **why**, not what. The code already says what.
- Composition over inheritance. Patterns where they earn their place —
  middleware, dependency injection — not for their own sake.
- Match the surrounding code's idiom, naming and comment density. Code that
  reads as though one person wrote it is worth more than code that is
  individually optimal.

## Security

- Validate and sanitize all input. Guard against injection, XSS, CSRF.
- Never commit secrets, tokens or credentials; use environment variables, and
  document new ones in `.env.example` — an undocumented variable is a variable
  nobody sets. `BACKEND_URL` went two releases undocumented and silently
  degraded two features.
- Apply authentication and authorization checks on every new endpoint,
  especially anything crossing a tenant boundary. `requirePortalOwnerOrSupport`
  already exists for owner/support-only routes.
- Endpoints that trigger real-world effects — sending email, pushing to Xero,
  writing back to ISO+ — need auth even when internal. Note the precedent to
  avoid: `hookSecret` is stored and never verified.
- Address GitHub vulnerability alerts rather than carrying them.

## Backend (Node / Express)

- ESM (`"type": "module"`): `node:` prefixes for built-ins, `.js` extensions on
  relative imports.
- Middleware for cross-cutting concerns; centralized error handling.
- Validate request payloads at the boundary.
- Async throughout; no blocking calls on the request path.
- Routes stay thin — controllers, services, helpers.
- **Watch for silent failure.** Several ISO+-facing routes answer HTTP 200 even
  when they reject the request, so the body is the only signal. When adding to
  that family, follow the existing contract but say so in the response body, and
  never treat a 200 from them as proof of success.

## Frontend (Next.js)

- Server Components by default; Client Components where interaction requires it.
- Avoid unnecessary client state; optimize data fetching (SSR, ISR, caching).
- Modular, reusable components.
- `next lint` is **not** run at build time (`eslint.ignoreDuringBuilds: true`) —
  run it manually.

## Priority when these conflict

1. Safety — no breaking changes, no data loss
2. Correctness, demonstrated by a test that failed first
3. Clarity — explain before changing
4. Minimal change
5. Performance, where it is safe
6. Style

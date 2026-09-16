# Contributing to Warmstart

Thanks for looking. This page covers the licence and process questions; **[AGENTS.md](AGENTS.md) is the
guide to working in the codebase** and is worth reading before you write anything — it is short, and it
records conventions that are load-bearing rather than stylistic.

⚠️ **Warmstart is pre-alpha and has one maintainer.** Please open an issue before starting anything
substantial. A pull request that arrives without one may be declined simply because it collides with
work already in flight, and that wastes your time more than mine.

## The CLA, and why it exists

Warmstart asks first-time contributors to sign a [Contributor License Agreement](CLA.md). It is one
comment on your first pull request, after the maintainer gives you a permanent link to the exact CLA
version being signed. The wording is at the end of `CLA.md`, and the agreement covers everything you
contribute afterwards. Signatures are recorded in [`CLA-SIGNERS.md`](CLA-SIGNERS.md).

**Two paragraphs on why**, because an unexplained CLA is a reasonable thing to be annoyed by.

You keep the copyright in everything you write. What the CLA adds is a licence to the project that
includes the right to **sublicense** — to distribute your contribution under terms other than
Apache-2.0. Without that, the project's licence is frozen the moment the first external contribution
lands: changing it later would mean tracking down every contributor who ever touched the code and
asking permission, and in practice that means it can never change at all.

Warmstart is Apache-2.0 today and there is no plan to change that. The CLA exists so that the option
is still there in a few years — for example to offer a commercial licence to an organisation that
cannot accept Apache-2.0 — rather than being foreclosed by a decision nobody consciously made. ⛔ **It
does not let the maintainer take your contribution proprietary and remove it from the open project**:
the Apache-2.0 release already made is irrevocable, so every version published stays open under those
terms, permanently.

If you would rather not sign, that is a legitimate position and you are still welcome here: file
issues, reproduce bugs, argue in threads, write about the project. Those are contributions too and none
of them need a CLA.

### Maintainer checklist for a first pull request

1. Link the contributor to `CLA.md` at the full commit SHA currently on `main`, not to the moving
   `main` URL, and ask them to post the declaration from `CLA.md` as a new comment.
2. Check that every person whose work is included has posted the declaration with the exact link.
3. Before merging, add each signature to `CLA-SIGNERS.md`. Obtain the stable numeric account ID with
   `gh api users/<login> --jq .id`; do not treat a display name as identity.
4. After merging, lock the pull-request conversation so a contributor without repository write
   access cannot later delete the signing comment.

## The name

The code is Apache-2.0; the **name** is not — see [TRADEMARK.md](TRADEMARK.md). Fork freely, and please
call your fork something else.

## Before you open a pull request

```bash
npm run typecheck
npm run lint
npm test
```

All three must pass. `npm test` is free and spends no tokens; ⛔ **never run `npm run test:e2e` in a
pull request** — it spends real money against a real account and is gated behind an environment
variable for that reason. See [docs/testing.md](docs/testing.md) for what each tier can and cannot
prove.

## What makes a change easy to accept

The project has a specific and slightly unusual standard, described in [AGENTS.md](AGENTS.md). The two
that matter most to a reviewer:

- ⭐ **Measure, don't assert.** This codebase is built on things that were checked. If you state a
  number, say where it came from and when. What you could not measure, label *inferred* and say what
  the inference rests on. A confident unsourced sentence is worse than none here, because it gets
  trusted and then repeated.
- ⭐ **`unknown` is a verdict, not a guess.** Where a value cannot be established, the code says so
  rather than defaulting to zero, to a half, or to a plausible-looking number. Reviews will push back
  on a default that hides a missing input.

A change that adds a test proving the thing it claims to fix is much easier to accept than one that
does not, whatever its size.

## Reporting a bug

Include your OS, how you installed Warmstart, and what **Settings → Global** reports at the top — which
CLIs were found, who is signed in, how old each quota reading is, and what can and cannot be verified
per adapter. That answers most of the first round of questions.

⚠️ **Do not paste credentials, tokens, or the contents of an isolation directory into an issue.**
Warmstart never reads them and neither should a bug report.

## Security

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting
on this repository instead.

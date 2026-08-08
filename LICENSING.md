# Licensing

This document states which parts of Patchwork OS are open source, which are
not, and where the line falls. It is written for three readers who will not read
an architecture decision record: someone reviewing this software for procurement,
someone deciding where to send a pull request, and a lawyer checking what a fork
may do.

The reasoning behind the boundary is in
[ADR-0019](docs/adr/0019-open-core-boundary.md). This document states the
outcome.

---

## 1. This repository is MIT, and stays MIT

Everything in this repository is licensed under the [MIT License](LICENSE),
Copyright © Oolab Labs. That includes:

- the bridge and its runtime
- all 177 MCP tools
- the recipe engine, triggers and scheduler
- every connector
- the dashboard
- the local approval queue and the single-workspace autonomy gate
- the boundary computation (`previewActions`, `decideWorkerAction`)
- evidence **emission** — the local JSONL ledgers

There is no plan to relicense this repository, and no feature in it is gated,
time-limited, or disabled pending payment. If you can run it, you can run all of
it, for any purpose, including commercially.

**The local evidence ledgers stay open-format and fully usable standalone.**
`worker_gate_decisions.jsonl`, `approval_log.jsonl`, `outcome-log.jsonl` and
`file_rollback.jsonl` are plain JSONL on your disk. They are readable, parseable
and useful without any commercial component, and a change that made them less
useful alone in order to push you toward a paid product would be the wrong
change. That is a stated constraint in ADR-0019, not a courtesy.

---

## 2. What is reserved

A separate repository, `patchwork-control-plane`, is **not** MIT. It is intended
for organisation-scale governance:

- organisation identity (SSO/SCIM)
- policy inheritance across workspaces
- off-site tamper-evident evidence storage
- signed audit export
- approval routing
- a cross-workspace worker registry
- retention enforcement

The architectural rule that draws the line:

> **The open runtime emits evidence. Only the control plane attests to it.**

You can run the open product, generate complete decision records, read them,
replay them and act on them, forever, for free. What the control plane adds is
the ability to hand a third party a record they will accept — which comes not
from the file format but from an organisation that signs a contract about
retention, operates the store, answers the security questionnaire, and is
nameable when an auditor asks who is responsible.

A third repository, `patchwork-multitenant`, is also MIT. Its scope is frozen to
infrastructure — tenant provisioning, reverse proxy, container plumbing. No
governance feature will be added to it.

**Licence terms for `patchwork-control-plane` are not settled.** ADR-0019
records an intent toward BSL 1.1 or similar — a licence that converts to an open
licence after a term — but the specific licence, version and term are not
decided.

> `TODO(owner):` confirm the licence, version and conversion term for
> `patchwork-control-plane` before it is published. Until it is published,
> nothing outside this repository and `patchwork-multitenant` exists to license.

---

## 3. Where to send a pull request

| If your change is about… | It belongs in |
|---|---|
| A tool, connector, recipe feature, trigger, or the runtime | **This repository.** MIT. |
| The approval queue, the autonomy gate, action classes, the boundary preview, or writing evidence to disk | **This repository.** MIT. |
| Reading, replaying or explaining local evidence (`patchwork gate explain`, `halts`, `judgments`, the traces page) | **This repository.** MIT. |
| The dashboard, the CLI, the IDE extensions, the plugin system | **This repository.** MIT. |
| Tenant provisioning, reverse proxy, per-tenant container plumbing | `patchwork-multitenant`. MIT, scope frozen. |
| Organisation identity, SSO/SCIM, policy inheritance across workspaces, retention enforcement, signed or countersigned audit export, cross-workspace registries | `patchwork-control-plane`. Not MIT. |

If you are unsure, open an issue here and ask before writing the code. The
practical test: **does the feature work for one person on one machine?** If yes,
it belongs here. If it only makes sense for an organisation governing many
workspaces, it does not.

Contributions to this repository are accepted under the [CLA](CLA.md), which
grants Oolab Labs the right to relicense contributions — including under a
commercial licence. That is what preserves the ability to maintain a commercial
edition at all, and it applies to every contributor equally, including the
maintainers. Read it before your first PR.

---

## 4. What a fork may and may not do

**May.** Everything the MIT licence permits, without asking:

- fork this repository, publicly or privately
- modify any part of it
- run it commercially, internally or as a hosted service
- redistribute it, modified or not
- sell it, or products built on it
- keep your modifications private

The only MIT conditions are that the copyright notice and licence text travel
with the copy.

**May not.** These are limits from other bodies of law, not from the MIT licence:

- **Use the name or the marks.** "Patchwork OS", "Patchwork", the logo and
  associated marks are not licensed by the MIT grant. You may say your product
  is *built on* or *compatible with* Patchwork OS; you may not name your fork or
  derivative product with the marks, or imply endorsement. See
  [TRADEMARK.md](TRADEMARK.md).
- **Use `patchwork-control-plane`** under terms it does not grant. If and when
  it is published under BSL or similar, its licence governs — the MIT grant in
  this repository confers no rights over it.
- **Misrepresent attestation.** A fork can replay its own evidence ledgers. It
  cannot represent that output as attested by Oolab Labs.

**Nothing here restricts a fork from implementing the same features.** The
control-plane boundary is not enforced by licence terms over ideas; it is a
statement about which code this project publishes. Anyone may write their own
organisation-identity layer against these open ledgers, and the ledger formats
stay open specifically so that remains possible.

---

## 5. Third-party licences

Dependencies carry their own licences; see the dependency tree for specifics.
Bundled non-code assets are listed in
[LICENSE-THIRD-PARTY.md](LICENSE-THIRD-PARTY.md).

> `TODO(owner):` LICENSE-THIRD-PARTY.md currently lists only the connector
> glyphs (SimpleIcons, CC0). A procurement reviewer will ask for a full
> dependency licence inventory — worth generating one (`license-checker` or
> equivalent) and either committing it or documenting how to produce it.

---

## 6. Questions

Licensing questions that this document does not answer: open an issue, or email
legal@oolab.dev (the address given in [CLA.md](CLA.md)).

> `TODO(legal):` confirm `legal@oolab.dev` is monitored and is the correct route
> for licensing enquiries, or replace it here and in CLA.md.

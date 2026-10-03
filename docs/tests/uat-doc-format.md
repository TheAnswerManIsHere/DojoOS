# UAT document format — DojoOS

A UAT doc lives at `docs/tests/UAT/PR<N>_<FEATURE>_UAT.md` (feature in
SCREAMING_SNAKE) and is driven step by step by the `/uat` skill.
`node scripts/check-uat-format.mjs` enforces the structure.

```markdown
# PR #<N> — <Feature> — UAT

## Setup

- [claude] <what Claude prepares before the run>
- [david] <what David does before step 1>
- [restore] <what is put back afterwards>

## Steps

### 1. <title>

**Do:** <one action David takes>

**Expect:** <the one observable result that counts as a pass>

## Regression

### 1. <title>

**Do:** <one action>

**Expect:** <one result>
```

Setup is bullets tagged `[claude]`, `[david]` or `[restore]`, or the single
line `None.`. Every step has exactly one **Do:** and one **Expect:**.
Regression may be `None.` with a sentence saying why. Steps name DojoOS's
own surfaces: the library page, the logging viewer, the brick timeline,
the deck editor, the renders page, the feedback rail.

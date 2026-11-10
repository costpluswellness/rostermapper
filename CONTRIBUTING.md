# Contributing

Node 22+ and pnpm (`corepack enable`).

```
pnpm install
pnpm check      # schema check, typecheck, build; CI runs the same
```

- Real rosters hold provider PII: keep them in the git-ignored `samples/` and never commit them.
- Fields live in `schema/fields.yaml`. After editing it run `pnpm schema` to regenerate `src/schema.generated.ts` and `docs/canonical_fields.md`.
- Taxonomy codes come from NUCC's CSV via `pnpm nucc`.
- Keep the core in `src` free of I/O; the CLI and `site/` are thin wrappers.

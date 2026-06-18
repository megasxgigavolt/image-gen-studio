# Engineering Practices

## Versioning

Use semantic versions. Development branches follow
`release/v<version>-<theme>`. Every release has a checklist in `docs/releases`.

## Changes

`CHANGELOG.md` records user-visible changes. Architectural decisions receive an
ADR. Release notes document scope, exclusions, acceptance criteria, and known
issues.

## Quality gates

Every merge must pass:

- formatting
- linting
- TypeScript type checking
- unit tests
- production build
- Python tests once the engine is introduced

## Logging

Application logs are structured and redact credentials, prompts marked private,
and binary data. Runtime logs are never committed. The personal build has no
telemetry. Future diagnostics must be explicit opt-in.

## Security

- Secrets live in Windows Credential Manager.
- Project exports never include secrets.
- Frontend code cannot access provider keys.
- Tauri permissions follow least privilege.
- Dependencies must use permissive licenses unless reviewed.

## Definition of done

Work is done only when implementation, tests, documentation, error states, and
release checklist updates are complete.


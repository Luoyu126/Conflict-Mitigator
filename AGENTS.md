<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Remote collaboration conventions

When syncing code to a remote repository, write commit messages, pull request titles, and pull request descriptions in clear, professional English.

- Follow Conventional Commits for commit messages and pull request titles: `<type>[optional scope]: <description>` (for example, `fix(auth): handle expired sessions`).
- Use a concise, imperative description and an appropriate type such as `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, or `ci`.
- In pull request descriptions, explain the changes and relevant validation in English, following the repository's template when available.

## API contracts and interaction logic

- Development must strictly follow the API contracts and interaction logic in `docs/api/` (currently `/home/chenyy/Conflict-Mitigator/docs/api/`). Read the relevant documents before planning or implementing a change:
  - `docs/api/frontend-api.md`: frontend business APIs.
  - `docs/api/internal-api.md`: backend internal and media APIs, including LiveKit integration.
  - `docs/api/interact-api.md`: interaction flows between pages, backend services, and media.
- Preserve the documented request and response fields, authentication and privacy boundaries, state transitions, and interaction ordering. Do not invent or silently change contracts or behavior.
- When something is unclear, first determine whether it can be resolved by gathering evidence. Independently inspect relevant documentation, code, configuration, history, or authoritative sources; read-only investigation does not require user approval.
- If investigation leaves a design disagreement, conflicting requirements, or a product/API/privacy decision that requires the user's judgment, explain the evidence and options, then ask the user and wait before proceeding with the affected work. Do not silently invent or change contracts. Continue independent investigation that does not depend on that decision.

## Discuss and confirm before execution

- All read-only checks and investigations may proceed without user confirmation. Provide concise progress updates as useful; do not ask for permission to read, search, or inspect information. An operation that changes files, data, or external state is not read-only.
- Before making changes or performing other state-changing actions, report the intended actions, scope, and potential risks or side effects, including relevant effects on APIs, data, privacy, external services, dependencies, and validation. If no material risks are identified, say so briefly.
- Discuss the scope of changes and obtain explicit confirmation before execution unless the user has already authorized those actions in the conversation. Do not request confirmation again for agreed work. A proposal, elapsed time, or silence is not approval.
- Confirmation applies only to the agreed actions and scope. If new material risks, scope changes, or unresolved design decisions arise, pause the affected changes, report them, and obtain confirmation before continuing. Resolve factual uncertainty through independent read-only investigation first.
- After execution, report the outcome, validation results, and any remaining issues.

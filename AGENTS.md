# Agent instructions

Read `CLAUDE.md` in this folder (and the add-on folder you're working in)
before making changes - it's the full guide to this repository.

## Commit identity (required)

Author and commit every change as:

```
jumpmanactual <75352153+jumpmanactual@users.noreply.github.com>
```

Before committing, check `git config user.name` and `git config user.email`.
If either is unset or different, set them for this repo:

```
git config user.name jumpmanactual
git config user.email 75352153+jumpmanactual@users.noreply.github.com
```

Never make up a name or email. GitHub credits a commit to whichever account
owns its email address, so a guessed address like
`<name>@users.noreply.github.com` attributes the work to an unrelated
stranger. CI (`.github/workflows/commit-identity.yml`) rejects any push or
pull request containing commits with another author or committer email.

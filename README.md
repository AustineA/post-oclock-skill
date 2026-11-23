# Post O'Clock

Let your coding agent plan and schedule posts in your Post O'Clock content calendar.

## Included skills

- `post-oclock`

## Installation

```bash
npx github:AustineA/post-oclock-skill
```

This installs the skills separately at:

```text
~/.agents/skills/post-oclock/
```

It then symlinks them into detected Claude Code, Codex, Cursor, Windsurf, Antigravity, Trae, and Amp installations.

Other commands:

```bash
npx github:AustineA/post-oclock-skill update     # install the latest version if GitHub has a newer commit
npx github:AustineA/post-oclock-skill status     # installed commit, where it's installed and linked
npx github:AustineA/post-oclock-skill uninstall  # remove the copies and their links
```

## Updating

```bash
npx github:AustineA/post-oclock-skill update
```

It compares the latest commit on GitHub with the one recorded at install time. If yours is older, it clones the latest version and installs it. The installed copy is replaced, not merged, so files removed from a skill don't linger. Restart your agent afterwards.

## Usage

After installation, What's going out on Post O'Clock this week?.

## Package structure

```text
bin/
  install.mjs
skill/
  post-oclock/
    SKILL.md
package.json
```

## License

MIT

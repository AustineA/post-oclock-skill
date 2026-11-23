---
name: post-oclock
description: Read and change the user's Post O'Clock content calendar on their Mac. List projects and posts, schedule posts with captions, hashtags and a suggested song, move or rewrite them, attach photos and videos, import Grain stories, and tick posts off. Use when the user wants to plan, schedule, move or review Instagram, TikTok or other social posts, mentions Post O'Clock or their content calendar, or asks what's going out this week.
---

# Post O'Clock

Post O'Clock is an iPhone content calendar. Its database is a folder of files in the user's iCloud
Drive, so a post written here on the Mac shows up on the phone, which reminds the user when it's time
to post. `scripts/postoclock.cjs` reads and writes that folder. It needs Node 18 or later and macOS,
with Post O'Clock opened once on an iPhone signed in to the same Apple account, with iCloud Drive on.

## Run it

`SKILL_DIR` is the folder that holds this file.

```bash
node "$SKILL_DIR/scripts/postoclock.cjs" tools                       # every tool and its arguments
node "$SKILL_DIR/scripts/postoclock.cjs" list_projects
node "$SKILL_DIR/scripts/postoclock.cjs" list_posts '{"start": "2026-11-24", "end": "2026-11-30"}'
node "$SKILL_DIR/scripts/postoclock.cjs" schedule_post - <<'JSON'
{"at": "2026-11-24T09:00", "project": "grain", "title": "Monday reel",
 "caption": "It's Monday, let's go", "tags": "#reels #weekend", "format": "reel",
 "platform": "instagram", "music": "Song – Artist", "media_paths": ["~/Desktop/reel.mp4"]}
JSON
```

Pass arguments as one JSON object, either quoted after the tool name or on stdin after `-`. Use
stdin with a quoted heredoc whenever the text has quotes or apostrophes. Results print as JSON on
stdout. A problem the user can fix prints one sentence on stderr and exits with 1. Pass it on as it is.

The tools: `list_projects`, `create_project`, `list_posts`, `get_post`, `schedule_post`,
`update_post`, `delete_post`, `mark_posted`, `list_grain_drafts`. Run `tools` for their arguments
rather than guessing.

## How to schedule well

- Run `list_projects` first and put each post in its project (`project` is the id). If the user names
  a project that isn't there, offer `create_project`.
- Run `list_posts` for those days before scheduling, so a new post doesn't land on top of another.
- `at` is the phone's own clock, no time zone: `YYYY-MM-DDTHH:MM`, 24-hour.
- Give every reel, video, story or carousel a `music` suggestion, written as "Song – Artist": a real
  song on Instagram and TikTok that fits the post's mood and pace and its audience.
- Photos and videos are file paths on this Mac (`image_path` for the cover, `media_paths` for what
  gets posted, in order). If the user means a picture you can see but don't have a path for, ask for
  the file or its folder.
- A Grain story goes in with `grain_draft` (an id from `list_grain_drafts`). The phone renders the
  video when it's time to post.
- Change a post with `update_post` (only the fields given change). Never delete and recreate a post
  to edit it: iCloud turns that into duplicate copies on the phone.
- Ask before `delete_post`. It removes the post and its media for good.

## When files are still in iCloud

If a reply says files "haven't downloaded from iCloud to this Mac yet", the script has already asked
iCloud for them. Wait about a minute and run the same command once more. If it still says so, tell
the user to open the Post O'Clock folder in Finder's iCloud Drive and choose Download Now.

`POSTOCLOCK_DIR` points the script at another folder, such as a simulator's Documents, for testing.

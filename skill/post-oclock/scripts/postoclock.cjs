#!/usr/bin/env node
// Post O'Clock connector: lets Claude read and change the content calendar.
//
// A local MCP server (stdio, no dependencies), shipped as a Claude desktop extension. The calendar
// is a folder of files in iCloud Drive, which the iPhone app reads, so a post written here shows up
// on the phone and gets its reminder.
//
//     projects/<id>.json  an account, brand or client the posts are for
//     posts/<id>.json     one post: its project, when, cover text, caption, hashtags, notes
//     media/<file>        its picture, the photos and videos that get posted, and a Grain story's photos
//     posted/<id>.json    present once the post has gone out
//
// Set POSTOCLOCK_DIR to use another folder (a simulator's Documents, a test folder).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const HOME = os.homedir();
const ROOT = process.env.POSTOCLOCK_DIR ||
  path.join(HOME, 'Library/Mobile Documents/iCloud~app~aestheticallypleasing~postoclock/Documents');
const GRAIN_DRAFTS = path.join(HOME, 'Library/Mobile Documents/iCloud~app~aestheticallypleasing~grain/Documents/Drafts');
const TEMPLATE_NAMES = readJSON(path.join(__dirname, 'templates.json'), {}); // Grain template id → name
const FIELDS = ['title', 'caption', 'tags', 'notes', 'music', 'platform', 'format'];
const SLUG = /^[A-Za-z0-9._-]+$/;
const WHEN = "When to post, on the phone's own clock, as YYYY-MM-DDTHH:MM (24-hour), e.g. 2026-11-21T09:00.";

/** Something the person asking can put right; its message goes back to Claude. */
class Refused extends Error {}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = file => fs.existsSync(file);
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const remove = file => fs.rmSync(file, { force: true });
const jsonFiles = dir => fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => path.join(dir, n));
const expand = p => (p === '~' || p.startsWith('~/') ? path.join(HOME, p.slice(1)) : path.resolve(p));
const slugify = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// A file Optimize Mac Storage left in iCloud only. Reading one waits, sometimes for good, until
// iCloud brings it down, so nothing here reads a file without checking first.
const DATALESS = 0x40000000;

function inCloudOnly(files) {
  if (!files.length) return [];
  const result = spawnSync('stat', ['-f', '%Xf', ...files], { encoding: 'utf8' });
  const flags = (result.stdout || '').trim().split('\n');
  return files.filter((file, i) => parseInt(flags[i], 16) & DATALESS);
}

function download(files) {
  spawn('sh', ['-c', 'for f; do brctl download "$f"; done', 'sh', ...files], { stdio: 'ignore', detached: true }).unref();
}

/** The files, once they're all on this Mac; otherwise asks iCloud for the rest and says so. */
function local(files, what) {
  const waiting = inCloudOnly(files);
  if (waiting.length) {
    download(waiting);
    throw new Refused(`${waiting.length} ${what} ${waiting.length === 1 ? "hasn't" : "haven't"} downloaded from iCloud to this Mac yet. ` +
                      "I've asked iCloud for them. Try again in a minute.");
  }
  return files;
}

const readAll = (files, what) => local(files, what).map(read);

function folder(name) {
  if (!exists(ROOT)) {
    throw new Refused(`The calendar folder isn't on this Mac yet (${ROOT}). Open Post O'Clock on the iPhone once ` +
                      'with iCloud Drive on, wait for iCloud to sync, then try again.');
  }
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Written whole and swapped in, so iCloud never syncs half a file. */
function writeWhole(file, value) {
  const draft = file.replace(/\.json$/, '.tmp');
  fs.writeFileSync(draft, JSON.stringify(value, null, 1));
  fs.renameSync(draft, file);
}

const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function when(text) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2})$/.exec(String(text ?? ''));
  if (m) {
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    const date = new Date(y, mo - 1, d, h, mi);
    if (date.getMonth() === mo - 1 && date.getDate() === d && h < 24 && mi < 60) {
      return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`;
    }
  }
  throw new Refused(`'${text}' isn't a time I can use. ${WHEN}`);
}

function load(postId) {
  const file = path.join(folder('posts'), `${postId}.json`);
  if (!SLUG.test(postId || '') || !exists(file)) {
    throw new Refused(`There's no post with the id '${postId}'. list_posts shows the ids.`);
  }
  return readAll([file], 'post file')[0];
}

const save = post => writeWhole(path.join(folder('posts'), `${post.id}.json`), post);
const isPosted = postId => exists(path.join(folder('posted'), `${postId}.json`));

function projects() {
  return readAll(jsonFiles(folder('projects')), 'project files').sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** A post may have no project; one it names has to exist, so a typo doesn't hide the post. */
function knownProject(projectId) {
  if (projectId) {
    const ids = projects().map(p => p.id);
    if (!ids.includes(projectId)) {
      throw new Refused(`There's no project with the id '${projectId}' (projects: ${ids.join(', ') || 'none yet'}). Use create_project first.`);
    }
  }
  return projectId;
}

function listProjects() {
  const counts = new Map();
  for (const post of readAll(jsonFiles(folder('posts')), 'post files')) {
    const key = post.project ?? null;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return {
    projects: projects().map(p => ({ ...p, posts: counts.get(p.id) || 0 })),
    posts_without_a_project: counts.get(null) || 0,
  };
}

function createProject({ name, handle, color, id }) {
  id = id || slugify(name);
  if (!SLUG.test(id || '')) throw new Refused('A project id may only use letters, numbers, dots, dashes and underscores.');
  if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) throw new Refused('A colour is a hex like #1F5BFF.');
  const file = path.join(folder('projects'), `${id}.json`);
  const project = exists(file) ? readAll([file], 'project file')[0] : { id };
  project.name = name;
  if (handle) project.handle = handle;
  if (color) project.color = color;
  writeWhole(file, project);
  return project;
}

const brief = post => ({ id: post.id, project: post.project ?? null, at: post.at, title: post.title, platform: post.platform ?? null,
                         format: post.format ?? null, posted: isPosted(post.id) });
const full = post => ({ ...post, posted: isPosted(post.id) });
const storyFiles = post => Object.values(post.story?.media || {}).map(m => m.clip || m.photo);

function attach(post, imagePath) {
  const source = expand(imagePath);
  if (!isFile(source)) throw new Refused(`There's no picture at ${source}.`);
  local([source], 'picture');
  const name = `${post.id}${path.extname(source).toLowerCase() || '.jpg'}`;
  fs.copyFileSync(source, path.join(folder('media'), name));
  post.image = name;
}

/** Copies the photos and videos that get posted into the calendar, in order, replacing any the
 *  post had. With no picture of its own, the post takes the first one's. */
function attachMedia(post, mediaPaths) {
  const sources = mediaPaths.map(expand);
  for (const source of sources) if (!isFile(source)) throw new Refused(`There's no file at ${source}.`);
  local(sources, 'of those files');
  const media = folder('media');
  for (const old of post.media || []) remove(path.join(media, old));
  post.media = sources.map(source => {
    const name = `${post.id}-${crypto.randomBytes(4).toString('hex')}${path.extname(source).toLowerCase()}`;
    fs.copyFileSync(source, path.join(media, name));
    return name;
  });
  if (sources.length && !post.image) {
    const cover = path.join(media, `${post.id}.jpg`);
    const first = sources[0];
    if (['.mov', '.mp4', '.m4v'].includes(path.extname(first).toLowerCase())) {
      // Quick Look draws a video's first frame.
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'postoclock-'));
      try {
        spawnSync('qlmanage', ['-t', '-s', '720', '-o', scratch, first]);
        const frame = fs.readdirSync(scratch).find(n => n.endsWith('.png'));
        if (frame) spawnSync('sips', ['-s', 'format', 'jpeg', path.join(scratch, frame), '--out', cover]);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    } else {
      spawnSync('sips', ['-Z', '1280', '-s', 'format', 'jpeg', first, '--out', cover]);
    }
    if (exists(cover)) post.image = path.basename(cover);
  }
}

/** A Grain draft's folder, from its id in Grain's iCloud Drive folder or from a path to it. */
function grainDraftFolder(draft) {
  for (const dir of [expand(draft), path.join(GRAIN_DRAFTS, draft)]) {
    if (isFile(path.join(dir, 'draft.json'))) return dir;
  }
  throw new Refused(`There's no Grain draft at '${draft}'. Give a draft's id from list_grain_drafts, or the path of a folder holding draft.json.`);
}

/** The stories saved in Grain on this iCloud account, newest first. */
function listGrainDrafts() {
  if (!exists(GRAIN_DRAFTS)) {
    throw new Refused("Grain's drafts aren't on this Mac. They appear once Grain has saved a draft with iCloud Drive on.");
  }
  const files = fs.readdirSync(GRAIN_DRAFTS).map(dir => path.join(GRAIN_DRAFTS, dir, 'draft.json')).filter(isFile);
  const waiting = inCloudOnly(files);
  if (waiting.length) download(waiting);
  const drafts = [];
  for (const file of files.filter(f => !waiting.includes(f))) {
    const draft = readJSON(file, null);
    if (!draft) continue;
    const words = Object.values(draft.textEdits || {}).map(e => e.text).filter(Boolean);
    drafts.push({
      id: draft.id,
      template: TEMPLATE_NAMES[draft.templateID] || draft.templateID,
      saved: stamp(new Date((draft.updated + 978307200) * 1000)), // Grain keeps time in seconds since 2001
      photos: Object.keys(draft.media || {}).length,
      words: words.slice(0, 4),
    });
  }
  drafts.sort((a, b) => (a.saved < b.saved ? 1 : a.saved > b.saved ? -1 : 0));
  return waiting.length
    ? { count: drafts.length, drafts, still_downloading: waiting.length,
        note: `${waiting.length} more drafts are still downloading from iCloud. They'll be listed once they're on this Mac.` }
    : { count: drafts.length, drafts };
}

/** Puts a Grain story on a post, whole: the draft as Grain saved it, and its photos and clips.
 *  The phone renders the video from it with Grain's engine when it's time to post. */
function attachGrainDraft(post, draft) {
  const source = grainDraftFolder(draft);
  const story = readAll([path.join(source, 'draft.json')], "of this draft's files")[0];
  // Every photo and clip is checked before anything changes, so a refusal leaves the post as it was.
  const slots = Object.entries(story.media || {}).map(([slot, item]) => {
    const key = item.clip ? 'clip' : 'photo';
    if (!item[key]) {
      throw new Refused(`Slot ${Number(slot) + 1} of this draft still holds one of Grain's sample photos. Put your own in, in Grain, then import it.`);
    }
    const file = path.join(source, item[key]);
    if (!isFile(file)) throw new Refused(`${item[key]} is missing from this draft. Open the draft in Grain once, then try again.`);
    return { item, key, file };
  });
  local(slots.map(s => s.file), "of this draft's photos and clips");
  const media = folder('media');
  for (const old of [...storyFiles(post), ...(post.media || [])]) if (old) remove(path.join(media, old));
  // The video comes from the story now, so one made from an older story goes.
  delete post.media;
  for (const { item, key, file } of slots) {
    const name = `${post.id}-story-${item[key]}`;
    fs.copyFileSync(file, path.join(media, name));
    item[key] = name;
  }
  // What Grain uses to list drafts isn't part of the story.
  delete story.id;
  delete story.updated;
  post.story = story;
  const cover = path.join(source, 'thumbnail.jpg');
  if (isFile(cover) && !inCloudOnly([cover]).length) {
    fs.copyFileSync(cover, path.join(media, `${post.id}.jpg`));
    post.image = `${post.id}.jpg`;
  }
}

function listPosts({ project, start, end, include_posted = true }) {
  let posts = readAll(jsonFiles(folder('posts')), 'post files');
  if (project) {
    knownProject(project);
    posts = posts.filter(p => p.project === project);
  }
  const from = (start || '0000').slice(0, 10), to = (end || '9999').slice(0, 10);
  posts = posts.filter(p => from <= p.at.slice(0, 10) && p.at.slice(0, 10) <= to && (include_posted || !isPosted(p.id)));
  posts.sort((a, b) => (a.at + a.id < b.at + b.id ? -1 : 1));
  return { count: posts.length, posts: posts.map(brief) };
}

const getPost = ({ id }) => full(load(id));

function schedulePost(args) {
  const { title, caption, project, image_path, media_paths, grain_draft } = args;
  const at = when(args.at);
  let id = args.id;
  if (!id) {
    const slug = slugify(title).slice(0, 40) || 'post';
    id = [project, at.slice(0, 10), at.slice(11, 13) + at.slice(14, 16), slug].filter(Boolean).join('-');
  }
  if (!SLUG.test(id)) throw new Refused('An id may only use letters, numbers, dots, dashes and underscores.');
  if (exists(path.join(folder('posts'), `${id}.json`))) {
    throw new Refused(`A post with the id '${id}' already exists. Use update_post to change it.`);
  }
  let post = { id, at, title, caption };
  if (knownProject(project)) post = { id, project, ...post };
  for (const key of ['tags', 'notes', 'music', 'platform', 'format']) if (args[key]) post[key] = args[key];
  if (image_path) attach(post, image_path);
  if (media_paths) attachMedia(post, media_paths);
  if (grain_draft) attachGrainDraft(post, grain_draft);
  save(post);
  return full(post);
}

function updatePost(args) {
  const post = load(args.id);
  if (knownProject(args.project)) post.project = args.project;
  if (args.at) post.at = when(args.at);
  for (const key of FIELDS) if (args[key] != null) post[key] = args[key];
  if (args.image_path) attach(post, args.image_path);
  if (args.media_paths != null) attachMedia(post, args.media_paths);
  if (args.grain_draft) attachGrainDraft(post, args.grain_draft);
  save(post);
  return full(post);
}

function deletePost({ id }) {
  const post = load(id);
  remove(path.join(folder('posts'), `${id}.json`));
  remove(path.join(folder('posted'), `${id}.json`));
  const media = folder('media');
  for (const name of [...(post.media || []), ...storyFiles(post), post.image]) if (name) remove(path.join(media, name));
  return { deleted: id };
}

function markPosted({ id, posted = true }) {
  load(id);
  const marker = path.join(folder('posted'), `${id}.json`);
  if (posted) fs.writeFileSync(marker, '{"posted":true}');
  else remove(marker);
  return { id, posted };
}

const TEXT = { type: 'string' };
const OPTIONAL = {
  tags: { ...TEXT, description: 'Hashtags, space separated. Pasted under the caption.' },
  notes: { ...TEXT, description: 'Anything to remember when posting, such as where the video is.' },
  music: { ...TEXT, description: "The song that best suits the post, to pick in the platform's own music library, as " +
                                 "'Song – Artist'. Suggest one for every reel, video, story or carousel: a real song that's " +
                                 "on Instagram and TikTok, popular with the account's audience, whose mood and pace fit the post." },
  platform: { ...TEXT, description: 'Where it goes, such as instagram or tiktok.' },
  format: { ...TEXT, description: 'What it is, such as reel, story or carousel.' },
  image_path: { ...TEXT, description: 'A picture on this Mac to show with the post. It is copied into the calendar.' },
  media_paths: { type: 'array', items: TEXT,
                 description: 'The photos and videos on this Mac that get posted, in order. They are copied into the calendar, ' +
                              "and the phone opens them in the platform's app with the caption copied. Replaces any the post had." },
  grain_draft: { ...TEXT, description: "A story made in Grain, to post: a draft's id from list_grain_drafts, or the path of a draft folder. " +
                                       "The whole draft and its photos are copied onto the post, and the phone makes the video from it " +
                                       "with Grain's engine when it's time to post." },
};
const PROJECT = { ...TEXT, description: 'The id of the project the post is for, from list_projects.' };
const TOOLS = {
  list_projects: [listProjects, 'List the projects in the calendar (accounts, brands or clients) with how many posts each has.', {}, []],
  create_project: [createProject, 'Add a project to post for, or rename an existing one by giving its id.', {
    name: { ...TEXT, description: 'What the person calls it, such as Grain.' },
    handle: { ...TEXT, description: 'The account handle, such as @thisisgrain.' },
    color: { ...TEXT, description: "A hex colour that marks the project's posts, such as #1F5BFF." },
    id: { ...TEXT, description: 'Leave out for a new project; one is made from the name.' } }, ['name']],
  list_grain_drafts: [listGrainDrafts, "List the stories saved in Grain on this Mac's iCloud account, newest first, to schedule as posts.", {}, []],
  list_posts: [listPosts, "List the posts in the Post O'Clock calendar, soonest first, with whether each has gone out.", {
    project: { ...TEXT, description: "Only this project's posts." },
    start: { ...TEXT, description: 'First day to include, YYYY-MM-DD.' },
    end: { ...TEXT, description: 'Last day to include, YYYY-MM-DD.' },
    include_posted: { type: 'boolean', description: 'False to leave out posts already published.' } }, []],
  get_post: [getPost, 'Read one post in full: time, cover text, caption, hashtags, notes and suggested music.', { id: TEXT }, ['id']],
  schedule_post: [schedulePost, "Add a post to the calendar. It appears in Post O'Clock on the iPhone, which reminds the person at that time.", {
    at: { ...TEXT, description: WHEN },
    title: { ...TEXT, description: "The line for the cover, also the reminder's headline. Short." },
    caption: { ...TEXT, description: 'The caption to paste, without hashtags.' },
    project: PROJECT, ...OPTIONAL,
    id: { ...TEXT, description: 'Leave out unless a specific id is wanted; one is made from the time and title.' } },
    ['at', 'title', 'caption']],
  update_post: [updatePost, 'Change a post: move it to another time, or rewrite its words. Only the fields given change.', {
    id: TEXT, at: { ...TEXT, description: WHEN }, title: TEXT, caption: TEXT, project: PROJECT, ...OPTIONAL }, ['id']],
  delete_post: [deletePost, 'Remove a post from the calendar for good, with its picture.', { id: TEXT }, ['id']],
  mark_posted: [markPosted, 'Tick a post off as published, or untick it. A published post gets no reminder.', {
    id: TEXT, posted: { type: 'boolean', description: 'False to untick.' } }, ['id']],
};

/** The checks Python's keyword arguments gave the first version: no missing, unknown or mistyped arguments. */
function checked(name, args, properties, required) {
  const missing = required.filter(key => args[key] == null);
  if (missing.length) throw new Refused(`${name} needs ${missing.join(', ')}.`);
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec) throw new Refused(`${name} has no argument called ${key}.`);
    if (value == null) continue;
    const ok = spec.type === 'array' ? Array.isArray(value) && value.every(v => typeof v === 'string') : typeof value === spec.type;
    if (!ok) throw new Refused(`${key} should be ${spec.type === 'array' ? 'a list of paths' : `a ${spec.type}`}.`);
  }
  return args;
}

const INSTRUCTIONS = "Post O'Clock is the person's content calendar, for one or more projects. Times are on their " +
  "phone's own clock. Call list_projects first and put each post in its project. " +
  "Look at list_posts before scheduling so new posts don't land on top of existing ones. " +
  'Give every reel, video, story or carousel a suggested song in `music`.';

function answer({ method, params = {} }) {
  if (method === 'initialize') {
    return { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} },
             serverInfo: { name: 'postoclock', title: "Post O'Clock", version: '1.1.0' }, instructions: INSTRUCTIONS };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') {
    return { tools: Object.entries(TOOLS).map(([name, [, description, properties, required]]) =>
      ({ name, description, inputSchema: { type: 'object', properties, required } })) };
  }
  if (method === 'tools/call') {
    const tool = TOOLS[params.name];
    try {
      if (!tool) throw new Refused(`There's no tool called ${params.name}.`);
      const [run, , properties, required] = tool;
      const result = run(checked(params.name, params.arguments || {}, properties, required));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
    } catch (problem) {
      return { content: [{ type: 'text', text: problem.message }], isError: true };
    }
  }
  return undefined;
}

/** The same tools from a shell, for agent skills: `index.js <tool> ['<json arguments>' | -]`, or `index.js tools`.
 *  `-` reads the arguments from stdin, so captions with quotes need no shell escaping. */
function command([name, json]) {
  if (json === '-') json = fs.readFileSync(0, 'utf8');
  if (name === 'tools' || name === '--help') {
    for (const tool of answer({ method: 'tools/list' }).tools) {
      const args = Object.entries(tool.inputSchema.properties)
        .map(([key, spec]) => `${key}${tool.inputSchema.required.includes(key) ? '' : '?'}: ${spec.type}`);
      console.log(`${tool.name}(${args.join(', ')})\n  ${tool.description}`);
    }
    return 0;
  }
  let args;
  try { args = json ? JSON.parse(json) : {}; } catch {
    console.error('The arguments must be one JSON object, such as \'{"id": "grain-2026-11-24-0900-monday-reel"}\'.');
    return 2;
  }
  const result = answer({ method: 'tools/call', params: { name, arguments: args } });
  (result.isError ? console.error : console.log)(result.content[0].text);
  return result.isError ? 1 : 0;
}

if (require.main === module && process.argv.length > 2) {
  process.exitCode = command(process.argv.slice(2));
} else if (require.main === module) {
  const reply = message => process.stdout.write(JSON.stringify(message) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    if (!line.trim()) return;
    let request;
    try { request = JSON.parse(line); } catch {
      return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (!('id' in request)) return; // a notification: nothing to answer
    const result = answer(request);
    reply(result === undefined
      ? { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }
      : { jsonrpc: '2.0', id: request.id, result });
  });
}

module.exports = { answer };

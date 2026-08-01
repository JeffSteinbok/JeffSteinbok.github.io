# jeffSteinbok.github.io Source

Published at [https://jeffsteinbok.github.io](https://jeffsteinbok.github.io)

## How this site is organized

This is a [Jekyll](https://jekyllrb.com/) site. All shared styling lives in one place so
individual pages and sub-sites never carry bespoke HTML or CSS.

- **`_sass/`** — the theme, split into partials (`_variables`, `_base`, `_buttons`,
  `_cards`, `_doc`). `assets/css/style.scss` just `@import`s them.
- **`_layouts/`** — `default.html` (base `<head>`/chrome + optional Mermaid), `page.html`
  (hero + card sections), `doc.html` (prose wrapped in `.doc`).
- **`_includes/`** — `hero.html`, `social.html`, `footer.html`, `card.html`.
- **`_data/`** — content for data-driven pages (`projects.yml` → home, `carapace.yml` →
  `/carapace`). Add a card by editing YAML, not HTML.

### Adding a sub-site (push contract)

External projects publish their own docs page into this site by pushing a folder
containing a single `index.md` — **no CSS, no layout HTML, no boilerplate**. The page just
selects a shared layout via front matter and inherits all styling:

```yaml
---
layout: doc                       # prose pages; use `page` for card grids
title: My Project
permalink: /myproject/
hero_image: /assets/images/myproject.svg   # optional
heading: My Project
tagline: One-line description
back_link: Back to jeffsteinbok.github.io
back_link_url: /
---

# Body is plain Markdown — rendered and wrapped in `.doc` by the layout.
```

The `puppets/` folder is produced this way: the private `automation` repo builds
`docs/public/puppets/index.md`, runs a redaction gate, and pushes it here with a
Contents-scoped token. See `automation/.github/workflows/docs-publish.yml`.

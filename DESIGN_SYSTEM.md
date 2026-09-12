# Corn Town design system

Corn Town is a quiet, editorial interface for **weekly picks**. Its personality
comes from typography, proportion, warm surfaces, and precise feedback—not a
football or sports visual theme.

The shared treatment covers the application frame, picks, standings, submission
history, and submission details. Administrator pages use the same typography,
control sizing, option pickers, and spacing conventions.

## Sources of truth

- `src/client/styles.css`: color tokens, typography, components, responsive rules,
  and motion.
- `src/client/ui.tsx`: headings, accessible option pickers, teams, themes, loading, and errors.
- `src/client/app.tsx`: navigation, account disclosure, sign-in, and contextual home.
- `src/client/picks.tsx`: pick entry, submission history/details, feedback, and standings.
- `src/client/drafts.ts`: device-local draft lifecycle.

Reuse these primitives. Use Tailwind utilities for layout and spacing; do not
introduce another hard-coded surface/accent palette for new core UI.

## Principles

1. **The task comes first.** Picking and following standings are equally important.
   Keep their actions obvious and the pool visible without a wall of summary cards.
2. **Distinctive, not decorative.** Editorial headings, a restrained rust accent,
   clear rules, and small outline icons provide the character.
3. **Quiet hierarchy.** One page title, subdued season/week context, compact controls,
   and one primary action. Account and administrator tools stay out of the main flow.
4. **Readable density.** Group related information. Prefer dividers to nested cards,
   literal status text to unexplained color, and complete names to unnecessary truncation.
5. **No sports styling.** No field markings, helmets, jerseys, trophies, sports-display
   typefaces, or team-colored chrome. Small team logos are functional identifiers only.
6. **Honest states.** Draft, submitted, pending, locked, empty, error, and final are
   different conditions. Never imply a draft was submitted or invent a score or probability.

## Typography

Literata Variable gives the wordmark and headings their editorial character.
Designed by TypeTogether for digital publishing, its optical sizes support
readable headings without relying on exaggerated display proportions. DM Sans
Variable handles controls, body copy, names, and numeric data. Both fonts are
self-hosted through Fontsource packages under the SIL Open Font License; no
font CDN request is needed.

- Page headings: medium weight, optical sizing, restrained negative tracking,
  and 1.2 line height; approximately 32–44px depending on viewport.
- Wordmark: 26–30px, medium weight.
- Interface text: generally 13–14px; compact team choices and table data use 12px
  on phones. Avoid using tiny utility labels for primary instructions.
- Touch-device inputs use 16px text to avoid automatic input zoom.
- Counts and scores use tabular numerals. Do not animate changing numeric text.

## Color and theme

The `--canvas`, `--surface`, `--ink`, `--muted`, `--line`, and `--accent` families
are the shared vocabulary. Blue-green `--progress` indicates completion without
borrowing the rust action accent or suggesting an error. Semantic success,
warning, and danger tokens remain separate from both.

| Token | Light | Dark |
| --- | --- | --- |
| `--canvas` | `#f7f6f2` | `#191c19` |
| `--surface` | `#fffefa` | `#20241f` |
| `--surface-raised` | `#ffffff` | `#292e27` |
| `--surface-soft` | `#efeee8` | `#2b3028` |
| `--ink` | `#292b26` | `#eeeee4` |
| `--muted` | `#706f65` | `#a4aa9d` |
| `--line` | `#deded4` | `#373d32` |
| `--accent` | `#aa4935` | `#e6a08a` |
| `--accent-soft` | `#f6e9e1` | `#3c2d25` |
| `--progress` | `#356d7c` | `#8bbcc6` |

`ThemePicker` offers System theme, Light, and Dark. It preserves the existing
`localStorage.theme` preference and toggles `.dark` on `<html>`. System changes
apply while the preference is automatic. Manual switching still works if storage
is unavailable.

Use `.panel`, `.button.primary`, `.button.secondary`, `.input`, `.alert`, `.badge`,
and `.text-link` rather than copying long color-class combinations. Borders provide
most separation; the account popover and submission dock use only a subtle shadow.

`OptionPicker` wraps the unstyled Radix Select primitive. Season, week, theme, and
job controls share the same trigger and custom option-list treatment rather than
opening native platform menus. Preserve labels, selected checkmarks, keyboard
navigation, typeahead, viewport collision handling, and focus restoration.
The popup remains inside its containing disclosure: Escape closes a theme picker
first, then a second Escape closes Account. Empty API values for All/Current
remain valid choices; the primitive's internal value encoding is not an API change.

## Frame and responsive layout

- The frame has a 1160px maximum width, including desktop gutters. Phone gutters
  are 24px, reduced to 16px on the narrowest supported screens.
- `.page-toolbar` aligns controls and actions along their bottom edge, with a
  minimum 16px gap and wrapping when needed. Inputs, option triggers, and buttons
  share a 44px height. Use 24px separation between major content sections.
- There is one primary navigation instance: Make picks, Standings, My submissions.
  It sits in the header at 768px and above and at the bottom on smaller screens.
- Bottom navigation and the submission dock account for device safe areas.
- Account contains identity, appearance, sign-out, and authorized administrator links.
  Escape closes it and returns focus; leaving the disclosure also closes it.
- An authenticated home visit opens unfinished picks or, after submission, the
  selected week's standings. Explicit destinations and personalized links retain
  their existing routing and authorization rules.
- Ordinary navigation retains season/week context. The wordmark returns to home.

## Picks

Show full team names, optional small logos, Central-time kickoff information, and
explicit game status. Do not display an upcoming game's placeholder zero scores.
Group games by day and separate games with rules inside the group.

A whole team-choice label is clickable, with a minimum 64px height. Keep the day
group panel, but do not nest bordered, filled, or shadowed team cards inside it.
Native checked radios and stronger team-name weight identify the selection.
Use a quiet hover highlight for enabled choices and a visible keyboard focus
outline; selected choices do not retain a separate panel surface.

Matchups mirror around the center: away name, logo, radio; home radio, logo, name.
Reserve the logo slot when an image is unavailable. Below 375px, omit logos and
collapse their tracks to preserve complete words in long team names.
Keep selected locked picks readable; only unselected disabled teams use muted text.

The submission dock contains the sole pick-progress bar and count beside the
submit/update action, with draft feedback below. Progress counts eligible games
and stays reachable while scrolling. Missing choices and an invalid tiebreaker
receive focus and are brought above the dock, including during keyboard navigation.
Submitted picks still lock at the existing weekly deadline; a late first
submission can select only the games the server still permits.

### Recoverable drafts

- Drafts are local to this browser/device, not synchronized and never auto-submitted.
- Scope is authenticated user ID, season, and week. A saved-submission revision is
  retained so stale local edits cannot replace a newer server submission on reload.
- Restoration filters choices against current eligible games and valid team IDs.
- Expiry is the next applicable kickoff boundary. Late first submissions use the
  next remaining boundary, not an already-past weekly opening kickoff.
- Expired, malformed, superseded, and closed-board drafts are rejected. Active
  picks clear expired data; periodic app maintenance and later reads also prune it.
  A closed browser cannot perform background deletion.
- Successful submission and successful sign-out clear the relevant drafts.
- Feedback distinguishes saved-on-device, restored, expired, and storage failure.
  Failed storage must not block explicit server submission or claim persistence.

## Standings

The pool is the main content. A compact three-part strip shows the current user's
server-provided place, correct picks, and remaining picks. Week completion is a
small contextual line, not another large card.

Keep names readable, highlight the current row quietly, and place status with the
player. Rank and scores come from the API; do not fabricate percentages, deltas,
or season totals. Preserve the existing hidden-pick and tiebreaker privacy rules.

Normal standings fit narrow screens, including long names. Conditional tiebreaker
columns remain in the semantic table and can scroll inside a focusable region
rather than widening the page. Empty standings provide a direct route to picking.

## Submission history and details

History uses the shared page toolbar for the season picker and Make picks action,
with divided rows rather than individually decorated cards. Details use a compact
correct-picks/tiebreaker strip and share the application's content width in both
Compact and Detailed views.

Read-only matchups are result sheets, not disabled pick forms. A keyboard-accessible
Compact / Detailed switch controls their density. Compact is the default; the
browser remembers the choice in `localStorage["submission-view"]`. Switching
still works when storage is blocked.

- **Compact:** one line in away @ home order, or away vs home when ESPN marks
  the competition as a neutral site. Keep the separator at the true center of the
  entire panel, independent of result-badge width, using symmetric grid tracks.
  Team abbreviations and scores stay at 14px. Picked sits before the away group
  or after the home group, never on a second line. Below 640px, omit logos and use
  result icons with a visible Correct / Incorrect / Pending key above the list;
  keep each row's result text available to screen readers. Wider screens retain
  logos and full outcome labels. Scores stay adjacent to their own team with
  consistent gaps. Keep the team display intrinsically sized so the Picked label
  cannot stretch those gaps.
- **Detailed:** full-width team rows with full names, home/away context, aligned
  scores, and kickoff details.

Both views use one divided list, not nested team panels. Do not repeat the matchup
title above the same names; retain a screen-reader heading and game metadata.

Selection and outcome have different visual languages:

- **Picked:** a neutral label beside the selected team, with stronger name weight.
  No checkmark, rust fill, or success/error color.
- **Correct:** a green badge with a circled checkmark.
- **Incorrect:** a red badge with a circled cross.
- **Pending:** a neutral badge with a clock. A live lead is not a final outcome.

Outcome badges describe the pick, not the chosen team's identity. Detailed shows
the kickoff time and game status. Compact keeps that information available to
screen readers and exposes game status through an outcome tooltip, without an
extra visible status line. Use text and distinct icons so outcomes never depend
on color alone.
Retain a readable team-ID fallback when game or team data is missing.
Upcoming games must not show placeholder zero scores.

## Accessibility and motion

- Aim for WCAG AA text contrast: 4.5:1 for normal text and 3:1 for large text.
  Core text, accent, and semantic token pairs were checked in both themes; the
  lowest measured normal-text pair was 4.68:1. This is not a full accessibility audit.
- Interactive targets are at least 44px through the control or its clickable label.
- Preserve labels, fieldsets, legends, table headers, live feedback, and visible focus.
  Redundant logos and icons are decorative to assistive technology.
- Focused fields must not be concealed by sticky controls. Read-only data remains legible.
- Use short feedback transitions: roughly 160ms for colors, 120ms for a button press,
  and 180ms for progress. A small finite disclosure reveal is appropriate.
- Loading may use a small progress spinner. Do not pulse live data, shuffle table
  rows, animate scores, add parallax, or delay content for an entrance animation.
- `prefers-reduced-motion: reduce` removes animations and transitions.

## Reference direction

- [Linear's UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui):
  hierarchy, reduced chrome, alignment, and deliberate light/dark treatment.
- [Things](https://culturedcode.com/things/features/): focused tasks, clear grouping,
  and progressive disclosure.
- [Copilot Money](https://www.copilot.money/): readable personal data and responsive
  composition, without borrowing its marketing-page effects.
- [Literata](https://github.com/googlefonts/literata): TypeTogether's digital
  editorial family, with headline, text, and caption optical sizes.
- [Adrian Krebs's design-slop research](https://www.adriankrebs.ch/blog/design-slop/):
  identifies Instrument Serif among recurring visual patterns. This is a
  perception-based heuristic, not evidence that a particular interface is AI-made.

These are principles to learn from, not interfaces to clone.

# NFL Pick'em Design System

A minimal, flat, mobile-first design system optimized for displaying game picks, standings, and sports data.

## Design Principles

1. **Mobile-first** - Optimize for small screens, enhance for larger
2. **Information-dense** - Maximize data display, minimize decorative elements
3. **High contrast** - Ensure readability in all conditions
4. **Flat design** - Minimal shadows, clear borders, clean separation
5. **Accessibility** - Clear focus states, readable text, semantic HTML

---

## Color Palette

### Primary Colors
Used for main actions, links, and brand elements.

- **Primary Blue**: `bg-blue-600` / `text-blue-600` / `border-blue-600`
  - Hover: `hover:bg-blue-700`
  - Light variant: `bg-blue-50` (backgrounds)
  - Dark variant: `bg-blue-800`

### Semantic Colors

#### Success (Correct Picks, Positive Actions)
- **Main**: `bg-green-600` / `text-green-600` / `border-green-600`
- **Light**: `bg-green-50` (row highlights)
- **Hover**: `hover:bg-green-700`

#### Error/Danger (Wrong Picks, Destructive Actions)
- **Main**: `bg-red-600` / `text-red-600` / `border-red-600`
- **Light**: `bg-red-50` (row highlights)
- **Hover**: `hover:bg-red-700`

#### Warning (Pending, Alerts)
- **Main**: `bg-amber-600` / `text-amber-600` / `border-amber-600`
- **Light**: `bg-amber-50` (backgrounds)
- **Hover**: `hover:bg-amber-700`

#### Info (Informational Messages)
- **Main**: `bg-sky-600` / `text-sky-600` / `border-sky-600`
- **Light**: `bg-sky-50`

### Neutral Colors (Grays)

#### Backgrounds
- **Page background**: `bg-gray-50`
- **Card/Container background**: `bg-white`
- **Subtle background**: `bg-gray-100`
- **Hover background**: `hover:bg-gray-50`

#### Borders
- **Subtle**: `border-gray-200`
- **Medium**: `border-gray-300`
- **Strong**: `border-gray-400`

#### Text
- **Primary text**: `text-gray-900`
- **Secondary text**: `text-gray-600`
- **Muted text**: `text-gray-500`
- **Disabled text**: `text-gray-400`

### Navigation
- **Nav background**: `bg-gray-800`
- **Nav text**: `text-gray-300`
- **Nav text hover**: `hover:text-white` + `hover:bg-gray-700`

---

## Typography

### Font Families
- **All text**: System font stack (Tailwind default)
  - `font-sans`

### Font Sizes
- **xs**: `text-xs` (10px captions, badges)
- **sm**: `text-sm` (12px secondary text, table data)
- **base**: `text-base` (14px body text, default)
- **lg**: `text-lg` (16px emphasized text)
- **xl**: `text-xl` (18px small headings)
- **2xl**: `text-2xl` (24px section headings)
- **3xl**: `text-3xl` (30px page headings)

### Font Weights
- **Normal**: `font-normal` (400 - body text)
- **Medium**: `font-medium` (500 - subtle emphasis)
- **Semibold**: `font-semibold` (600 - headings, labels)
- **Bold**: `font-bold` (700 - important data, scores)

### Line Heights
- **Tight**: `leading-tight` (headings)
- **Normal**: `leading-normal` (body text)
- **Relaxed**: `leading-relaxed` (long-form content)

### Text Hierarchy Examples
```html
<!-- Page Title -->
<h1 class="text-2xl sm:text-3xl font-bold text-gray-900">

<!-- Section Heading -->
<h2 class="text-xl sm:text-2xl font-semibold text-gray-900">

<!-- Subsection Heading -->
<h3 class="text-lg font-semibold text-gray-900">

<!-- Body Text -->
<p class="text-sm sm:text-base text-gray-900">

<!-- Secondary Text -->
<p class="text-sm text-gray-600">

<!-- Muted/Helper Text -->
<p class="text-xs sm:text-sm text-gray-500">
```

---

## Spacing Scale

Based on Tailwind's 4px scale. Use responsive variants for mobile-first design.

### Padding/Margin Scale
- **0**: `0px`
- **1**: `4px` - `p-1` / `m-1`
- **2**: `8px` - `p-2` / `m-2`
- **3**: `12px` - `p-3` / `m-3`
- **4**: `16px` - `p-4` / `m-4`
- **6**: `24px` - `p-6` / `m-6`
- **8**: `32px` - `p-8` / `m-8`
- **12**: `48px` - `p-12` / `m-12`

### Common Spacing Patterns
```html
<!-- Mobile container padding -->
<div class="px-3 sm:px-4 py-4 sm:py-6">

<!-- Card padding -->
<div class="p-3 sm:p-4">

<!-- Compact list item -->
<div class="px-3 py-2">

<!-- Standard list item -->
<div class="px-3 sm:px-4 py-3">

<!-- Section spacing -->
<div class="mb-4 sm:mb-6">

<!-- Tight element spacing -->
<div class="space-y-2">

<!-- Standard element spacing -->
<div class="space-y-3 sm:space-y-4">

<!-- Generous section spacing -->
<div class="space-y-6 sm:space-y-8">
```

### Gap Sizes (Flexbox/Grid)
- **Tight**: `gap-2`
- **Standard**: `gap-3 sm:gap-4`
- **Generous**: `gap-4 sm:gap-6`

---

## Border Radius

### Sizes
- **None**: `rounded-none` (0px - tables, specific designs)
- **Small**: `rounded` (4px - badges, small buttons)
- **Medium**: `rounded-lg` (8px - cards, containers, buttons)
- **Large**: `rounded-xl` (12px - modals, major sections)
- **Full**: `rounded-full` (9999px - pills, circular avatars)

### Usage Examples
```html
<!-- Buttons -->
<button class="rounded-lg">

<!-- Cards/Containers -->
<div class="rounded-lg">

<!-- Badges -->
<span class="rounded">

<!-- Pills -->
<span class="rounded-full px-2 py-1">
```

---

## Borders & Dividers

### Border Widths
- **Default**: `border` (1px)
- **Thick**: `border-2` (2px)
- **None**: `border-0`

### Border Styles
```html
<!-- Card border -->
<div class="border border-gray-200">

<!-- Strong border -->
<div class="border-2 border-gray-300">

<!-- Divider lines -->
<div class="divide-y divide-gray-100">

<!-- Top border only -->
<div class="border-t border-gray-200">
```

---

## Shadows & Elevation

**Philosophy**: Minimal shadow usage. Prefer borders for separation.

### Shadow Levels
- **None**: `shadow-none` (Default for flat design)
- **Subtle**: `shadow-sm` (Dropdown menus, popovers)
- **Medium**: `shadow` (Floating elements when needed)
- **Large**: `shadow-lg` (Modals, important overlays)

### Usage
```html
<!-- Most elements: use borders instead -->
<div class="border border-gray-200">

<!-- Dropdown menus -->
<div class="shadow-sm border border-gray-200">

<!-- Sticky headers (if needed) -->
<div class="shadow border-b border-gray-200">
```

---

## Interactive States

### Hover States
```html
<!-- Background hover -->
<div class="hover:bg-gray-50">

<!-- Button hover -->
<button class="bg-blue-600 hover:bg-blue-700">

<!-- Text hover -->
<a class="text-gray-600 hover:text-gray-900">
```

### Active/Pressed States
```html
<button class="active:bg-blue-800">
```

### Focus States (Accessibility)
```html
<!-- Always include focus states for interactive elements -->
<button class="focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2">

<input class="focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
```

### Disabled States
```html
<button class="disabled:opacity-50 disabled:cursor-not-allowed" disabled>
```

---

## Component Patterns

### Buttons

#### Primary Button
```html
<button class="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors">
  Primary Action
</button>
```

#### Secondary Button
```html
<button class="px-4 py-2 bg-white text-gray-700 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors">
  Secondary Action
</button>
```

#### Danger Button
```html
<button class="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 transition-colors">
  Delete
</button>
```

#### Ghost/Text Button
```html
<button class="px-4 py-2 text-blue-600 text-sm font-medium hover:bg-blue-50 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors">
  Cancel
</button>
```

### Form Inputs

#### Text Input
```html
<input type="text" class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
```

#### Select
```html
<select class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
```

#### Checkbox/Radio
```html
<input type="checkbox" class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-2 focus:ring-blue-500">
```

### Badges/Pills

#### Status Badge
```html
<span class="px-2 py-1 text-xs font-semibold rounded bg-green-100 text-green-800">
  Active
</span>
```

#### Count Badge
```html
<span class="px-2 py-0.5 text-xs font-bold rounded-full bg-blue-600 text-white">
  12
</span>
```

### Lists & Tables

#### Simple List
```html
<div class="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
  <div class="px-3 sm:px-4 py-3 hover:bg-gray-50">
    List item content
  </div>
</div>
```

#### Table (Mobile-friendly)
```html
<div class="bg-white border border-gray-200 rounded-lg overflow-hidden">
  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead class="bg-gray-50 border-b border-gray-200">
        <tr>
          <th class="px-3 sm:px-4 py-2 text-left font-semibold text-gray-900">Header</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100">
        <tr class="hover:bg-gray-50">
          <td class="px-3 sm:px-4 py-3 text-gray-900">Data</td>
        </tr>
      </tbody>
    </table>
  </div>
</div>
```

### Alerts/Messages

#### Success
```html
<div class="p-3 bg-green-50 border border-green-200 rounded-lg">
  <p class="text-sm text-green-800">Success message</p>
</div>
```

#### Error
```html
<div class="p-3 bg-red-50 border border-red-200 rounded-lg">
  <p class="text-sm text-red-800">Error message</p>
</div>
```

#### Warning
```html
<div class="p-3 bg-amber-50 border border-amber-200 rounded-lg">
  <p class="text-sm text-amber-800">Warning message</p>
</div>
```

#### Info
```html
<div class="p-3 bg-sky-50 border border-sky-200 rounded-lg">
  <p class="text-sm text-sky-800">Info message</p>
</div>
```

### Cards (When Needed)

#### Minimal Card
```html
<div class="bg-white border border-gray-200 rounded-lg p-3 sm:p-4">
  Card content
</div>
```

---

## Layout & Grid

### Container Max-Widths
```html
<!-- Narrow content (forms, settings) -->
<div class="max-w-2xl mx-auto">

<!-- Standard content (most pages) -->
<div class="max-w-4xl mx-auto">

<!-- Wide content (dashboards, tables) -->
<div class="max-w-6xl mx-auto">
```

### Breakpoints
Tailwind's default breakpoints (mobile-first):
- **sm**: `640px` (small tablets)
- **md**: `768px` (tablets)
- **lg**: `1024px` (laptops)
- **xl**: `1280px` (desktops)

### Responsive Patterns
```html
<!-- Mobile-first padding -->
<div class="px-3 sm:px-4 lg:px-6">

<!-- Responsive grid -->
<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">

<!-- Hide on mobile -->
<div class="hidden sm:block">

<!-- Show only on mobile -->
<div class="sm:hidden">
```

---

## Animations & Transitions

### Transition Durations
- **Fast**: `duration-150` (150ms - hover states, quick feedback)
- **Normal**: `duration-200` (200ms - default)
- **Slow**: `duration-300` (300ms - larger elements)

### Easing
- **Default**: `ease-in-out` (Tailwind default)
- **Linear**: `ease-linear` (progress indicators)

### What Should Animate
```html
<!-- Background color changes -->
<button class="transition-colors duration-200">

<!-- Multiple properties -->
<div class="transition-all duration-200">

<!-- Transforms -->
<div class="transition-transform duration-200 hover:scale-105">
```

### What Should NOT Animate
- Layout shifts
- Text content changes
- Critical data updates

---

## Iconography

### Icon Library
- Use Heroicons (already in Tailwind ecosystem)
- Outline style for most icons
- Solid style for filled/active states

### Icon Sizes
- **Small**: `w-4 h-4` (16px - inline with text)
- **Medium**: `w-5 h-5` (20px - buttons, navigation)
- **Large**: `w-6 h-6` (24px - prominent actions)
- **XL**: `w-8 h-8` (32px - empty states, features)

### Usage
```html
<!-- Icon with text -->
<button class="flex items-center gap-2">
  <svg class="w-5 h-5" ...>
  <span>Button Text</span>
</button>

<!-- Icon only -->
<button class="p-2">
  <svg class="w-5 h-5" ...>
</button>
```

---

## Accessibility Guidelines

1. **Color Contrast**: Maintain WCAG AA standards (4.5:1 for normal text, 3:1 for large text)
2. **Focus States**: Always visible and clear
3. **Touch Targets**: Minimum 44x44px for interactive elements
4. **Semantic HTML**: Use proper heading hierarchy, lists, tables
5. **Alt Text**: Provide for all images and icons with meaning
6. **Labels**: All form inputs must have labels

---

## Application-Specific Patterns

### Game Status Indicators
```html
<!-- Upcoming game -->
<span class="text-xs text-gray-500">Upcoming</span>

<!-- In progress -->
<span class="text-xs font-medium text-blue-600">Live</span>

<!-- Final -->
<span class="text-xs text-gray-600">Final</span>
```

### Pick Result Indicators
```html
<!-- Correct pick (use entire row background) -->
<div class="bg-green-50">

<!-- Incorrect pick (use entire row background) -->
<div class="bg-red-50">

<!-- No result yet -->
<div class="bg-white">
```

### Score Display
```html
<!-- Large score -->
<span class="text-xl sm:text-2xl font-bold text-gray-900">24</span>

<!-- Inline score -->
<span class="font-semibold text-gray-900">24</span>
```

### Team Display
```html
<!-- Team with logo -->
<div class="flex items-center gap-2">
  <img src="logo.png" alt="Team" class="w-6 h-6">
  <span class="text-sm font-medium text-gray-900">KC</span>
</div>
```

---

## Examples: Before & After

### Before (Bulky Card Design)
```html
<div class="bg-white rounded-lg shadow-xl p-6 sm:p-8 mb-6">
  <h1 class="text-3xl sm:text-4xl font-bold mb-2 text-gray-800 text-center">Title</h1>
</div>
```

### After (Minimal, Flat Design)
```html
<div class="mb-4 sm:mb-6">
  <h1 class="text-2xl sm:text-3xl font-bold text-gray-900">Title</h1>
</div>
```

---

## Quick Reference: Common Classes

### Text
- Primary heading: `text-2xl sm:text-3xl font-bold text-gray-900`
- Secondary heading: `text-lg font-semibold text-gray-900`
- Body text: `text-sm sm:text-base text-gray-900`
- Muted text: `text-xs sm:text-sm text-gray-500`

### Containers
- Page: `min-h-screen bg-gray-50`
- Content: `max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6`
- Card: `bg-white border border-gray-200 rounded-lg p-3 sm:p-4`

### Lists
- Container: `bg-white border border-gray-200 rounded-lg divide-y divide-gray-100`
- Item: `px-3 sm:px-4 py-3 hover:bg-gray-50`

### Buttons
- Primary: `px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700`
- Secondary: `px-4 py-2 bg-white text-gray-700 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50`

---

**Last Updated**: 2025-10-30

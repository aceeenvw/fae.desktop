# fae.desktop

> Transform SillyTavern into a desktop environment.

A SillyTavern extension that replaces the default interface with a fully functional macOS-inspired desktop — complete with draggable windows, a dock, menu bar, ambient effects, and a widget system.

---

## Features

### 🖥️ Desktop Mode
A real window manager running inside SillyTavern. Drag, resize, snap, minimize, and maximize windows. SillyTavern's native panels (character list, extensions drawer) are wrapped in proper macOS-styled windows with titlebars and traffic light controls.

- Edge snapping and window-to-window snapping
- Per-window focus and z-index management
- Configurable window opacity

### 🍎 macOS-Inspired UI
- **Traffic lights** — close, minimize, maximize buttons on every window
- **Glassmorphism** — backdrop blur, layered transparency throughout
- **Dock** — bottom dock with icon magnification on hover
- **Menu bar** — persistent top bar with clock, date, active character name, and quick access to preferences

### 💬 Chat Window
The chat panel becomes a first-class desktop window. Position it where you want it:

| Alignment | Description |
|-----------|-------------|
| `left`    | Left third of the screen |
| `right`   | Right third of the screen |
| `center`  | Centered, floating |
| `full`    | Full-width, classic layout |

Resize it freely alongside other windows.

### 🧩 Built-in Widgets
Six widgets ship out of the box, each opening as its own window:

| Widget | Description |
|--------|-------------|
| `notes.app` | Per-character sticky notes |
| `gallery.app` | Image gallery viewer |
| `clock.app` | Analog/digital clock |
| `status.app` | Character status fields (optional prompt injection) |
| `now.playing` | Music/media display |
| `quicklinks.app` | Configurable shortcut links |

### 🛠️ Custom Widget System
Build your own widgets with plain HTML, CSS, and JavaScript. Install from a local folder or import directly from a GitHub URL. Full access to the `DesktopWidget` API.

### 🎨 Color Presets
Three built-in accent themes, switchable at any time:

| Preset | Accent | Vibe |
|--------|--------|------|
| **Frost** | `#5ba4cf` | Cool blue-gray |
| **Rosé** | `#cf7b96` | Warm pink-mauve |
| **Moss** | `#7baf6b` | Green, earthy |

All visuals use `--fd-*` CSS variables, making it straightforward to create fully custom skins.

### ✨ Particle Effects
Ambient background effects with configurable density (`low` / `medium` / `high`) and layer (`behind` / `over`):

`fireflies` · `snow` · `rain` · `embers` · `stars` · `dust` · `petals`

### 👤 Avatar Customization
- Global avatar size (32–128 px) and shape
- Per-character overrides — right-click any avatar to swap its image or shape
- Shapes: `circle` · `rounded` · `square` · `hexagon`

### 🖼️ Custom Wallpapers
Use SillyTavern's existing background or set a custom URL. Control blur and dim levels independently.

### 📐 Layout Presets
Save and restore complete window arrangements. Optionally remember a different layout per character.

### 🌐 Localization
Full English and Russian (`EN` / `RU`) support from day one.

---

## Installation

Open SillyTavern, navigate to **Extensions → Install Extension**, and paste:

```
https://github.com/aceeenvw/fae.desktop
```

That's it. No manual file copying required.

---

## Requirements

- **SillyTavern** 1.12.0 or newer
- **Desktop browser** with a viewport of at least **1024 px wide**

> **Mobile is not supported.** If fae.desktop detects a viewport smaller than 1024 px, it will notify you and disable itself automatically.

---

## Quick Start

1. After installation, open **Extensions** in SillyTavern and find **fae.desktop**.
2. Toggle **Enable Desktop Mode** to activate the desktop environment.
3. The interface transforms — you'll see the menu bar at the top and dock at the bottom.
4. Drag widgets out of the dock to open them as windows.
5. Use the **menu bar → Preferences** (or the Extensions drawer) to configure colors, wallpaper, particles, and more.
6. Right-click any chat avatar to set per-character overrides.
7. Arrange your windows, then save the layout via **menu bar → Layouts → Save Layout**.

---

## Screenshots

*Screenshots coming soon.*

---

## Custom Widgets

Any folder containing a valid `widget.json` can be loaded as a fae.desktop widget.

### File Structure

```
my-widget/
├── widget.json      # required — metadata and configuration
├── content.html     # widget body HTML
├── style.css        # scoped styles (optional)
└── script.js        # widget logic (optional)
```

### widget.json Spec

```json
{
  "id": "my-widget",
  "name": "My Widget",
  "version": "1.0.0",
  "author": "you",
  "description": "What this widget does.",
  "defaultSize": { "width": 320, "height": 240 },
  "minSize":     { "width": 200, "height": 160 },
  "entry": "content.html"
}
```

### DesktopWidget API

Your `script.js` receives a `widget` context object:

```js
// Read and write persistent data
widget.getData()                   // returns saved data object
widget.setData(obj)                // persists data to settings

// Window control
widget.setTitle('New Title')
widget.resize(width, height)
widget.focus()

// Events
widget.on('open',  () => { /* widget became visible */ })
widget.on('close', () => { /* widget was closed     */ })
widget.on('char',  (char) => { /* active character changed */ })
```

### Installing a Custom Widget

- **Local:** place the widget folder inside `fae.desktop/widgets/` and reload.
- **Remote:** go to **Preferences → Widgets → Install from URL** and enter the GitHub repository URL.

---

## Slash Commands

| Command | Arguments | Description |
|---------|-----------|-------------|
| `/desktop` | `on` \| `off` | Toggle desktop mode |
| `/desktop-widget` | `<id>` `open` \| `close` | Open or close a widget |
| `/desktop-layout` | `save <name>` \| `load <name>` | Save or load a layout preset |
| `/desktop-align` | `left` \| `right` \| `center` \| `full` | Set chat window alignment |
| `/desktop-skin` | `frost` \| `rose` \| `moss` | Switch color preset |
| `/desktop-particles` | `<style>` \| `off` | Enable a particle effect or disable |
| `/desktop-wallpaper` | `<url>` | Set a custom wallpaper URL |

---

## Color Presets

### Frost
Cool, clinical blue-gray. Works well with dark neutral SillyTavern themes. Accent: `#5ba4cf`.

### Rosé
Warm pink-mauve. Pairs naturally with cozy or romantic character setups. Accent: `#cf7b96`.

### Moss
Muted green-earth. Calm and easy on the eyes for long sessions. Accent: `#7baf6b`.

All three presets only override the `--fd-accent` family of variables. The underlying macOS skin (`macos.css`) stays intact, so window chrome, titlebars, and dock appearance remain consistent across presets.

To create a fully custom skin, duplicate one of the preset files, modify any `--fd-*` variables you like, and load it from **Preferences → Appearance → Custom Skin**.

---

## Configuration

All settings are accessible from two places:

- **Menu bar → Preferences** — quick access while the desktop is active
- **SillyTavern Extensions drawer → fae.desktop** — full settings panel

### Key Settings Areas

| Section | What it controls |
|---------|-----------------|
| **Appearance** | Color preset, window opacity, custom CSS |
| **Dock** | Auto-hide, magnification, icon size |
| **Menu Bar** | Clock format, date display, character name, token counter |
| **Chat** | Alignment, avatar size and shape, compact mode |
| **Wallpaper** | Source, fit mode, blur, dim |
| **Particles** | Style, density, layer |
| **Layouts** | Save/load presets, per-character layout memory |
| **Widgets** | Manage installed widgets, install from URL |
| **Advanced** | Debug logging, API exposure, custom CSS injection |

---

## Compatibility

- Works with **any SillyTavern theme** — fae.desktop reads `--SmartTheme*` variables as fallbacks so accent colors and text colors stay coherent with your chosen theme.
- **Independent of other extensions** — does not integrate with or depend on CharacterStyleCustomizer, RPG Companion, or any other extension.
- Tested on SillyTavern 1.12.x. Chromium-based browsers recommended for best glassmorphism rendering.

---

## Credits

**Author:** [aceeenvw](https://github.com/aceeenvw)  
**License:** [AGPL-3.0](LICENSE)

---

*fae.desktop is a fan project and is not affiliated with the SillyTavern team.*

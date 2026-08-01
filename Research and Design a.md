# Research and Design a Semantic Linux Computer-Control Plugin for MastraCode

## Mission

Research and design a MastraCode plugin that allows an AI agent to inspect, understand, and interact with the Linux desktop at a high semantic level.

The plugin should let an agent reason about:

* Applications
* Windows
* Dialogs
* Menus
* Buttons
* Text fields
* Lists
* Tabs
* Browser content
* Notifications
* Focus
* Application state
* Desktop events and signals

The agent should interact with these concepts directly whenever possible.

For example, we want operations resembling:

```ts
listApplications()
listWindows()
focusWindow({ windowId })
inspectWindow({ windowId })
queryElements({
  windowId,
  role: "button",
  name: "Save"
})
invokeElement({
  elementId,
  action: "click"
})
setElementValue({
  elementId,
  value: "Hello world"
})
```

We do **not** want the primary interaction model to resemble:

```ts
takeScreenshot()
moveMouse({ x: 842, y: 517 })
clickMouse()
takeAnotherScreenshot()
guessWhatChanged()
```

Raw mouse movement, keyboard injection, OCR, and screenshot-based visual reasoning may still be necessary, but they must be treated as fallback mechanisms rather than the foundation of the system.

---

# Core Product Idea

Build an application-aware computer-control layer for MastraCode.

The plugin should act as an abstraction between the AI agent and the operating system. The model should express intent using stable, semantic operations while the plugin determines the best available mechanism for carrying out that intent.

The ideal interaction flow is:

```text
Agent intent
    ↓
Semantic computer-control API
    ↓
Application-specific integration, if available
    ↓
Linux accessibility APIs
    ↓
Desktop environment or compositor APIs
    ↓
Vision and OCR
    ↓
Raw mouse and keyboard input
```

Each lower layer should only be used when the higher layers cannot complete the operation reliably.

---

# Why This Is Different from Normal Computer-Use Agents

Most computer-use systems rely heavily on this loop:

1. Capture a screenshot.
2. Send the screenshot to the model.
3. Ask the model to identify a target.
4. Estimate coordinates.
5. Move the pointer.
6. Click.
7. Capture another screenshot.
8. Determine whether the click worked.
9. Repeat.

That approach has several weaknesses:

* It consumes many tokens.
* It requires repeated model round trips.
* It introduces visual ambiguity.
* It is sensitive to window size and layout changes.
* Coordinates become stale when content moves.
* Small targets are difficult to select reliably.
* Scrolling changes the coordinate system.
* Animations can cause timing failures.
* Visual verification is expensive.
* It cannot easily distinguish two visually similar controls.
* It has limited understanding of hidden, disabled, selected, expanded, or focused states.
* It often requires the model to rediscover the interface after every action.

This project should instead prefer structured information such as:

```json
{
  "id": "element-42",
  "role": "button",
  "name": "Save changes",
  "enabled": true,
  "visible": true,
  "focused": false,
  "actions": ["click"],
  "bounds": {
    "x": 901,
    "y": 642,
    "width": 128,
    "height": 34
  }
}
```

The agent should be able to call:

```json
{
  "elementId": "element-42",
  "action": "click"
}
```

The implementation may internally invoke an accessibility action, application API, keyboard shortcut, or physical pointer click. That implementation detail should normally remain hidden from the model.

---

# Primary Design Principle

## Semantic control first

The model should reason about meaningful objects and actions:

* Focus Firefox.
* Find the tab named GitHub.
* Locate the New Issue button.
* Read the current dialog.
* Enter text into the title field.
* Select an item from the repository dropdown.
* Invoke the Save action.
* Wait until the dialog closes.
* Report any validation errors.

It should not need to reason about screen coordinates unless no structured alternative exists.

---

# Research Before Implementation

Do not begin building the plugin immediately.

First, investigate the available Linux technologies, their limitations, permissions, desktop compatibility, maintenance status, and suitability for a TypeScript-based MastraCode plugin.

Produce a written research report and proposed architecture before writing production code.

Avoid choosing a library merely because it provides the fastest proof of concept. We need to understand the correct long-term architecture first.

---

# Required Research Areas

## 1. Linux Accessibility: AT-SPI2

Research AT-SPI2 in depth.

AT-SPI should be investigated as the likely primary interface for inspecting and interacting with application UI elements.

Determine:

* How applications expose accessibility trees through AT-SPI.
* How AT-SPI communicates over D-Bus.
* How to enumerate running applications.
* How to enumerate accessible windows.
* How to traverse accessible element trees.
* How to query elements by role, name, description, state, relationship, and action.
* How to invoke actions without moving the physical pointer.
* How to read and modify editable text.
* How to inspect selections, values, tables, documents, links, menus, and dialogs.
* How focus events are represented.
* How window and element changes can be observed.
* Whether accessible objects provide stable IDs.
* How long object references remain valid.
* What causes references to become stale.
* How Electron, GTK, Qt, Java, Chromium, Firefox, and other frameworks expose their interfaces.
* Which applications expose incomplete or unusable accessibility trees.
* Whether accessibility must be enabled through environment variables, desktop settings, browser flags, or application-specific options.
* Whether actions can be performed directly through AT-SPI or require synthesized input.
* Whether AT-SPI supports retrieving screen bounds for fallback targeting.
* How passwords and protected inputs are represented.
* Whether accessibility access creates meaningful security concerns.
* Whether AT-SPI behavior differs between X11 and Wayland.

Investigate the current official AT-SPI2 documentation, GNOME accessibility documentation, D-Bus interfaces, available language bindings, and maintained client libraries.

Determine whether the plugin should:

* Use an existing Node.js binding.
* Call AT-SPI through direct D-Bus messages.
* Build a small native Rust, C, C++, or Python bridge.
* Run a persistent local accessibility service accessed by the TypeScript plugin.
* Use another maintained accessibility automation library as an abstraction.

Do not assume Node.js libraries are reliable merely because they exist. Inspect maintenance status, issue history, API coverage, architecture support, and compatibility with current Linux distributions.

---

## 2. Browser Accessibility Through the Operating System

Research how Firefox, Chromium, Chrome, Electron, and other browsers expose:

* Browser chrome
* Tabs
* Address bars
* Toolbars
* Web-page content
* DOM-derived accessibility nodes
* ARIA roles
* Forms
* Buttons
* Links
* Menus
* Dialogs
* Live regions
* Embedded frames
* Shadow DOM content

Determine how much of a web page is visible through AT-SPI and how reliably semantic HTML and ARIA information are represented.

Research the limitations when:

* A website has poor accessibility.
* Controls are built from generic `div` elements.
* Content is rendered on a canvas.
* The application uses WebGL.
* Elements exist in closed shadow roots.
* Content is inside cross-origin frames.
* The browser virtualizes large lists.
* Nodes are removed and recreated frequently.
* Accessibility exposure is disabled or delayed.

The operating-system accessibility tree should be usable as the standard cross-application interface, including for browsers, but browser-specific integrations may provide a deeper and more reliable layer.

---

## 3. Browser-Specific Control

Research browser-native integrations including:

* Chrome DevTools Protocol
* Chromium remote debugging
* Chrome DevTools Accessibility domain
* Browser extensions
* Firefox Remote Protocol
* WebDriver
* Playwright
* Existing browser MCP servers
* Attachment to already-running browser sessions
* Browser profile and authentication implications

Determine whether the plugin can detect that the focused application is a supported browser and automatically offer a richer backend.

The architecture may resemble:

```text
Generic desktop window
    → AT-SPI backend

Chromium browser window
    → CDP backend when authorized
    → AT-SPI fallback

Firefox browser window
    → Firefox-specific backend when available
    → AT-SPI fallback
```

Do not automatically replace the user’s browser session with a new automated browser instance unless explicitly requested.

Research how to attach safely to an existing session and what configuration or security tradeoffs that requires.

Browser-specific control should still map into the same general semantic element model where practical.

For example:

```ts
interface SemanticElement {
  id: string
  backend: "at-spi" | "cdp" | "webdriver" | "vision"
  role: string
  name?: string
  description?: string
  value?: unknown
  states: string[]
  actions: string[]
  parentId?: string
  bounds?: Rectangle
}
```

---

## 4. Window and Application Management

Research how to reliably:

* List running graphical applications.
* List windows.
* Identify the owning process.
* Identify the executable and application ID.
* Read window titles.
* Determine which window is active.
* Focus a window.
* Raise a window.
* Minimize or restore a window.
* Move and resize windows.
* Detect dialogs and transient child windows.
* Detect workspace membership.
* Switch workspaces.
* Detect monitors and scaling.
* Distinguish multiple windows from the same application.
* Observe newly opened or closed windows.

Compare behavior and available APIs across:

* GNOME
* KDE Plasma
* Sway
* Hyprland
* Other wlroots compositors
* X11 window managers
* Wayland compositors

Research whether window management should use:

* AT-SPI
* D-Bus desktop APIs
* GNOME Shell interfaces or extensions
* KDE KWin scripting or D-Bus APIs
* wlroots foreign-toplevel protocols
* X11 EWMH
* `wmctrl`
* `xdotool`
* Compositor-specific IPC
* A desktop-specific adapter architecture

Do not assume that a single window-control implementation can work everywhere on Linux.

Develop a capability-detection strategy.

---

## 5. Wayland Security Model

Treat Wayland as a first-class target, not an afterthought.

Research:

* Why ordinary applications cannot globally inspect or inject input under Wayland.
* XDG Desktop Portal ScreenCast.
* XDG Desktop Portal RemoteDesktop.
* PipeWire-based screen capture.
* User consent dialogs.
* Session lifetime.
* Permission persistence.
* Keyboard and pointer device negotiation.
* Differences among portal backends.
* Desktop-specific portal behavior.
* Whether individual windows can be captured.
* Whether remote input can be targeted at a specific window.
* Whether portals can provide window metadata.
* How headless, SSH, nested compositor, and remote desktop environments behave.
* Whether a persistent agent session can reuse authorization.
* Whether input injection requires a visible user-granted session.
* What can and cannot be done without weakening desktop security.

The project must not silently bypass Wayland’s security design.

Clearly document any setup that requires:

* Elevated permissions
* Membership in special groups
* Access to `/dev/uinput`
* A compositor plugin
* A desktop extension
* A user-approved portal session
* Browser debugging flags
* Accessibility configuration

---

## 6. X11 Support

Research X11-specific capabilities and tools including:

* EWMH
* Xlib
* XTest
* `xdotool`
* `wmctrl`
* Window properties
* Active window discovery
* Input synthesis
* Screenshot capture
* Window geometry
* Process association

X11 may permit broader control than Wayland, but the architecture should not be built around insecure assumptions that only hold on X11.

X11 should be implemented as one backend, not as the universal definition of Linux desktop automation.

---

## 7. Screenshot and Screen-Capture Backends

Screenshots remain important for:

* Visual verification
* Applications with incomplete accessibility
* Canvas and WebGL applications
* Games
* Image editors
* Remote desktops
* Detecting visual errors
* Reading graphical content
* Understanding layout when semantic structure is insufficient

Research:

* PipeWire
* XDG ScreenCast portal
* Desktop screenshot portals
* X11 capture
* Per-window capture
* Region capture
* Multi-monitor support
* Fractional scaling
* HiDPI coordinates
* GPU-accelerated capture
* Capture latency
* Whether cursor inclusion can be controlled
* Whether a screenshot can be correlated with accessibility bounds

Design capture APIs that avoid sending full-resolution screenshots to the model unnecessarily.

Possible operations:

```ts
captureWindow({ windowId })
captureElement({ elementId })
captureRegion({ x, y, width, height })
captureScreen({ monitorId })
```

Prefer cropped, targeted visual context over full-desktop screenshots.

Investigate whether the plugin can annotate captured images with known semantic element IDs without forcing the model to rediscover every target visually.

---

## 8. Vision and OCR Fallback

Research vision and OCR as secondary mechanisms.

Possible technologies include:

* OpenCV
* Tesseract
* PaddleOCR
* Local vision-language models
* Template matching
* Feature matching
* Object detection
* Icon recognition
* Image segmentation
* Existing computer-use models

Determine:

* Which methods can run locally.
* Their latency and resource requirements.
* How OCR results can be aligned with screen coordinates.
* How confidence scores should be represented.
* How visual targets can be tracked across frames.
* How the plugin can avoid repeatedly processing an unchanged screen.
* How to detect screen changes before requesting further reasoning.
* How to crop only the relevant window or region.
* How vision results should be represented as temporary semantic elements.

Example:

```json
{
  "id": "vision-element-12",
  "backend": "vision",
  "role": "probable-button",
  "name": "Export",
  "confidence": 0.87,
  "bounds": {
    "x": 711,
    "y": 402,
    "width": 94,
    "height": 31
  },
  "actions": ["pointer-click"]
}
```

The model must be told when an element was found semantically versus inferred visually.

---

## 9. Raw Input Fallback

Research raw keyboard and pointer control, but treat it as the final fallback.

Potential technologies include:

* XTest
* `xdotool`
* `ydotool`
* `/dev/uinput`
* Linux input subsystem
* XDG RemoteDesktop portal
* Desktop-specific input APIs

Determine:

* Permission requirements.
* Wayland compatibility.
* X11 compatibility.
* Keyboard layout handling.
* Unicode input behavior.
* Multi-monitor coordinate handling.
* Fractional scaling behavior.
* Relative versus absolute pointer movement.
* Whether events are distinguishable from physical input.
* Whether application-level input grabs interfere.
* How to avoid clicking the wrong target if the screen changes.
* How to confirm the correct window is focused before injecting input.

Raw input actions should require stronger preconditions.

For example:

```ts
pointerClick({
  target: {
    windowId: "window-3",
    elementId: "vision-element-12"
  },
  expectedWindowRevision: 84
})
```

Before clicking, the plugin should verify that:

* The expected window is still active.
* Its geometry has not changed.
* The target is still visible.
* The screen or element revision has not materially changed.
* The coordinates still fall inside the intended window.

Avoid exposing unrestricted coordinate clicking as the easiest tool for the model to select.

---

# Layered Backend Strategy

Research and propose a backend architecture resembling the following.

## Tier 1: Application-native integrations

Use a native application protocol or API when available and authorized.

Examples:

* Chromium DevTools Protocol
* Firefox remote protocol
* LibreOffice UNO
* Application D-Bus APIs
* Media-player remote-control APIs
* Editor extension APIs
* Terminal control protocols
* Desktop-environment APIs

This tier may provide the richest state and most reliable actions.

## Tier 2: AT-SPI accessibility

Use the Linux accessibility tree to inspect semantic elements and invoke supported actions.

This should be the general-purpose default for native applications and potentially browser content.

## Tier 3: Desktop and compositor integrations

Use desktop-specific APIs to manage windows, workspaces, notifications, focus, monitors, and related shell-level operations.

## Tier 4: Vision and OCR

Use screenshots, OCR, and visual analysis when semantic interfaces are incomplete.

## Tier 5: Raw input

Use synthesized keyboard and pointer events only when no reliable structured action exists.

The plugin should select the highest available tier automatically, while exposing which backend was selected and why.

---

# Unified Semantic Model

Design a normalized model that can represent UI information from multiple backends without erasing useful backend-specific details.

Suggested core entities:

```ts
interface DesktopApplication {
  id: string
  name: string
  executable?: string
  processId?: number
  applicationId?: string
  backendCapabilities: string[]
  windows: string[]
}

interface DesktopWindow {
  id: string
  applicationId: string
  title?: string
  role?: string
  active: boolean
  focused: boolean
  minimized?: boolean
  workspaceId?: string
  monitorId?: string
  bounds?: Rectangle
  rootElementId?: string
  revision: number
}

interface SemanticElement {
  id: string
  backend: BackendType
  backendReference?: unknown
  windowId: string
  parentId?: string

  role: string
  name?: string
  description?: string
  value?: unknown

  states: ElementState[]
  actions: ElementAction[]
  relations?: ElementRelation[]

  bounds?: Rectangle
  children?: string[]

  stableKey?: string
  revision: number
  confidence: number
}

interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}
```

Research how much normalization is practical.

Do not force every backend into the lowest common denominator. Permit backend-specific metadata where it provides meaningful additional capability.

---

# Stable References and Revisions

A critical research question is how to create references that remain useful across tool calls.

We want the model to be able to:

1. Inspect a window.
2. Receive element IDs.
3. Select an element.
4. Perform several related actions without rediscovering the entire application after each step.

Investigate:

* AT-SPI object identity.
* D-Bus object paths.
* CDP backend node IDs.
* Accessibility node IDs.
* DOM node identity.
* Window identity.
* Process lifetime.
* Re-rendering behavior.
* Virtualized lists.
* Stale references.
* Application restarts.
* Navigation and page reloads.

Design an element registry that can:

* Map plugin-generated IDs to backend objects.
* Detect stale references.
* Re-resolve an element when possible.
* Assign revisions to windows and trees.
* Preserve references across non-destructive UI changes.
* Expire references safely.
* Return precise stale-reference errors.
* Avoid holding unlimited backend objects in memory.

Consider stable semantic fingerprints based on:

* Application
* Window
* Ancestry
* Role
* Accessible name
* Relationships
* Position among peers
* Application-specific identifiers
* DOM attributes where available

Never silently perform an action against a different element merely because it looks similar.

---

# Efficient Inspection

Do not dump enormous accessibility trees into the model context.

Research strategies for incremental and query-driven inspection.

Possible tools:

```ts
listApplications()
listWindows()

inspectWindow({
  windowId,
  depth: 2,
  includeRoles: ["dialog", "button", "textbox", "menu"]
})

queryElements({
  windowId,
  role: ["button", "menuitem"],
  name: {
    contains: "Save"
  },
  states: {
    enabled: true,
    visible: true
  },
  limit: 20
})

getElement({
  elementId,
  includeChildren: true,
  includeAncestors: true
})

getElementText({
  elementId,
  maxCharacters: 5000
})
```

The plugin should support focused retrieval rather than requiring the model to consume an entire desktop snapshot.

Investigate server-side filtering through AT-SPI Collection interfaces or equivalent backend capabilities so filtering does not require serializing the entire tree.

---

# State, Events, and Signals

The plugin should expose more than request-response tools.

Research event streams and signals for:

* Active window changed
* Focus changed
* Window opened
* Window closed
* Dialog appeared
* Element state changed
* Element value changed
* Selection changed
* Notification appeared
* Application launched
* Application exited
* Browser navigation occurred
* Download started or completed
* Accessibility tree changed
* Screen region changed
* Permission prompt appeared
* Operation completed
* Operation failed

Design an event subscription model that avoids flooding the agent.

Possible approach:

```ts
subscribeDesktopEvents({
  eventTypes: [
    "window.opened",
    "dialog.opened",
    "focus.changed",
    "notification.created"
  ],
  applicationIds: ["org.gnome.Nautilus"]
})
```

Events should be buffered and summarized by the plugin where appropriate.

The model should not receive thousands of low-level accessibility events when one meaningful event such as “Save As dialog opened” would suffice.

Research event coalescing, debounce windows, deduplication, and semantic event synthesis.

---

# Proposed High-Level Tool Surface

Research and refine a compact tool API.

Do not expose hundreds of narrowly scoped tools directly to the model if a smaller coherent API can represent the same operations.

Possible tool groups:

## Discovery

```ts
getDesktopCapabilities()
listApplications()
listWindows()
getActiveWindow()
```

## Inspection

```ts
inspectWindow()
queryElements()
getElement()
getElementText()
captureWindow()
captureElement()
```

## Window control

```ts
focusWindow()
closeWindow()
setWindowState()
moveWindow()
```

## Element interaction

```ts
invokeElement()
setElementValue()
selectElement()
expandElement()
collapseElement()
scrollElement()
focusElement()
```

## Keyboard operations

```ts
sendShortcut()
typeText()
pressKey()
```

Keyboard tools should preferably target a known window or element rather than whichever application happens to be focused.

## Waiting and synchronization

```ts
waitForElement()
waitForElementState()
waitForWindow()
waitForWindowClosed()
waitForText()
waitForDesktopIdle()
```

## Fallback operations

```ts
analyzeWindowVisually()
clickVisualTarget()
performRawInput()
```

Fallback tools should clearly indicate that they are less reliable and potentially more expensive.

---

# Prefer Actions Over Physical Gestures

When an accessibility element provides an action such as:

* Click
* Press
* Activate
* Toggle
* Expand
* Collapse
* Select
* Dismiss

invoke that action directly.

Do not physically move the pointer unless the action cannot be invoked semantically.

Likewise, when a text field supports an editable-text interface, set or insert its value directly when appropriate instead of clicking it and typing one character at a time.

However, investigate whether direct value mutation triggers the same validation, input, change, and application events as real input.

The action implementation may need policies such as:

```ts
setElementValue({
  elementId,
  value,
  inputMode: "auto"
})
```

Where `inputMode` may resolve to:

* `accessibility`
* `application-api`
* `keyboard`
* `clipboard`
* `auto`

The plugin should report which method it selected.

---

# Synchronization Instead of Blind Delays

Avoid arbitrary delays such as:

```ts
sleep(2000)
```

Research how to wait for observable state transitions:

* Element appeared.
* Dialog opened.
* Button became enabled.
* Progress bar reached completion.
* Window title changed.
* Browser navigation completed.
* Focus moved.
* Application became idle.
* Notification appeared.

Operations should be able to return completion conditions or expected state changes.

Example:

```ts
invokeElement({
  elementId: "save-button",
  action: "click",
  waitFor: {
    any: [
      {
        elementState: {
          elementId: "save-button",
          state: "disabled"
        }
      },
      {
        windowClosed: {
          windowId: "save-dialog"
        }
      },
      {
        elementAppeared: {
          role: "alert"
        }
      }
    ]
  },
  timeoutMs: 10000
})
```

Research how much of this can be implemented through events rather than polling.

---

# Context and Token Efficiency

Token efficiency is a primary project objective.

The plugin should reduce:

* Full-screen image submissions
* Repeated screenshots
* Huge accessibility-tree dumps
* Repeated rediscovery of unchanged interfaces
* Multiple tiny tool calls
* Model-driven polling
* Blind trial and error
* Coordinate guessing
* Repeated visual confirmation

Research and propose:

## Compact element representations

Return only fields useful for the current task.

## Tree snapshots with revisions

Allow the model to request changes since a previous revision.

```ts
inspectWindow({
  windowId,
  sinceRevision: 41
})
```

## Semantic diffs

Return:

```json
{
  "revision": 42,
  "changes": [
    {
      "type": "element-added",
      "element": {
        "id": "dialog-8",
        "role": "dialog",
        "name": "Confirm deletion"
      }
    }
  ]
}
```

rather than returning the whole tree again.

## Batched operations

Permit a safe series of deterministic operations in one call.

```ts
performActions({
  actions: [
    {
      "type": "set-value",
      "elementId": "title-field",
      "value": "Bug report"
    },
    {
      "type": "set-value",
      "elementId": "body-field",
      "value": "Steps to reproduce..."
    },
    {
      "type": "invoke",
      "elementId": "submit-button",
      "action": "click"
    }
  ],
  stopOnFailure: true
})
```

Do not allow unrestricted scripts from the model without examining the security implications.

## Server-side waiting

Let the plugin wait locally for an event instead of making the model repeatedly call inspection tools.

## Cached semantic state

Maintain a bounded local state representation so unchanged objects do not need to be serialized repeatedly.

---

# Capability Negotiation

The plugin should detect the current environment.

Research how to identify:

* X11 versus Wayland
* Desktop environment
* Window manager or compositor
* Portal backend
* AT-SPI availability
* Accessibility bus availability
* Screen-capture availability
* Remote-input availability
* `/dev/uinput` availability
* Browser debugging availability
* Installed application adapters
* Whether the session is graphical, remote, nested, or headless

Return a capability report such as:

```json
{
  "session": {
    "displayServer": "wayland",
    "desktopEnvironment": "gnome",
    "compositor": "mutter"
  },
  "capabilities": {
    "accessibilityInspection": true,
    "accessibilityActions": true,
    "windowListing": true,
    "windowFocus": true,
    "screenCapture": "requires-user-consent",
    "remoteInput": "requires-user-consent",
    "rawUinput": false,
    "browserCdp": false
  },
  "recommendedBackends": [
    "at-spi",
    "gnome",
    "xdg-portal"
  ]
}
```

Do not let missing optional capabilities make the entire plugin unusable.

---

# Application Adapters

Research whether the architecture should support optional application adapters.

An adapter could provide richer controls for a known application while preserving the generic interface.

Examples:

```ts
interface ApplicationAdapter {
  canHandle(application: DesktopApplication): Promise<boolean>
  getCapabilities(): Promise<AdapterCapabilities>
  inspectWindow(window: DesktopWindow): Promise<SemanticElementTree>
  invokeAction(request: SemanticAction): Promise<ActionResult>
}
```

Potential adapters may include:

* Chromium
* Firefox
* VS Code
* Electron applications
* GNOME Terminal
* KDE Konsole
* Nautilus
* Dolphin
* LibreOffice
* Media applications
* Desktop shell
* File chooser portals

Do not make application adapters mandatory for basic functionality.

---

# Security Model

This plugin could have control over nearly the entire user session. Treat security as a central design requirement.

Research and propose controls for:

* Explicit user consent
* Permission scopes
* Per-application allowlists
* Read-only mode
* Input-control mode
* Screen-capture mode
* Sensitive application blocking
* Password field handling
* Secret redaction
* Clipboard access
* Terminal access
* File chooser access
* Browser session access
* Financial and account actions
* Destructive operations
* Confirmation policies
* Audit logging
* Action replay
* Emergency stop
* Session expiration
* Local-only communication
* Plugin authentication
* Privilege separation

Consider permissions such as:

```json
{
  "inspectApplications": true,
  "inspectAccessibilityTrees": true,
  "captureScreen": "prompt",
  "controlPointer": "prompt",
  "controlKeyboard": "prompt",
  "accessClipboard": false,
  "interactWithPasswordFields": false,
  "allowedApplications": [
    "org.gnome.Nautilus",
    "code",
    "firefox"
  ]
}
```

The plugin should clearly differentiate:

* Observing
* Focusing
* Editing
* Activating
* Submitting
* Destructive actions

Never hide security limitations merely to create a smoother demo.

---

# Sensitive Content

Research how accessibility APIs represent:

* Password fields
* Browser password managers
* Authentication dialogs
* Payment forms
* Private notifications
* Secret tokens
* Terminal output
* Clipboard contents

Sensitive values should not automatically be returned to the model.

Design redaction and policy hooks before exposing unrestricted inspection.

---

# Auditability

Every action should produce a structured result.

Example:

```json
{
  "success": true,
  "requestedAction": {
    "type": "invoke",
    "elementId": "element-42",
    "action": "click"
  },
  "resolvedTarget": {
    "role": "button",
    "name": "Save"
  },
  "backend": "at-spi",
  "fallbacksUsed": [],
  "startedAt": "2026-07-31T23:00:00-04:00",
  "durationMs": 87,
  "observedEffects": [
    {
      "type": "window-closed",
      "windowId": "save-dialog"
    }
  ]
}
```

For fallback actions, include:

* Why the semantic action was unavailable.
* Which fallback was used.
* Confidence.
* Preconditions checked.
* Visual or state verification performed.
* Whether the result remains uncertain.

---

# Error Model

Design meaningful errors rather than generic failures.

Examples:

* `APPLICATION_NOT_FOUND`
* `WINDOW_NOT_FOUND`
* `ELEMENT_NOT_FOUND`
* `ELEMENT_REFERENCE_STALE`
* `ELEMENT_NOT_ACTIONABLE`
* `AMBIGUOUS_ELEMENT_MATCH`
* `WINDOW_NOT_FOCUSED`
* `WINDOW_REVISION_CHANGED`
* `ACCESSIBILITY_UNAVAILABLE`
* `ACCESSIBILITY_TREE_INCOMPLETE`
* `PORTAL_PERMISSION_DENIED`
* `SCREEN_CAPTURE_UNAVAILABLE`
* `INPUT_INJECTION_UNAVAILABLE`
* `BACKEND_NOT_SUPPORTED`
* `APPLICATION_BLOCKED_BY_POLICY`
* `SENSITIVE_ELEMENT_BLOCKED`
* `ACTION_TIMED_OUT`
* `ACTION_EFFECT_UNCONFIRMED`

An ambiguous match should return candidates rather than selecting one arbitrarily.

---

# MastraCode Integration

Research the MastraCode plugin architecture and determine the cleanest integration point.

Investigate:

* Plugin lifecycle
* Tool registration
* Dynamic tool registration
* Signals
* Hooks
* Background services
* Long-running subscriptions
* Cleanup
* Configuration
* Permissions
* Local IPC
* Tool result size
* Binary and image results
* Plugin installation
* Native dependencies
* Cross-distribution packaging

Determine whether the desktop-control engine should run:

* In the MastraCode process
* In a worker process
* As a local daemon
* As a native sidecar
* Through D-Bus
* Through a Unix domain socket
* Through local HTTP
* Through JSON-RPC
* Through another IPC mechanism

A sidecar may be preferable if:

* Native libraries are required.
* Persistent accessibility references must be maintained.
* Events must be observed continuously.
* Crashes should not terminate MastraCode.
* Different implementation languages are useful.
* Privileges need to be isolated.
* Desktop access must be separately authorized.

Evaluate this rather than assuming it.

---

# Language and Runtime Research

The user’s ecosystem is TypeScript, but the correct desktop-control implementation may require another language.

Compare:

## TypeScript or Node.js

* Integration simplicity
* Existing D-Bus libraries
* AT-SPI binding quality
* Native module complexity
* Event-loop suitability
* Packaging

## Rust

* Native Linux APIs
* D-Bus libraries
* Safety
* Performance
* Static or portable binaries
* Accessibility library availability
* PipeWire and portal bindings
* IPC service suitability

## Python

* Existing accessibility tooling
* `pyatspi`
* Rapid prototyping
* Packaging difficulties
* Runtime dependency
* Long-running service behavior

## C or C++

* Native AT-SPI support
* Best API coverage
* Build and packaging burden
* Memory-safety concerns

A mixed architecture is acceptable.

For example:

```text
MastraCode TypeScript plugin
    ↕ JSON-RPC over Unix socket
Rust or Python desktop-control service
    ↕
AT-SPI / D-Bus / portals / compositor APIs
```

Recommend the architecture based on evidence rather than language preference alone.

---

# Prototype Requirements

After completing the research and architecture proposal, create a narrow proof of concept.

The first prototype should prove semantic control, not broad feature coverage.

Suggested prototype workflow:

1. Detect the current desktop environment and display server.
2. Connect to AT-SPI.
3. List accessible applications.
4. List top-level windows.
5. Select a window.
6. Return a compact accessibility tree.
7. Query for buttons and editable fields.
8. Invoke a button action directly.
9. Set or enter text in a field.
10. Observe and report resulting accessibility events.
11. Demonstrate stale-reference handling.
12. Report which operations required a fallback.

Test against a small application matrix, such as:

* A GTK application
* A Qt application
* Firefox
* Chromium
* An Electron application

Do not build raw coordinate clicking first and then label it semantic automation.

The prototype succeeds only if at least some applications can be controlled through actual semantic UI objects.

---

# Evaluation Matrix

Create a compatibility matrix containing:

| Environment   | Inspect elements | Invoke actions | Edit text | Manage windows | Capture screen | Inject input | Notes |
| ------------- | ---------------: | -------------: | --------: | -------------: | -------------: | -----------: | ----- |
| GNOME Wayland |                  |                |           |                |                |              |       |
| KDE Wayland   |                  |                |           |                |                |              |       |
| Sway          |                  |                |           |                |                |              |       |
| GNOME X11     |                  |                |           |                |                |              |       |
| KDE X11       |                  |                |           |                |                |              |       |

Create an application matrix containing:

| Application type | Accessibility quality | Direct actions | Text editing | Browser/native adapter | Vision fallback needed |
| ---------------- | --------------------: | -------------: | -----------: | ---------------------: | ---------------------: |
| GTK              |                       |                |              |                        |                        |
| Qt               |                       |                |              |                        |                        |
| Chromium         |                       |                |              |                        |                        |
| Firefox          |                       |                |              |                        |                        |
| Electron         |                       |                |              |                        |                        |
| Java Swing       |                       |                |              |                        |                        |
| Canvas/WebGL     |                       |                |              |                        |                        |

Fill these tables with verified findings rather than assumptions.

---

# Benchmarking

Measure:

* Time to list applications.
* Time to inspect a window.
* Time to run an element query.
* Time to invoke an action.
* Accessibility event latency.
* Screenshot latency.
* OCR latency.
* Browser adapter latency.
* Result payload sizes.
* Number of model tool calls required for representative tasks.
* Tokens consumed by semantic control versus screenshot-driven control.
* Failure and recovery behavior.
* Memory use for cached trees and references.

Create at least one representative comparison:

```text
Task: Open a settings dialog and enable a checkbox.

Approach A:
Screenshot-driven coordinate control

Approach B:
Semantic accessibility control
```

Compare:

* Number of screenshots
* Number of model round trips
* Approximate tokens
* Latency
* Reliability
* Ability to detect errors
* Sensitivity to layout changes

---

# Important Questions the Research Must Answer

1. Is AT-SPI sufficiently reliable to serve as the default semantic backend?
2. Which application frameworks expose the best and worst accessibility data?
3. How much browser page content is available through OS-level accessibility?
4. When is CDP substantially better than AT-SPI?
5. Can the plugin attach to an existing browser securely and reliably?
6. How can windows be listed and focused across major Wayland desktops?
7. Which capabilities require compositor-specific adapters?
8. What user approvals are required by XDG portals?
9. Can screen capture and remote input share a portal session?
10. Can accessible elements be invoked without moving the physical pointer?
11. Can editable text be changed without synthesizing individual keystrokes?
12. How should stale element references be detected and recovered?
13. Can semantic tree changes be represented as compact diffs?
14. Which accessibility events are too noisy to expose directly?
15. What should remain a persistent local service?
16. Which implementation language provides the best AT-SPI coverage?
17. How should native dependencies be packaged for Linux distributions?
18. What operations are impossible or unreliable under Wayland?
19. What setup steps would users reasonably accept?
20. How should permissions and confirmation policies be represented?
21. How can sensitive values be kept out of model context?
22. How can the plugin avoid acting on the wrong window after focus changes?
23. How can visual fallback targets be anchored to semantic windows?
24. Which operations can be safely batched?
25. What is the smallest coherent tool surface for the model?

---

# Things We Explicitly Do Not Want

Do not design this as merely:

* A wrapper around `xdotool`
* A wrapper around `ydotool`
* A screenshot loop
* An OCR-only automation system
* A macro recorder
* A collection of coordinate-clicking tools
* A browser-only automation plugin
* A system that launches a separate disposable browser for every task
* A system that dumps the entire accessibility tree into every prompt
* A system requiring dozens of tool calls for simple interactions
* A system based entirely on application-specific hardcoded scripts
* A system that assumes all Linux desktops behave like GNOME
* A system that assumes X11 permissions exist under Wayland
* A system that silently asks for root access
* A system that bypasses user security expectations
* A system that reports success merely because an input event was sent
* A system that chooses arbitrary elements when a query is ambiguous
* A system whose first implementation makes the long-term architecture difficult to add later

Raw input is a useful escape hatch. It is not the product.

---

# Desired Deliverables

Before substantial implementation, produce the following files.

## `01-research-findings.md`

Include:

* Technology findings
* Primary-source references
* Maintenance status
* API capabilities
* Linux desktop differences
* Application compatibility
* Security constraints
* Unknowns
* Contradictory findings
* Experiments needed

## `02-architecture-proposal.md`

Include:

* System architecture
* Backend hierarchy
* Process boundaries
* IPC design
* Element model
* State management
* Event model
* Permission model
* Failure handling
* Fallback policy
* Packaging strategy
* Alternatives considered

## `03-tool-api-proposal.md`

Include:

* Proposed MastraCode tools
* Full schemas
* Example calls and results
* Tool grouping rationale
* Context-efficiency strategy
* Batched operation design
* Waiting and synchronization design
* Error schemas

## `04-security-model.md`

Include:

* Threat model
* Permissions
* Consent
* Sensitive data handling
* Confirmation policy
* Audit logging
* Emergency stop
* Privilege separation
* Browser-security considerations
* Wayland-security considerations

## `05-compatibility-matrix.md`

Include desktop, compositor, toolkit, application, browser, and display-server findings.

## `06-prototype-plan.md`

Include:

* Narrow prototype scope
* Milestones
* Experiments
* Test applications
* Success criteria
* Failure criteria
* Dependencies
* Risks

## `07-open-questions.md`

Track unresolved questions separately rather than hiding uncertainty inside the architecture proposal.

---

# Research Standards

Use primary sources wherever possible:

* Official specifications
* Official project documentation
* Upstream source repositories
* Maintainer discussions
* D-Bus interface definitions
* Protocol documentation
* Desktop-environment documentation
* Browser protocol documentation
* Reproducible experiments

Community articles may help identify leads, but do not treat them as authoritative when primary documentation exists.

For every important claim, record:

* Source
* Date or version
* Desktop environment
* Display server
* Application version
* Whether the claim was documented or experimentally verified

Do not report an API as generally available merely because one desktop environment implements it.

---

# Implementation Discipline

Once implementation begins:

* Keep backend interfaces modular.
* Persist research observations while working.
* Record failed approaches and why they failed.
* Add tests for every supported semantic action.
* Do not hide fallback usage.
* Avoid blocking the MastraCode process.
* Isolate native crashes.
* Bound caches and event queues.
* Use structured logs.
* Preserve diagnostic information.
* Validate tool inputs.
* Verify targets immediately before destructive actions.
* Prefer deterministic backend behavior over model reasoning.
* Do not make the model solve problems the plugin can solve locally.

When an operation fails, return enough structured information for recovery without requiring the agent to start the entire task again.

---

# Definition of Success

The project is successful when an agent can perform meaningful Linux desktop tasks primarily through semantic objects and actions.

A successful interaction should resemble:

```text
1. List windows.
2. Focus the Settings window.
3. Query for the “Dark Mode” switch.
4. Read its current state.
5. Toggle it through its supported action.
6. Observe the state change.
7. Return a verified result.
```

It should not require:

```text
1. Capture the entire desktop.
2. Analyze millions of pixels.
3. Estimate a coordinate.
4. Move the pointer.
5. Click.
6. Capture another full screenshot.
7. Ask the model whether anything changed.
8. Retry from a slightly different coordinate.
```

The final system should make direct structured interaction the normal path, visual reasoning the recovery path, and raw coordinate input the last resort.


Also I have added signal provider and processor support to mastracode i am using my branch on this computer with mcdf command. if you want to research how that works you can query the your memory for a bit of insight

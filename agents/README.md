# The agent layer

Empty on purpose. The runtime is not built here; this is the contract it will
have to satisfy, written down before anything exists so that the first thing
built here cannot quietly become something else.

## Two doors, not a corridor

The agent layer is a **client of the daemon, not a wall in front of it.**

There are two doors into this system and they are peers. The desktop door is
`comcon` — what is on the screen right now. The work door is the agent layer —
what agents are doing. A client may knock on either, or both, and it never has
to ask an agent for permission to see the desktop. A visualizer that draws
windows talks to comcon; a visualizer that draws agents talks here; one that
draws both opens both doors itself.

The failure this rules out is the corridor: an agent layer that owns the socket
and re-exports the desktop through itself. That shape makes every desktop
client depend on an agent runtime it does not need, and makes the agent the
authority on what the desktop is — which is exactly backwards, because the
desktop is a fact and the agent is an opinion about it.

## The agent layer holds no key

It asks for scope like any other client and is **refused like any other
client** (amendment A13, issue #7 — never give the key to the agent).

Being the layer agents run in buys no privilege. If an agent wants to type into
a window, its connection asks for `edit` scope through the same grant the
Mastra plugin uses, and the consent ceiling refuses it on the same terms. There
is no path by which running inside the agent layer widens what a request may
do. If that ever seems inconvenient, the inconvenience is the feature.

## Observable, or the visualizer cannot exist

Whatever lands here must be a **long-lived process that clients attach to** —
the same shape as the daemon, one level up. Not a library an agent imports, not
a function a client calls and waits on.

The reason is concrete: the point of an agent layer is that something can watch
agents work. A library has no address to attach to and no life between calls,
so anything wanting to show what agents are doing would have to be inside the
process doing them. A process with a socket can be observed by a page, a tray
widget, a phone, or nothing at all, without any of them changing it.

## Where the agent layer runs today

`client/` — the local hub. It boots a headless Mastra Code, mounts the desktop
plugin, and serves a chat page from one process, which makes it the de-facto
agent host and the reason this directory can stay empty without anything being
broken.

Moving that runtime here is not a file move. The hub's agent loop is entangled
with its HTTP surface, its credential store and its model-tier selection, and
splitting them means deciding which of those the agent layer owns and which
stay the hub's. That is its own issue, with its own argument to have; the
contract above is what it will have to satisfy when it is had.

## What would violate this contract

- A client that must go through the agent layer to reach the desktop.
- An agent-layer connection that receives scope another client would be refused.
- An agent runtime with no address — importable but not attachable.

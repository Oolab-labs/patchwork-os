# Why Patchwork OS Exists

## AI should work while you're away

The most useful thing a person on your team ever did was not answer a question. It was notice something you didn't, do something about it, and tell you later. A good assistant doesn't wait to be asked. A good colleague sees the email thread sliding off the rails and steps in before it does. A good ops engineer catches the failing build at 3 a.m. and has a fix ready by breakfast.

Today's AI assistants are stuck in the question-and-answer era. You open a chat window, you type, it replies, you close the window. That is a search engine with better manners. It is not a teammate. It cannot help you while you are at a soccer game, asleep, driving, or simply doing something else with your one life.

Patchwork OS is built on a different assumption: the interesting work happens when you are not looking. The AI's job is to watch, act, and report — not to wait.

## Sovereignty over your runtime

There is a reason the useful AIs today live inside somebody else's walls. Models are expensive. Plumbing is hard. It is easier to rent than to own. And once you rent, the landlord decides the rules: which model you can use, what it's allowed to see, where your data sleeps, whether your workflow survives next quarter's pricing change.

We think that trade is going to age badly. Your personal AI is going to know more about your life than your email client did — your calendar, your finances, your work, your relationships, the half-formed projects in your head. That knowledge should not be a hostage. It should be yours, on your machine, swappable, inspectable, deletable.

Patchwork OS runs on your hardware. Your API keys, your models, your recipes, your logs. If you want to use Claude today and a local Ollama model tomorrow, you flip a flag. If you want to read every decision the system ever made, the log is a plain file. If you want to leave, you take everything with you because it never left in the first place.

This is not a political stance. It is a practical one. Lock-in has a cost, and when the thing being locked in is your daily cognitive exhaust, the cost compounds.

## Recipes are the connective tissue

An agent that can do one thing well is a tool. A tool that can do a hundred things well is a platform. The question is what holds the hundred things together.

We think the answer is recipes: small, readable files — YAML, not code — that say what to watch for and what to do. "When a new email from my kid's school arrives, summarize it, flag anything time-sensitive, draft a reply in my voice, and wait for my approval before sending." "When CI fails on main, pull the logs, find the flake, quarantine it, open a PR." "When an invoice lands in my inbox, match it to an order, file it, reply with a thank-you."

Recipes are the connective tissue because they are the one layer a non-engineer can read, write, and share. A developer can build one and hand it to a parent. A small business owner can fork one from a friend. You can paste one into a forum post. They are the unit of trade for practical AI, the way Dockerfiles became the unit of trade for deployments.

Without a shared recipe format, every useful automation stays trapped in the head of the person who built it. With one, a community can compound its cleverness.

## Why local-first matters now

For most of the last decade, "local-first" sounded like a purity test — a preference for people who enjoyed configuring things. That is no longer the situation. Three things changed at once.

First, small open-weight models got good. A laptop can now run a model that two years ago needed a data center. The ceiling on what you can do offline is rising fast.

Second, the context an AI needs is already on your machine. Your files, your git history, your editor state, your terminal, your calendar, your screenshots. Shipping all of that to a remote server to get a useful answer is absurd — it is slower, leakier, and more expensive than doing the work in-place.

Third, the trust conversation changed. Companies that were happy to pipe everything to a vendor in 2023 are writing policies in 2026. Individuals feel it too. The instinct to keep the personal stuff personal has reasserted itself, and the tooling is finally catching up.

Patchwork OS is a bet that the next useful layer of software — the proactive, always-on, does-things-for-you layer — should be built the way the web was built: on open protocols, on your own machine by default, with the option to reach out to the cloud when you choose, not because you had no other option.

## What we're actually building

A single process on your laptop that:

- Watches the things you tell it to watch (files, inboxes, builds, tabs, calendars).
- Runs recipes against any model you configure — local or cloud.
- Routes anything risky to an approval dashboard on your phone.
- Logs everything in plain text so you can audit it.
- Ships as open source under MIT, forever.

The first version runs alongside a code editor because that is where we started and where the plumbing was best. The next versions move outward — into email, calendar, home, finance, the places where time actually leaks out of a day.

We are building it in public. If this is the kind of thing you wish existed, come help us build it.

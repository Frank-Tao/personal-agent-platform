---
name: store-availability
description: Use when you must find out whether an app is live on the App Store and in which countries (US, AU, CN or others), get its Apple ID and store URL, or write them down for marketing. Read-only: it uses Apple's public lookup, never App Store Connect.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [app-store, aso, availability, release]
    related_skills: [agent-lanes]
---

# Store availability

You have no App Store Connect access and must never ask for Frank's Apple login. Two sources, and you say which one an answer comes from:
- **Storefront lookup (you can run it):** is the app visible to customers in a country right now.
- **App Store Connect (Frank looks):** what is switched on for sale. This is the authority.

## 1. Check the storefronts (you)
From `~/codes/personal-agent-platform`:
```
npm run --silent store -- check --bundle <bundle id> --countries us,au,cn
npm run --silent store -- check --id <numeric Apple ID> --countries us,au,cn,gb --json
```
Defaults to US, AU and CN. Exit code 0 = every country serves the app, 1 = at least one does not, 2 = bad input.
It prints per country: available or not found, name, version, price, release date and the store URL.

How to read it:
- **available** means the storefront serves the app today. Quote the URL and Apple ID (the number after `id` in the URL).
- **not found** is not proof the app is unavailable: the lookup can lag a few hours after a release or a change. Re-run once after an hour before reporting a problem; then ask Frank to check App Store Connect (below).
- "Ready for Distribution" in App Store Connect does not guarantee a country is on. Always check the countries Frank names.
- In-app purchases, ratings and the Chinese-language listing are not shown by the lookup; do not claim them.
- Verify the page opens: `curl -sIL <url> | head -1` should say 200.

## 2. If a country is missing: ask Frank to check App Store Connect (he does the clicking)
1. App Store Connect → My Apps → the app → **General → App Information** → **Apple ID** under General Information (a number like 6829698460).
2. **Pricing and Availability** → **App Availability** → **Manage**.
3. Find the country (Australia, United States, China mainland) and check that its status is **Available**. Statuses are explained in Apple's "Manage app availability" help page.
4. China mainland needs extra requirements on Apple's side (for example ICP filing); if it is not Available there, say what Frank sees and do not guess the reason.
Never change availability yourself and never propose doing it without Frank.

## 3. Write it down
Record the result in the project's `docs/store-links.md` (the `store-url` task): Apple ID, bundle id, per-country status with the date and time you checked, and the URL. Say "checked by storefront lookup on <date>" so nobody mistakes it for the App Store Connect view.

## Do not
- Do not publish or announce anything because the check passed: marketing posts stay drafts until Frank approves.
- Do not infer availability from TestFlight or from a build being "Ready for Distribution".

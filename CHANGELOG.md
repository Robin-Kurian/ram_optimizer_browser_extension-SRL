# Stackroot Tab Saver 1.0.0 — Frozen group repair

Root cause: the worker explicitly refused to move discarded tabs from existing groups, trusted session-only group IDs, did not observe group membership/window/replacement changes, and skipped startup reconciliation when the maintenance alarm already existed.

Changed background.js to discover Frozen groups from browser state, restore original memberships, merge duplicate groups, check actual discarded/protected/active state, repair state on every worker start, and debounce event-driven reconciliation. Group repairs also run with the engine OFF without initiating automatic discards or reloading tabs. Existing monitoring and maintenance alarm remain unchanged; no new polling, dependencies or permissions were added.

Updated manifest.json and popup.html branding to Stackroot Tab Saver. Version remains 1.0.0. Existing logo, icons, popup styling and monitoring code are preserved.

Validation: run `node tests/frozen-groups.cjs` (15 dependency-free mocked API regression tests) and `node --check` on background.js and popup.js. Tests cover existing/browser-discarded tabs, shared groups, release, original/deleted groups, manual ungrouping, multiple windows, lost session state, protections, engine OFF, freeze success/failure, activation races, API errors, duplicate groups, last-tab removal, replacement and instant mode.

Manual Brave checks still required: load unpacked, freeze inactive tabs, select/reload frozen tabs, rapidly switch tabs, manually ungroup, move between windows, restart the service worker and extension, toggle engine/protections, and verify popup counters and native collapse/reload behavior. Automated tests simulate API behavior and do not establish actual Brave compatibility.

API reference: https://developer.chrome.com/docs/extensions/reference/api/tabGroups

## 2026-05-06 - Adding aria-label and aria-hidden to icon-only buttons
**Learning:** Found multiple instances where vanilla JS DOM creation for close/remove buttons ('×') lacked screen reader context or caused redundant readout.
**Action:** Always add `aria-label` for screen readers and `aria-hidden='true'` to visual-only icon characters like '×' when wrapping text in a button.

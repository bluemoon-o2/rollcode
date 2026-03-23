# Changelog

All notable changes to this project are documented in this file.

## [0.0.3] - 2026-03-23

- Upgraded TUI timeline from plain log-style rows to card-and-rail conversation flow.
- Added dynamic rail/title animations for active assistant/event/tool states.
- Added compact vs immersive timeline density toggle (`Ctrl+U`).
- Improved completed-run UX by moving terminal status display to the latest-message area instead of pinning it at the top.

## [0.0.2] - 2026-03-22

- Simplified worker/supervisor turn packets to keep execution prompts lighter.
- Shifted orchestration responsibility to runtime infra state/dispatch logic.
- Improved parallel lane policy and plan-completion gating in runtime.
- Added task-scoped memory recall for worker/supervisor turns with frontmatter `limit` enforcement during prompt injection.

## [0.0.1] - 2026-03-20

- Initial release with basic features and improvements.
- Focus on stability and performance.
- More features and enhancements to come in future releases.

# Changelog

## 1.0.0 (2026-10-24)


### Features

* add confirmed repository issue actions to incidents ([#12](https://github.com/chrisleekr/sre-platform/issues/12)) ([57145df](https://github.com/chrisleekr/sre-platform/commit/57145df4467274feb2b1f62370723b94d6601418))
* add evidence-based topology and scoped dependency history ([#9](https://github.com/chrisleekr/sre-platform/issues/9)) ([4cec882](https://github.com/chrisleekr/sre-platform/commit/4cec8823feed7999387cceda7903379feeed2513))
* **alerts:** move provider lifecycle intake into packages/alerts ([#25](https://github.com/chrisleekr/sre-platform/issues/25)) ([e0e2f60](https://github.com/chrisleekr/sre-platform/commit/e0e2f60746961fa84a0a2d05df4786c16cdcd0e7))
* classify tool failures, store tool audits unredacted, bump deps ([#50](https://github.com/chrisleekr/sre-platform/issues/50)) ([3463b5a](https://github.com/chrisleekr/sre-platform/commit/3463b5a80c78220a29202196361d1de35fcc6d29))
* **connectors:** add Argo CD browser links and resolve app namespace by name ([#38](https://github.com/chrisleekr/sre-platform/issues/38)) ([01987c4](https://github.com/chrisleekr/sre-platform/commit/01987c45263ee2761c58cff45386ed744f08f809))
* **connectors:** refuse secret-bearing reads instead of redacting output ([#47](https://github.com/chrisleekr/sre-platform/issues/47)) ([1b509ff](https://github.com/chrisleekr/sre-platform/commit/1b509ffb0b069a608465148fd46441a09af82f63))
* **dashboard:** add work queue, connector lifecycle and resolution UI ([#27](https://github.com/chrisleekr/sre-platform/issues/27)) ([f525b4b](https://github.com/chrisleekr/sre-platform/commit/f525b4be020d2336e1ea1048ad5e4cd1e8f2c133))
* **dashboard:** unify controls and enforce the design system ([#17](https://github.com/chrisleekr/sre-platform/issues/17)) ([ffccdf2](https://github.com/chrisleekr/sre-platform/commit/ffccdf2d6d2c3b807b4c7a3c9a2e93171edeb83d))
* **db:** add provider-clear resolution, recovery questions and topology coalescing ([#23](https://github.com/chrisleekr/sre-platform/issues/23)) ([103e3c2](https://github.com/chrisleekr/sre-platform/commit/103e3c2b2341535afd561ad5a45d2217507692bd))
* discover provider topology and read scoped source evidence ([#10](https://github.com/chrisleekr/sre-platform/issues/10)) ([a72e231](https://github.com/chrisleekr/sre-platform/commit/a72e23129c566d7137e5d2e5ba4482a90895c10d))
* explore topology evidence and manage scoped service mappings ([#11](https://github.com/chrisleekr/sre-platform/issues/11)) ([a4342a8](https://github.com/chrisleekr/sre-platform/commit/a4342a874ff575dfd3a06ee086534ddc17638a9b))
* keep unproven hypotheses and post findings as labelled lines with provider links ([#43](https://github.com/chrisleekr/sre-platform/issues/43)) ([7947e3b](https://github.com/chrisleekr/sre-platform/commit/7947e3b81403f29d9892073a6868ffc51ba484df))
* **learning:** record learnings as knowledge facts ([#51](https://github.com/chrisleekr/sre-platform/issues/51)) ([02b834a](https://github.com/chrisleekr/sre-platform/commit/02b834a392195dde874179be4bc5879beb757290))
* present incident briefs and evidence in one workspace ([#13](https://github.com/chrisleekr/sre-platform/issues/13)) ([717140e](https://github.com/chrisleekr/sre-platform/commit/717140ea4ad23434f92ec407e3ad018675a1056d))
* **triage-worker:** drain consumer loops on SIGTERM before exiting ([#39](https://github.com/chrisleekr/sre-platform/issues/39)) ([ea09dae](https://github.com/chrisleekr/sre-platform/commit/ea09daedd86c5fd7db4404f67923e8b4c10dce31))
* **triage-worker:** group Slack provider alerts from one channel burst into a cohort ([#41](https://github.com/chrisleekr/sre-platform/issues/41)) ([bf57352](https://github.com/chrisleekr/sre-platform/commit/bf573520dd7963b4ed3f9648824ef57b09c1e065))
* **triage-worker:** let responders request recovery verification in conversation ([#42](https://github.com/chrisleekr/sre-platform/issues/42)) ([07ed6a8](https://github.com/chrisleekr/sre-platform/commit/07ed6a884584e51b69002c17ceb92d936db58468))
* **triage-worker:** make Slack recovery advisory and add connector lifecycle to poll jobs ([#29](https://github.com/chrisleekr/sre-platform/issues/29)) ([34f2d4e](https://github.com/chrisleekr/sre-platform/commit/34f2d4eb0f2b69634fbb5e2115d9650f679510ee))
* **triage-worker:** repair structured output and split evidence review ([#26](https://github.com/chrisleekr/sre-platform/issues/26)) ([537e40a](https://github.com/chrisleekr/sre-platform/commit/537e40a7ad4b99539b7113b7a37b0fd9e958e0f7))
* **triage-worker:** start recovery verification when Slack reports cover every alert ([#40](https://github.com/chrisleekr/sre-platform/issues/40)) ([4b561e8](https://github.com/chrisleekr/sre-platform/commit/4b561e81f6e16c0e7516c8af7c45fd8783a07a45))


### Bug Fixes

* **connectors:** report TLS verdict from http_meta and withhold query from unverified peers ([#33](https://github.com/chrisleekr/sre-platform/issues/33)) ([d6af0ab](https://github.com/chrisleekr/sre-platform/commit/d6af0abed6aa0eec15fe5ee37246d9ac2cdb630c))
* enforce workspace access and recover missing ownership ([#8](https://github.com/chrisleekr/sre-platform/issues/8)) ([8a798c9](https://github.com/chrisleekr/sre-platform/commit/8a798c9d45f70d20471248e6acf093cf0d5ecc00))

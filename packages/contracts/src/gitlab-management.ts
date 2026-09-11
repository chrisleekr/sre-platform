/** Incrementing this version requires renewed administrator approval before any hook writes. */
export const GITLAB_HOOK_POLICY_VERSION = 1;

/** Only these event families are included in administrator-approved project hook management. */
export const GITLAB_MANAGED_HOOK_EVENTS = {
  push_events: true,
  tag_push_events: true,
  merge_requests_events: true,
  pipeline_events: true,
  job_events: true,
  deployment_events: true,
  releases_events: true,
  issues_events: false,
  confidential_issues_events: false,
  note_events: false,
  confidential_note_events: false,
  wiki_page_events: false,
};

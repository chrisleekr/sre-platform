// Postmortems and the RCA accuracy loop. Vocabulary and wire DTOs shared by the schema,
// the API, the worker and the dashboard so a value can never be legal on one side and unknown on
// another.

/** Google SRE Ch 15 postmortem triggers. Declared by the responder who commands generation. */
export const POSTMORTEM_TRIGGERS = [
  'user_visible_impact',
  'data_loss',
  'oncall_intervention',
  'slow_resolution',
  'monitoring_failure',
] as const;
export type PostmortemTrigger = (typeof POSTMORTEM_TRIGGERS)[number];

export const POSTMORTEM_STATUSES = ['draft', 'published'] as const;
export type PostmortemStatus = (typeof POSTMORTEM_STATUSES)[number];

/** Action item intent: stop it recurring, shrink its blast radius, or change how people work. */
export const ACTION_ITEM_TYPES = ['prevent', 'mitigate', 'process'] as const;
export type ActionItemType = (typeof ACTION_ITEM_TYPES)[number];

export const ACTION_ITEM_STATES = ['open', 'in_progress', 'done', 'wont_do'] as const;
export type ActionItemState = (typeof ACTION_ITEM_STATES)[number];

/** Terminal action item states; each carries a completion instant. */
export const ACTION_ITEM_TERMINAL_STATES: readonly ActionItemState[] = ['done', 'wont_do'];

/** Grade of one trusted assessment run against ground truth. */
export const ASSESSMENT_VERDICTS = ['correct', 'partial', 'incorrect'] as const;
export type AssessmentVerdict = (typeof ASSESSMENT_VERDICTS)[number];

/** What the model judge graded against. Only the judge sets it; a human verdict carries none. */
export const GROUND_TRUTH_SOURCES = ['postmortem'] as const;
export type GroundTruthSource = (typeof GROUND_TRUTH_SOURCES)[number];

export const CALIBRATION_VERDICTS = ['insufficient_data', 'informative', 'uninformative'] as const;
export type CalibrationVerdict = (typeof CALIBRATION_VERDICTS)[number];

/** Graded runs a bucket needs before an accuracy is reported instead of null. */
export const RCA_CALIBRATION_FLOOR = 10;

/** Claimed-confidence buckets, inclusive lower and exclusive upper bound (upper 101 closes the top). */
export const CONFIDENCE_BUCKETS: readonly { lower: number; upper: number }[] = [
  { lower: 0, upper: 50 },
  { lower: 50, upper: 80 },
  { lower: 80, upper: 101 },
];

/** Open action item age buckets in days, inclusive lower and exclusive upper (null is unbounded). */
export const ACTION_ITEM_AGE_BUCKETS: readonly {
  label: string;
  lower: number;
  upper: number | null;
}[] = [
  { label: 'under_7_days', lower: 0, upper: 7 },
  { label: '7_to_30_days', lower: 7, upper: 30 },
  { label: 'over_30_days', lower: 30, upper: null },
];

export interface PostmortemLessons {
  wentWell: string[];
  wentWrong: string[];
  lucky: string[];
}

/** Timeline `at` cap, shared by the generator schema and the PATCH validator so they cannot drift. */
export const POSTMORTEM_TIMELINE_AT_MAX_CHARS = 64;

export interface PostmortemTimelineEntry {
  at: string;
  event: string;
}

export interface ContributingCause {
  cause: string;
  evidenceIds: string[];
}

/** The editable prose sections of a postmortem. Every value is scrubbed before storage. */
export interface PostmortemSections {
  summary: string;
  impact: string;
  contributingCauses: ContributingCause[];
  triggerNarrative: string;
  resolution: string;
  detection: string;
  lessons: PostmortemLessons;
  timeline: PostmortemTimelineEntry[];
  supportingInformation: string | null;
}

export interface PostmortemDocument extends PostmortemSections {
  id: string;
  incidentId: string;
  status: PostmortemStatus;
  trigger: PostmortemTrigger;
  revision: number;
  assessmentRunId: string | null;
  requestedByUserId: string | null;
  publishedByUserId: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PostmortemActionItem {
  id: string;
  postmortemId: string;
  type: ActionItemType;
  title: string;
  /** Attribution, who to ask; free text so a team is as valid as a person. */
  owner: string | null;
  trackerUrl: string | null;
  state: ActionItemState;
  dueAt: string | null;
  completedAt: string | null;
  /** True for items the generator wrote; regeneration replaces only these. */
  generated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AssessmentGrade {
  id: string;
  incidentId: string;
  runId: string;
  claimedConfidence: number;
  runbookCited: boolean;
  modelVerdict: AssessmentVerdict | null;
  modelRationale: string | null;
  groundTruthSource: GroundTruthSource | null;
  humanVerdict: AssessmentVerdict | null;
  humanRationale: string | null;
  gradedByUserId: string | null;
  /** The human verdict when present, otherwise the model's. */
  effectiveVerdict: AssessmentVerdict;
  createdAt: string;
  updatedAt: string;
}

/** GET /incidents/:id/postmortem. */
export interface PostmortemDetail {
  postmortem: PostmortemDocument;
  actionItems: PostmortemActionItem[];
  /** The grade of the run pinned by the postmortem, once the judge or a human has graded it. */
  grade: AssessmentGrade | null;
}

export interface PostmortemActionItemAgeBucket {
  label: string;
  lowerDays: number;
  upperDays: number | null;
  open: number;
}

/** GET /reliability/postmortems. */
export interface PostmortemReport {
  asOf: string;
  postmortems: { draft: number; published: number };
  actionItems: {
    open: number;
    openByAge: PostmortemActionItemAgeBucket[];
    /** Open items missing an owner or a tracker link. Counted as defects, never hidden. */
    untracked: number;
    pastDue: number;
  };
  postmortemsWithPastDueItems: { incidentId: string; postmortemId: string; pastDue: number }[];
  definitions: string[];
}

export interface ConfidenceBucketReport {
  lower: number;
  upper: number;
  graded: number;
  /** Null below the reporting floor, never a rounded number over a handful of samples. */
  observedAccuracy: number | null;
  claimedMean: number | null;
}

export interface AccuracyCohort {
  graded: number;
  accuracy: number | null;
}

/** GET /reliability/rca-calibration. */
export interface RcaCalibrationReport {
  floor: number;
  coverage: { assessmentsWithConfidence: number; graded: number; gradedRate: number | null };
  overall: {
    graded: number;
    correct: number;
    partial: number;
    incorrect: number;
    accuracy: number | null;
  };
  byConfidenceBucket: ConfidenceBucketReport[];
  runbookAdoption: { cited: AccuracyCohort; uncited: AccuracyCohort };
  judgeAgreement: { bothGraded: number; agreed: number; rate: number | null };
  verdict: CalibrationVerdict;
  definitions: string[];
}
